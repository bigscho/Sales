import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Fireflies webhook: fires when a transcription is completed.
// Payload: { meetingId, eventType, clientReferenceId }
// We fetch the transcript details, match to a pending demo, and auto-mark as showed.

const FIREFLIES_GQL = "https://api.fireflies.ai/graphql";

interface TranscriptData {
  id: string;
  title: string;
  date: number; // millisecond timestamp
  duration: number;
  organizer_email: string;
  participants: string[];
  speakers: { name: string; id: number }[];
  sentences: { text: string; speaker_id: number | null; speaker_name: string | null }[];
  meeting_info: { summary_status: string; silent_meeting: boolean } | null;
  summary: { short_summary: string; keywords: string[] } | null;
}

// Keywords that indicate a genuine Grassfed sales demo or business call.
const DEMO_RELEVANCE_TERMS = [
  "real estate", "realtor", "agent", "brokerage", "broker", "listing",
  "home", "property", "homeowner", "zip code", "mls",
  "grassfed", "grsfd", "cold email", "email campaign", "email marketing",
  "smartlead", "lead", "outreach", "campaign", "deliverability",
  "sender account", "response rate", "open rate",
  "demo", "onboarding", "platform", "pricing", "subscription",
  "marketing budget", "roi", "commission", "closing", "sales",
  "next steps", "follow up", "schedule", "calendar",
];

// Verify that a transcript represents a real two-party conversation,
// not just a closer sitting alone in a meeting room.
function verifyRealShow(t: TranscriptData, teamNames: string[]): boolean {
  const sentences = t.sentences || [];

  // Signal 1: Fireflies skipped summarization → no real conversation
  if (t.meeting_info?.summary_status === "skipped") return false;

  // Signal 2: Fireflies flagged it as silent
  if (t.meeting_info?.silent_meeting === true) return false;

  // Signal 3: Too few substantive sentences
  const substantiveSentences = sentences.filter(s => s.text.trim().length > 5);
  if (substantiveSentences.length < 6) return false;

  // Signal 4: Only one speaker — prospect never talked
  const speakerIds = new Set(sentences.map(s => s.speaker_id).filter(id => id !== null && id !== undefined));
  if (speakerIds.size < 2) return false;

  // Signal 5: Content relevance — is this actually about Grassfed's business?
  if (t.summary) {
    const summaryText = (t.summary.short_summary || "").toLowerCase();
    const keywords = (t.summary.keywords || []).map(k => k.toLowerCase());
    const allText = summaryText + " " + keywords.join(" ");

    const hasRelevantContent = DEMO_RELEVANCE_TERMS.some(term => allText.includes(term));
    if (!hasRelevantContent) return false;
  }

  // Signal 6: At least one speaker must NOT be an internal team member.
  // Catches closers chatting while waiting for a no-show prospect.
  const speakerNames = (t.speakers || []).map(s => s.name.toLowerCase());
  if (speakerNames.length > 0 && teamNames.length > 0) {
    const hasExternalSpeaker = speakerNames.some(name => {
      return !teamNames.some(teamName => {
        const parts = teamName.split(/\s+/);
        const nameParts = name.split(/\s+/);
        return name === teamName
          || (parts[0] && nameParts[0] && parts[0] === nameParts[0] && parts[0].length > 2);
      });
    });
    if (!hasExternalSpeaker) return false;
  }

  return true;
}

async function fetchTranscript(apiKey: string, meetingId: string): Promise<TranscriptData | null> {
  const query = `
    query {
      transcript(id: "${meetingId}") {
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

  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.transcript || null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { meetingId, eventType } = body;

    if (eventType !== "Transcription completed" || !meetingId) {
      return NextResponse.json({ received: true, action: "ignored" });
    }

    const apiKeyEnv = process.env.FIREFLIES_API_KEY;
    if (!apiKeyEnv) {
      return NextResponse.json({ error: "FIREFLIES_API_KEY not set" }, { status: 500 });
    }

    // Fetch full transcript details
    // Try each API key until one returns the transcript
    const apiKeys = apiKeyEnv.split(",").map((k) => k.trim()).filter(Boolean);
    let transcript: TranscriptData | null = null;
    for (const key of apiKeys) {
      transcript = await fetchTranscript(key, meetingId);
      if (transcript) break;
    }
    if (!transcript) {
      return NextResponse.json({ received: true, action: "transcript_not_found" });
    }

    // Skip if too short (< 2 min = probably not a real demo)
    if (transcript.duration < 2) {
      return NextResponse.json({ received: true, action: "too_short" });
    }

    const meetingDate = new Date(typeof transcript.date === "number" ? transcript.date : parseInt(transcript.date));
    const windowStart = new Date(meetingDate.getTime() - 3 * 60 * 60 * 1000);
    const windowEnd = new Date(meetingDate.getTime() + 3 * 60 * 60 * 1000);

    // Load team names for speaker cross-reference (Signal 6)
    const teamMembers = await prisma.teamMember.findMany({ select: { name: true } });
    const teamNames = teamMembers.map(m => m.name.toLowerCase());

    // Find matching demos (pending or already confirmed) that Fireflies hasn't verified yet
    const pendingDemos = await prisma.demo.findMany({
      where: {
        hasFirefliesRecording: false,
        status: { in: ["pending", "showed"] },
        booking: {
          demoDate: { gte: windowStart, lte: windowEnd },
        },
      },
      include: { booking: true },
    });

    const titleLower = transcript.title.toLowerCase();
    const participantEmails = transcript.participants.map((p) => p.toLowerCase());

    let matched = false;
    for (const demo of pendingDemos) {
      const prospectEmail = demo.booking.prospectEmail?.toLowerCase();
      const prospectName = demo.booking.prospectName.toLowerCase();
      const nameParts = prospectName.split(/\s+/);

      // Match by email
      const emailMatch = prospectEmail && participantEmails.includes(prospectEmail);

      // Match by name in title
      const nameMatch = nameParts.some(
        (part) => part.length > 2 && titleLower.includes(part)
      );

      if (emailMatch || nameMatch) {
        const isRealShow = verifyRealShow(transcript, teamNames);
        const wasAlreadyConfirmed = demo.status === "showed";

        await prisma.demo.update({
          where: { id: demo.id },
          data: {
            hasFirefliesRecording: true,
            firefliesTranscriptId: meetingId,
            // Only auto-mark showed if real two-party conversation
            ...(isRealShow && !wasAlreadyConfirmed
              ? { status: "showed", confirmedBy: "fireflies_auto", confirmedAt: new Date() }
              : {}),
            // Flag for manual review if transcript exists but no real conversation
            ...(!isRealShow && !wasAlreadyConfirmed
              ? { notes: [demo.notes, "transcript_no_conversation"].filter(Boolean).join(",") }
              : {}),
          },
        });

        await prisma.auditLog.create({
          data: {
            entityType: "demo",
            entityId: demo.id,
            action: isRealShow ? "fireflies_webhook_showed" : "fireflies_webhook_no_conversation",
            newValue: JSON.stringify({
              transcriptId: meetingId,
              title: transcript.title,
              duration: transcript.duration,
              isRealShow,
              sentenceCount: transcript.sentences?.length || 0,
              speakerCount: new Set(transcript.sentences?.map(s => s.speaker_id).filter(id => id !== null)).size,
              summaryStatus: transcript.meeting_info?.summary_status,
            }),
            performedBy: "fireflies_webhook",
          },
        });

        // Notify show rate channel only for real shows
        if (isRealShow && !wasAlreadyConfirmed) {
          try {
            const { sendShowNotification } = await import("@/lib/setter-game");
            await sendShowNotification(demo.booking.prospectName, demo.booking.setterId, null, "fireflies_webhook");
          } catch { /* show rate notification failed */ }
        }

        matched = true;
        break; // One transcript = one demo
      }
    }

    return NextResponse.json({
      received: true,
      action: matched ? "matched_showed" : "no_match",
      meetingId,
      title: transcript.title,
    });
  } catch (error) {
    console.error("Fireflies webhook error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", webhook: "fireflies" });
}
