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
  dateString: string;
  duration: number;
  organizerEmail: string;
  participants: string[];
  meetingAttendees: { email: string; displayName: string | null }[];
  meetingInfo: { fred_joined: boolean; silent_meeting: boolean };
}

async function fetchFirefliesTranscripts(apiKey: string, fromDate: string, toDate: string): Promise<FirefliesTranscript[]> {
  const query = `
    query {
      transcripts(fromDate: "${fromDate}", toDate: "${toDate}", limit: 50) {
        id
        title
        dateString
        duration
        organizerEmail
        participants
        meetingAttendees { email displayName }
        meetingInfo { fred_joined silent_meeting }
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
  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "FIREFLIES_API_KEY not set" }, { status: 500 });
  }

  const results = { showed: 0, noShow: 0, skipped: 0, errors: [] as string[] };

  // Get all pending demos from the last 2 weeks
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  const pendingDemos = await prisma.demo.findMany({
    where: {
      status: "pending",
      booking: { demoDate: { gte: twoWeeksAgo } },
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

  const transcripts = await fetchFirefliesTranscripts(apiKey, fromDate, toDate);

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
        const tDate = new Date(t.dateString);
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
        // Transcript found → showed
        await prisma.demo.update({
          where: { id: demo.id },
          data: {
            status: "showed",
            confirmedBy: "fireflies_auto",
            confirmedAt: new Date(),
            hasFirefliesRecording: true,
            firefliesTranscriptId: match.id,
          },
        });
        results.showed++;
      } else {
        // No transcript — only mark as no-show if demo time has passed by > 1 hour
        const now = new Date();
        const hourAfterDemo = new Date(demoDate.getTime() + 60 * 60 * 1000);

        if (now > hourAfterDemo) {
          await prisma.demo.update({
            where: { id: demo.id },
            data: {
              status: "no_show",
              confirmedBy: "fireflies_auto",
              confirmedAt: new Date(),
            },
          });
          results.noShow++;
        } else {
          results.skipped++; // Demo hasn't happened yet or just ended
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
