import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
  date: string;
  duration: number;
  organizer_email: string;
  participants: string[];
  cal_id: string | null;
}

async function fetchFirefliesTranscripts(apiKey: string, fromDate: string, toDate: string): Promise<FirefliesTranscript[]> {
  const query = `
    query {
      transcripts(fromDate: "${fromDate}", toDate: "${toDate}", limit: 50) {
        id
        title
        date
        duration
        organizer_email
        participants
        cal_id
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
        const tDate = new Date(t.date);
        const timeDiff = Math.abs(tDate.getTime() - demoDate.getTime());
        const withinWindow = timeDiff < 3 * 60 * 60 * 1000; // 3 hours

        if (!withinWindow) return false;
        if (t.duration < 2) return false; // Too short

        // Check email match
        const emailMatch = prospectEmail && t.participants.some(
          (p) => p.toLowerCase() === prospectEmail
        );

        // Check name match in title
        const nameParts = prospectName.split(/\s+/);
        const titleLower = t.title.toLowerCase();
        const nameMatch = nameParts.length > 0 && nameParts.some(
          (part) => part.length > 2 && titleLower.includes(part)
        );

        return emailMatch || nameMatch;
      });

      if (match) {
        // Transcript found — mark as showed + Fireflies verified
        const wasAlreadyConfirmed = demo.status === "showed";
        await prisma.demo.update({
          where: { id: demo.id },
          data: {
            status: "showed",
            // Only overwrite confirmedBy if it was pending
            ...(wasAlreadyConfirmed ? {} : { confirmedBy: "fireflies_auto", confirmedAt: new Date() }),
            hasFirefliesRecording: true,
            firefliesTranscriptId: match.id,
          },
        });
        results.showed++;
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
