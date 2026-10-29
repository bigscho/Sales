// Atomic claim for a confirmation send.
//
// The insert is the lock: claimKey, dayOfGroupDayKey, and bodyDedupeKey are
// unique, so two overlapping runs cannot both land an open row. A failed
// provider call marks that row failed and leaves the keys in place, so it
// is not sent again. Rate-cap and dedupe rejections insert nothing.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  isUniqueConflict,
  reasonForUniqueTarget,
  uniqueTargetOf,
  type ClaimInput,
  type ClaimResult,
  type ClaimRow,
} from "./claim-types";

export type { ClaimInput, ClaimResult, ClaimReason, ClaimRow, ClaimSnapshot } from "./claim-types";
export {
  priorClaimExists,
  bodyWindowHit,
  dayOfHit,
  uniqueConflictTarget,
  isOpenClaim,
  UniqueConflict,
  isUniqueConflict,
  reasonForUniqueTarget,
  uniqueTargetOf,
} from "./claim-types";

export interface ClaimTx {
  findPrior(input: ClaimInput): Promise<boolean>;
  /** Same group + same body inside the rolling window (and the legacy body-text fallback). */
  findBodyWindow(input: ClaimInput): Promise<boolean>;
  /** One day-of claim for this group on this Eastern day. */
  findDayOf(input: ClaimInput): Promise<boolean>;
  /** Atomically consume one slot. False when the hour is already at the cap. */
  takeRateSlot(input: ClaimInput): Promise<boolean>;
  /** Insert the queued claim. Throw a unique conflict if a key is taken. */
  insertQueued(input: ClaimInput): Promise<{ id: string }>;
}

/**
 * Read checks first, then one rate slot, then the unique insert.
 * A unique violation must propagate so the surrounding transaction rolls
 * the rate slot back. Callers map that error to a skip reason.
 */
export async function claimInTx(tx: ClaimTx, input: ClaimInput): Promise<ClaimResult> {
  if (await tx.findPrior(input)) return { ok: false, reason: "already_claimed" };
  if (await tx.findBodyWindow(input)) return { ok: false, reason: "body_dedupe" };
  if (input.touchpoint === "day_of" && (await tx.findDayOf(input))) return { ok: false, reason: "dayof_cap" };
  if (!(await tx.takeRateSlot(input))) return { ok: false, reason: "rate_cap" };
  const inserted = await tx.insertQueued(input);
  return { ok: true, id: inserted.id };
}

function adapt(tx: Prisma.TransactionClient): ClaimTx {
  const open = ["queued", "sent", "failed"] as const;
  return {
    async findPrior(input) {
      const hit = await tx.confirmationSend.findFirst({
        where: {
          bookingId: input.bookingId,
          touchpoint: input.touchpoint,
          dryRun: input.dryRun,
          reconnectId: input.reconnectId,
          status: { in: [...open] },
        },
        select: { id: true },
      });
      return !!hit;
    },
    async findBodyWindow(input) {
      // Held until this transaction ends, so the read below sees a peer's insert.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.groupId}), hashtext(${input.bodyHash}))`;
      const hit = await tx.confirmationSend.findFirst({
        where: {
          groupId: input.groupId,
          dryRun: input.dryRun,
          status: { in: [...open] },
          createdAt: { gte: input.windowStart },
          OR: [{ bodyHash: input.bodyHash }, { bodyHash: null, body: input.row.body }],
        },
        select: { id: true },
      });
      return !!hit;
    },
    async findDayOf(input) {
      const hit = await tx.confirmationSend.findFirst({
        where: {
          groupId: input.groupId,
          touchpoint: "day_of",
          dryRun: input.dryRun,
          status: { in: [...open] },
          OR: [
            { etDay: input.etDay },
            { etDay: null, createdAt: { gte: input.etDayStart, lt: input.etDayEnd } },
          ],
        },
        select: { id: true },
      });
      return !!hit;
    },
    async takeRateSlot(input) {
      const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ConfirmationRateBucket" ("hourBucket", "dryRun", "count")
        VALUES (${input.hourBucket}, ${input.dryRun}, 1)
        ON CONFLICT ("hourBucket", "dryRun") DO UPDATE
        SET "count" = "ConfirmationRateBucket"."count" + 1
        WHERE "ConfirmationRateBucket"."count" < ${input.rateLimit}
        RETURNING "count"
      `;
      return rows.length > 0;
    },
    async insertQueued(input) {
      const row = await tx.confirmationSend.create({
        data: {
          bookingId: input.row.bookingId,
          prospectEmail: input.row.prospectEmail,
          prospectPhone: input.row.prospectPhone,
          touchpoint: input.row.touchpoint,
          variant: input.row.variant,
          addressSource: input.row.addressSource,
          body: input.row.body,
          groupId: input.row.groupId,
          error: input.row.error,
          edited: input.row.edited,
          autoSent: input.row.autoSent,
          approvedBy: input.row.approvedBy,
          dryRun: input.row.dryRun,
          reconnectId: input.row.reconnectId,
          claimKey: input.row.claimKey,
          dayOfGroupDayKey: input.row.dayOfGroupDayKey,
          bodyDedupeKey: input.row.bodyDedupeKey,
          bodyHash: input.row.bodyHash,
          etDay: input.row.etDay,
          status: "queued",
          sentAt: null,
        },
      });
      return { id: row.id };
    },
  };
}

export async function claimWithPrisma(input: ClaimInput): Promise<ClaimResult> {
  try {
    return await prisma.$transaction((tx) => claimInTx(adapt(tx), input));
  } catch (err) {
    if (isUniqueConflict(err)) return { ok: false, reason: reasonForUniqueTarget(uniqueTargetOf(err)) };
    throw err;
  }
}

export async function markClaim(
  id: string,
  outcome: { status: "sent" | "failed"; dryRun: boolean; messageHandle?: string; error?: string }
): Promise<void> {
  // Keys stay. A failed row is not eligible to be claimed again.
  await prisma.confirmationSend.update({
    where: { id },
    data: {
      status: outcome.status,
      dryRun: outcome.dryRun,
      sendblueMessageId: outcome.messageHandle ?? null,
      error: outcome.error ?? null,
      sentAt: outcome.status === "sent" ? new Date() : null,
    },
  });
}

export async function logUnclaimed(row: ClaimRow & { error: string }): Promise<void> {
  await prisma.confirmationSend.create({
    data: {
      bookingId: row.bookingId,
      prospectEmail: row.prospectEmail,
      prospectPhone: row.prospectPhone,
      touchpoint: row.touchpoint,
      variant: row.variant,
      addressSource: row.addressSource,
      body: row.body,
      groupId: row.groupId,
      error: row.error,
      edited: row.edited,
      autoSent: row.autoSent,
      approvedBy: row.approvedBy,
      dryRun: row.dryRun,
      reconnectId: row.reconnectId,
      bodyHash: row.bodyHash,
      etDay: row.etDay,
      claimKey: null,
      dayOfGroupDayKey: null,
      bodyDedupeKey: null,
      status: "skipped",
      sentAt: null,
    },
  });
}
