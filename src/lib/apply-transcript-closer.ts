import { prisma } from "@/lib/db";
import {
  attributeCloserFromTranscript,
  CLOSER_SOURCE_MANUAL,
  decideCloserUpdate,
  isRecordingCloserName,
  type CloserDecision,
  type TranscriptForCloser,
} from "@/lib/closer-from-transcript";

const AUTOMATION_ACTORS = ["fireflies_sync", "fireflies_webhook", "closer_backfill"];

export type TranscriptCloserPlan = CloserDecision & {
  demoId: string;
  wrote: boolean;
};

/**
 * Set the demo's closer from the recording when one of Colin or Matthew ran it.
 * Ambiguous recordings leave closerId alone and flag closerReviewReason.
 * A manual reassignment (closerSource or a human closer_reassigned audit) is
 * never overwritten. A locked day is never rewritten; it is flagged instead.
 */
export async function applyTranscriptCloser(
  demoId: string,
  transcript: TranscriptForCloser,
  performedBy: string
): Promise<TranscriptCloserPlan | null> {
  const plan = await planTranscriptCloser(demoId, transcript);
  if (!plan) return null;

  const demo = await prisma.demo.findUnique({
    where: { id: demoId },
    include: { deal: { select: { id: true, closerId: true } } },
  });
  if (!demo) return null;

  const same =
    demo.closerId === plan.closerId &&
    (demo.closerSource ?? null) === plan.closerSource &&
    (demo.closerReviewReason ?? null) === plan.closerReviewReason &&
    (demo.detectedCloserId ?? null) === plan.detectedCloserId &&
    sharesEqual(demo.detectedCloserShare, plan.detectedCloserShare);
  if (same) return { ...plan, wrote: false };

  await prisma.demo.update({
    where: { id: demoId },
    data: {
      closerId: plan.closerId,
      closerSource: plan.closerSource,
      closerReviewReason: plan.closerReviewReason,
      detectedCloserId: plan.detectedCloserId,
      detectedCloserShare: plan.detectedCloserShare,
    },
  });

  await prisma.auditLog.create({
    data: {
      entityType: "demo",
      entityId: demoId,
      action: plan.changeCloser ? "closer_from_transcript" : "closer_review_flagged",
      oldValue: JSON.stringify({
        closerId: demo.closerId,
        closerSource: demo.closerSource,
        closerReviewReason: demo.closerReviewReason,
      }),
      newValue: JSON.stringify({
        closerId: plan.closerId,
        closerSource: plan.closerSource,
        closerReviewReason: plan.closerReviewReason,
        detectedCloserId: plan.detectedCloserId,
        detectedCloserShare: plan.detectedCloserShare,
      }),
      performedBy,
    },
  });

  if (plan.changeCloser && demo.deal && demo.deal.closerId !== plan.closerId) {
    await prisma.deal.update({
      where: { id: demo.deal.id },
      data: { closerId: plan.closerId },
    });
    await prisma.auditLog.create({
      data: {
        entityType: "deal",
        entityId: demo.deal.id,
        action: "closer_from_transcript",
        oldValue: JSON.stringify({ closerId: demo.deal.closerId }),
        newValue: JSON.stringify({ closerId: plan.closerId }),
        performedBy,
      },
    });
  }

  return { ...plan, wrote: true };
}

export async function planTranscriptCloser(
  demoId: string,
  transcript: TranscriptForCloser
): Promise<TranscriptCloserPlan | null> {
  const demo = await prisma.demo.findUnique({
    where: { id: demoId },
    select: {
      id: true,
      closerId: true,
      closerSource: true,
      weekId: true,
      booking: { select: { demoDate: true } },
    },
  });
  if (!demo) return null;

  const [closers, humanReassign, dayLocked] = await Promise.all([
    prisma.teamMember.findMany({
      where: { role: "closer", isActive: true },
      select: { id: true, name: true, email: true },
    }),
    prisma.auditLog.findFirst({
      where: {
        entityType: "demo",
        entityId: demoId,
        action: "closer_reassigned",
        NOT: { performedBy: { in: AUTOMATION_ACTORS } },
      },
      select: { id: true },
    }),
    dayIsLocked(demo.weekId, demo.booking.demoDate),
  ]);

  const attribution = attributeCloserFromTranscript(
    transcript,
    closers.filter((c) => isRecordingCloserName(c.name))
  );
  const decision = decideCloserUpdate({
    currentCloserId: demo.closerId,
    closerSource: demo.closerSource,
    humanReassigned: !!humanReassign || demo.closerSource === CLOSER_SOURCE_MANUAL,
    dayLocked,
    attribution,
  });
  return { demoId, ...decision, wrote: false };
}

async function dayIsLocked(weekId: string, demoDate: Date): Promise<boolean> {
  const dayStart = new Date(Date.UTC(demoDate.getUTCFullYear(), demoDate.getUTCMonth(), demoDate.getUTCDate()));
  const lock = await prisma.dayLock.findUnique({
    where: { weekId_date: { weekId, date: dayStart } },
    select: { id: true },
  });
  return !!lock;
}

function sharesEqual(a: number | null | undefined, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.0001;
}
