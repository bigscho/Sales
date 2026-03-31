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
        const wasAlreadyConfirmed = demo.status === "showed";
        await prisma.demo.update({
          where: { id: demo.id },
          data: {
            status: "showed",
            ...(wasAlreadyConfirmed ? {} : { confirmedBy: "fireflies_auto", confirmedAt: new Date() }),
            hasFirefliesRecording: true,
            firefliesTranscriptId: meetingId,
          },
        });

        await prisma.auditLog.create({
          data: {
            entityType: "demo",
            entityId: demo.id,
            action: "fireflies_webhook_showed",
            newValue: JSON.stringify({
              transcriptId: meetingId,
              title: transcript.title,
              duration: transcript.duration,
            }),
            performedBy: "fireflies_webhook",
          },
        });

        // Notify show rate channel
        if (!wasAlreadyConfirmed) {
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
