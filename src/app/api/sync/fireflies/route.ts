import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { applyTranscriptCloser } from "@/lib/apply-transcript-closer";
import type { TranscriptForCloser } from "@/lib/closer-from-transcript";

// Syncs Fireflies transcripts with demo records to auto-detect show/no-show.
// Logic:
// - If a Fireflies transcript exists for a demo's time slot with matching
//   attendee email or prospect name, and duration > 2 min → mark as "showed"
// - If a demo's scheduled time has passed and no matching transcript → mark as "no_show"
// - Only processes demos with status "pending"
//
// Requires FIREFLIES_API_KEY env var (or uses the MCP connection)

const FIREFLIES_GQL = "https://api.fireflies.ai/graphql";

interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // millisecond timestamp
  duration: number;
  organizer_email: string;
  participants: string[];
  speakers: { name: string; id: number }[];
  sentences: { text: string; speaker_id: number | null; speaker_name: string | null; start_time?: number | null; end_time?: number | null }[];
  meeting_info: { summary_status: string; silent_meeting: boolean } | null;
  summary: { short_summary: string; keywords: string[] } | null;
}

// Keywords that indicate a genuine Grassfed sales demo or business call.
// At least one must appear in the summary or keywords for auto-confirmation.
const DEMO_RELEVANCE_TERMS = [
  // Product/service terms
  "real estate", "realtor", "agent", "brokerage", "broker", "listing",
  "home", "property", "homeowner", "zip code", "mls",
  // Grassfed-specific
  "grassfed", "grsfd", "cold email", "email campaign", "email marketing",
  "smartlead", "lead", "outreach", "campaign", "deliverability",
  "sender account", "response rate", "open rate",
  // Sales demo flow
  "demo", "onboarding", "platform", "pricing", "subscription",
  "marketing budget", "roi", "commission", "closing", "sales",
  // Follow-up signals
  "next steps", "follow up", "schedule", "calendar",
];

async function fetchFirefliesTranscripts(apiKey: string, fromDate: string, toDate: string): Promise<FirefliesTranscript[]> {
  // Fireflies uses millisecond timestamps for date fields
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime();
  const query = `
    query {
      transcripts(fromDate: ${fromMs}, toDate: ${toMs}, limit: 50) {
        id
        title
        date
        duration
        organizer_email
        participants
        speakers {
          name
          id
        }
        sentences {
          text
          speaker_id
          speaker_name
          start_time
          end_time
        }
        meeting_info {
          summary_status
          silent_meeting
        }
        summary {
          short_summary
          keywords
        }
      }
    }
  `;

  const res = await fetch(FIREFLIES_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data?.data?.transcripts || [];
}

// Verify that a transcript represents a real two-party conversation,
// not just a closer sitting alone in a meeting room.
// teamNames: lowercase names of internal team members to exclude.
function verifyRealShow(t: FirefliesTranscript, teamNames: string[]): boolean {
  const sentences = t.sentences || [];

  // Signal 1: Fireflies skipped summarization → no real conversation
  if (t.meeting_info?.summary_status === "skipped") return false;

  // Signal 2: Fireflies flagged it as silent
  if (t.meeting_info?.silent_meeting === true) return false;

  // Signal 3: Too few sentences — a real demo has back-and-forth
  // (filtering out trivial sentences like "It." "Okay." "Uh.")
  const substantiveSentences = sentences.filter(s => s.text.trim().length > 5);
  if (substantiveSentences.length < 6) return false;

  // Signal 4: Only one speaker (or no speaker labels at all)
  // Fireflies assigns speaker_id to distinguish speakers.
  // If all sentences have the same speaker, the prospect never talked.
  const speakerIds = new Set(sentences.map(s => s.speaker_id).filter(id => id !== null && id !== undefined));
  if (speakerIds.size < 2) return false;

  // Signal 5: Content relevance — is this actually about Grassfed's business?
  // Catches cases where audio from TV/reels/podcasts creates a fake transcript.
  // Check summary text + keywords for business-relevant terms.
  if (t.summary) {
    const summaryText = (t.summary.short_summary || "").toLowerCase();
    const keywords = (t.summary.keywords || []).map(k => k.toLowerCase());
    const allText = summaryText + " " + keywords.join(" ");

    const hasRelevantContent = DEMO_RELEVANCE_TERMS.some(term => allText.includes(term));
    if (!hasRelevantContent) return false;
  }

  // Signal 6: At least one speaker must NOT be an internal team member.
  // Catches cases where closers chat with each other while waiting for a no-show prospect.
  // Fireflies labels speakers by name (e.g. "Colin Schofield", "Mark Whittelsey").
  const speakerNames = (t.speakers || []).map(s => s.name.toLowerCase());
  if (speakerNames.length > 0 && teamNames.length > 0) {
    const hasExternalSpeaker = speakerNames.some(name => {
      // Check if this speaker name matches any team member (first name, last name, or full name)
      return !teamNames.some(teamName => {
        const parts = teamName.split(/\s+/);
        const nameParts = name.split(/\s+/);
        // Match if full name matches, or if first name matches (for single-name speakers)
        return name === teamName
          || (parts[0] && nameParts[0] && parts[0] === nameParts[0] && parts[0].length > 2);
      });
    });
    if (!hasExternalSpeaker) return false;
  }

  return true;
}

// GET handler for Vercel cron
export async function GET() {
  return POST();
}

export async function POST() {
  // Support multiple API keys (comma-separated) for team coverage
  // e.g. FIREFLIES_API_KEY=colin_key,mark_key
  const apiKeyEnv = process.env.FIREFLIES_API_KEY;
  if (!apiKeyEnv) {
    return NextResponse.json({ error: "FIREFLIES_API_KEY not set" }, { status: 500 });
  }
  const apiKeys = apiKeyEnv.split(",").map((k) => k.trim()).filter(Boolean);

  const results = { showed: 0, noShow: 0, skipped: 0, errors: [] as string[] };

  // Load all team member names for speaker cross-reference (Signal 6)
  const teamMembers = await prisma.teamMember.findMany({ select: { name: true } });
  const teamNames = teamMembers.map(m => m.name.toLowerCase());

  // Get all demos from the last 2 weeks that Fireflies hasn't verified yet
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  const pendingDemos = await prisma.demo.findMany({
    where: {
      hasFirefliesRecording: false,
      booking: { demoDate: { gte: twoWeeksAgo } },
      status: { in: ["pending", "showed"] },
    },
    include: {
      booking: { include: { setter: true } },
      closer: true,
    },
  });

  if (pendingDemos.length === 0) {
    return NextResponse.json({ success: true, message: "No pending demos to check", results });
  }

  // Fetch Fireflies transcripts for the relevant date range
  const earliestDemo = pendingDemos.reduce((min, d) =>
    new Date(d.booking.demoDate) < min ? new Date(d.booking.demoDate) : min,
    new Date()
  );
  const fromDate = new Date(earliestDemo.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Fetch transcripts from all API keys and deduplicate by ID
  const allTranscripts: FirefliesTranscript[] = [];
  const seenIds = new Set<string>();
  for (const key of apiKeys) {
    const batch = await fetchFirefliesTranscripts(key, fromDate, toDate);
    for (const t of batch) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        allTranscripts.push(t);
      }
    }
  }
  const transcripts = allTranscripts;

  for (const demo of pendingDemos) {
    try {
      const demoDate = new Date(demo.booking.demoDate);
      const prospectEmail = demo.booking.prospectEmail?.toLowerCase();
      const prospectName = demo.booking.prospectName.toLowerCase();

      // Find matching transcript:
      // 1. Same day (within 3 hours of scheduled time)
      // 2. Attendee email matches prospect email, OR title contains prospect name
      // 3. Duration > 2 minutes (not a false join)
      const match = transcripts.find((t) => {
        const tDate = new Date(typeof t.date === "number" ? t.date : parseInt(t.date));
        const timeDiff = Math.abs(tDate.getTime() - demoDate.getTime());
        const withinWindow = timeDiff < 3 * 60 * 60 * 1000; // 3 hours

        if (!withinWindow) return false;
        // Short recordings still match so the closer can be flagged for review.
        // They are not auto-marked showed (see below).
        if (typeof t.duration === "number" && t.duration < 0) return false;

        // Check email match
        const emailMatch = prospectEmail && t.participants.some(
          (p) => p.toLowerCase() === prospectEmail
        );

        // Check name match against the title's prospect portion ("Prospect and
        // Closer"). Use WHOLE-WORD tokens, not substrings, and require BOTH the
        // first and last name — a substring match let "Jan Norris" hijack the
        // "Janice Pruss" transcript ("jan" ⊂ "janice"), mis-linking the demo.
        const andMatch = t.title.match(/^(.+?)\s+and\s+/i);
        const titleProspect = (andMatch ? andMatch[1] : t.title).toLowerCase();
        const titleTokens = new Set(titleProspect.split(/[^a-z0-9]+/).filter(Boolean));
        const prospectTokens = prospectName.split(/[^a-z0-9]+/).filter((tok) => tok.length > 1);
        const firstTok = prospectTokens[0];
        const lastTok = prospectTokens[prospectTokens.length - 1];
        const nameMatch = prospectTokens.length > 0
          && !!lastTok && titleTokens.has(lastTok)
          && (prospectTokens.length < 2 || (!!firstTok && titleTokens.has(firstTok)));

        return emailMatch || nameMatch;
      });

      if (match) {
        // Credit the closer from who spoke. Ambiguous recordings leave the
        // current closer in place and set closerReviewReason.
        await applyTranscriptCloser(demo.id, transcriptForCloser(match), "fireflies_sync");

        const tooShortToShow = typeof match.duration === "number" && match.duration <= 1;
        const isRealShow = !tooShortToShow && verifyRealShow(match, teamNames);
        const wasAlreadyConfirmed = demo.status === "showed";
        await prisma.demo.update({
          where: { id: demo.id },
          data: {
            hasFirefliesRecording: true,
            firefliesTranscriptId: match.id,
            ...(isRealShow && !wasAlreadyConfirmed
              ? { status: "showed", confirmedBy: "fireflies_auto", confirmedAt: new Date() }
              : {}),
            ...(!isRealShow && !wasAlreadyConfirmed
              ? { notes: [demo.notes, "transcript_no_conversation"].filter(Boolean).join(",") }
              : {}),
          },
        });

        results.showed += isRealShow ? 1 : 0;
        results.skipped += isRealShow ? 0 : 1;
      } else {
        // No transcript — leave as pending, but flag "no transcript" if demo time passed
        const now = new Date();
        const hourAfterDemo = new Date(demoDate.getTime() + 60 * 60 * 1000);

        if (now > hourAfterDemo && !demo.notes?.includes("no_transcript")) {
          // Add a note so the UI can show "No Fireflies transcript" badge
          await prisma.demo.update({
            where: { id: demo.id },
            data: {
              notes: [demo.notes, "no_transcript"].filter(Boolean).join(","),
            },
          });
          results.noShow++; // counted as "flagged", not actually marked no-show
        } else {
          results.skipped++;
        }
      }
    } catch (e) {
      results.errors.push(String(e).slice(0, 100));
    }
  }

  // Recordings already linked (including ones still on a provisional calendar
  // closer) get the same credit pass. applyTranscriptCloser is a no-op when
  // the stored credit already matches.
  try {
    const linked = await prisma.demo.findMany({
      where: {
        firefliesTranscriptId: { not: null },
        booking: { demoDate: { gte: twoWeeksAgo } },
        OR: [{ closerSource: null }, { closerSource: "calendar" }],
      },
      select: { id: true, firefliesTranscriptId: true },
    });
    for (const d of linked) {
      const t = transcripts.find((tr) => tr.id === d.firefliesTranscriptId);
      if (!t) continue;
      await applyTranscriptCloser(d.id, transcriptForCloser(t), "fireflies_sync");
    }
  } catch { /* closer credit on already-linked demos is best-effort */ }

  // Log sync
  await prisma.syncLog.create({
    data: {
      source: "fireflies",
      syncType: "show_rate_check",
      status: "success",
      recordsSynced: results.showed + results.noShow,
      completedAt: new Date(),
    },
  });

  return NextResponse.json({
    success: true,
    message: `Fireflies sync: ${results.showed} showed, ${results.noShow} no-show, ${results.skipped} skipped (upcoming)`,
    results,
    transcriptsChecked: transcripts.length,
    pendingDemosChecked: pendingDemos.length,
  });
}

function transcriptForCloser(t: FirefliesTranscript): TranscriptForCloser {
  return {
    duration: t.duration,
    organizer_email: t.organizer_email,
    participants: t.participants,
    speakers: t.speakers,
    sentences: t.sentences,
    meeting_info: t.meeting_info,
  };
}
