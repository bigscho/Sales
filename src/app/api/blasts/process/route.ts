import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { processBlast } from "@/lib/ghl";

// POST /api/blasts/process — cron job to process pending/scheduled blasts
// Runs every 15 minutes via Vercel Cron
export async function POST() {
  const now = new Date();

  // Find blasts that need processing:
  // 1. Scheduled blasts whose time has come
  // 2. Pending blasts (immediate sends that haven't started)
  // 3. Processing blasts (partially completed, hit warm-up limit)
  const blasts = await prisma.textBlast.findMany({
    where: {
      OR: [
        { status: "scheduled", scheduledFor: { lte: now } },
        { status: "pending" },
        { status: "processing" },
      ],
    },
    orderBy: { createdAt: "asc" },
  });

  const results: Array<{ blastId: string; status: string; error?: string }> = [];

  for (const blast of blasts) {
    try {
      await processBlast(blast.id);
      const updated = await prisma.textBlast.findUnique({ where: { id: blast.id } });
      results.push({ blastId: blast.id, status: updated?.status || "unknown" });
    } catch (err) {
      results.push({ blastId: blast.id, status: "error", error: (err as Error).message });
    }
  }

  return NextResponse.json({
    processed: results.length,
    results,
  });
}
