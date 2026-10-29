// Atomic claim for a bot send.
//
// The insert is the lock. claimKey and bodyDedupeKey are unique, so two
// overlapping calls cannot both land an open row. Rate and daily slots are
// taken in the same transaction and roll back when the insert loses.
// The global hourly slot is the same ConfirmationRateBucket confirmations use.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isUniqueConflict, uniqueTargetOf } from "@/lib/confirmations/claim-types";

export type BotClaimReason = "idempotency" | "body_dedupe" | "rate_cap" | "caller_rate_cap" | "recipient_daily_cap";

export type BotClaimResult = { ok: true; id: string } | { ok: false; reason: BotClaimReason };

export interface BotClaimInput {
  caller: string;
  idempotencyKey: string;
  channel: "direct" | "group";
  recipient: string;
  phone: string | null;
  groupId: string | null;
  bodyHash: string;
  mediaUrl: string | null;
  dryRun: boolean;
  claimKey: string;
  bodyDedupeKey: string;
  etDay: string;
  etDayStart: Date;
  etDayEnd: Date;
  windowStart: Date;
  hourBucket: string;
  callerBucket: string;
  globalLimit: number;
  callerLimit: number;
  dailyLimit: number;
}

export interface BotClaimTx {
  /** Held until the transaction ends so the body-window read sees a peer insert. */
  lockBody(input: BotClaimInput): Promise<void>;
  /** No-op for Postgres (the transaction commit releases the advisory lock). */
  unlockBody(input: BotClaimInput): Promise<void>;
  findIdempotent(input: BotClaimInput): Promise<boolean>;
  findBodyWindow(input: BotClaimInput): Promise<boolean>;
  /** Open confirmation sends to this recipient on this Eastern day. */
  confirmationCountToday(input: BotClaimInput): Promise<number>;
  /** False when today's bot claims plus confirmations are already at the cap. */
  takeDailySlot(input: BotClaimInput, room: number): Promise<boolean>;
  takeGlobalSlot(input: BotClaimInput): Promise<boolean>;
  takeCallerSlot(input: BotClaimInput): Promise<boolean>;
  insertQueued(input: BotClaimInput): Promise<{ id: string }>;
}

const OPEN = ["queued", "sent", "failed"] as const;

export class CapReject extends Error {
  readonly reason: BotClaimReason;
  constructor(reason: BotClaimReason) {
    super(reason);
    this.name = "CapReject";
    this.reason = reason;
  }
}

export async function claimBotInTx(tx: BotClaimTx, input: BotClaimInput): Promise<BotClaimResult> {
  await tx.lockBody(input);
  try {
    if (await tx.findIdempotent(input)) return { ok: false, reason: "idempotency" };
    if (await tx.findBodyWindow(input)) return { ok: false, reason: "body_dedupe" };
    const already = await tx.confirmationCountToday(input);
    const room = input.dailyLimit - already;
    // A failed slot take does not change the row. A later failure must throw
    // so the transaction rolls back slots that were already incremented.
    if (room < 1 || !(await tx.takeDailySlot(input, room))) {
      return { ok: false, reason: "recipient_daily_cap" };
    }
    if (!(await tx.takeGlobalSlot(input))) throw new CapReject("rate_cap");
    if (!(await tx.takeCallerSlot(input))) throw new CapReject("caller_rate_cap");
    const inserted = await tx.insertQueued(input);
    return { ok: true, id: inserted.id };
  } finally {
    await tx.unlockBody(input);
  }
}

export function reasonForBotConflict(target: string): BotClaimReason {
  if (target.toLowerCase().includes("body")) return "body_dedupe";
  return "idempotency";
}

function adapt(tx: Prisma.TransactionClient): BotClaimTx {
  return {
    async lockBody(input) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.recipient}), hashtext(${input.bodyHash}))`;
    },
    async unlockBody() {
      // pg_advisory_xact_lock releases on commit or rollback.
    },
    async findIdempotent(input) {
      const hit = await tx.botSend.findFirst({
        where: {
          claimKey: input.claimKey,
          status: { in: [...OPEN] },
        },
        select: { id: true },
      });
      return !!hit;
    },
    async findBodyWindow(input) {
      const botHit = await tx.botSend.findFirst({
        where: {
          recipient: input.recipient,
          bodyHash: input.bodyHash,
          dryRun: input.dryRun,
          status: { in: [...OPEN] },
          createdAt: { gte: input.windowStart },
        },
        select: { id: true },
      });
      if (botHit) return true;
      const phone = input.phone;
      const groupId = input.groupId;
      const identity = [
        ...(groupId ? [{ groupId }] : []),
        ...(phone ? [{ prospectPhone: { contains: phone } }] : []),
      ];
      if (identity.length === 0) return false;
      const confirmation = await tx.confirmationSend.findFirst({
        where: {
          dryRun: input.dryRun,
          bodyHash: input.bodyHash,
          status: { in: [...OPEN] },
          createdAt: { gte: input.windowStart },
          OR: identity,
        },
        select: { id: true },
      });
      return !!confirmation;
    },
    async confirmationCountToday(input) {
      const phone = input.phone;
      const groupId = input.groupId;
      const identity = [
        ...(groupId ? [{ groupId }] : []),
        ...(phone ? [{ prospectPhone: { contains: phone } }] : []),
      ];
      if (identity.length === 0) return 0;
      return tx.confirmationSend.count({
        where: {
          dryRun: input.dryRun,
          status: { in: [...OPEN] },
          AND: [
            { OR: identity },
            {
              OR: [
                { etDay: input.etDay },
                { etDay: null, createdAt: { gte: input.etDayStart, lt: input.etDayEnd } },
              ],
            },
          ],
        },
      });
    },
    async takeDailySlot(input, room) {
      if (room < 1) return false;
      const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "BotRecipientDay" ("recipientKey", "etDay", "dryRun", "count")
        VALUES (${input.recipient}, ${input.etDay}, ${input.dryRun}, 1)
        ON CONFLICT ("recipientKey", "etDay", "dryRun") DO UPDATE
        SET "count" = "BotRecipientDay"."count" + 1
        WHERE "BotRecipientDay"."count" < ${room}
        RETURNING "count"
      `;
      return rows.length > 0;
    },
    async takeGlobalSlot(input) {
      const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ConfirmationRateBucket" ("hourBucket", "dryRun", "count")
        VALUES (${input.hourBucket}, ${input.dryRun}, 1)
        ON CONFLICT ("hourBucket", "dryRun") DO UPDATE
        SET "count" = "ConfirmationRateBucket"."count" + 1
        WHERE "ConfirmationRateBucket"."count" < ${input.globalLimit}
        RETURNING "count"
      `;
      return rows.length > 0;
    },
    async takeCallerSlot(input) {
      const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ConfirmationRateBucket" ("hourBucket", "dryRun", "count")
        VALUES (${input.callerBucket}, ${input.dryRun}, 1)
        ON CONFLICT ("hourBucket", "dryRun") DO UPDATE
        SET "count" = "ConfirmationRateBucket"."count" + 1
        WHERE "ConfirmationRateBucket"."count" < ${input.callerLimit}
        RETURNING "count"
      `;
      return rows.length > 0;
    },
    async insertQueued(input) {
      const row = await tx.botSend.create({
        data: {
          caller: input.caller,
          idempotencyKey: input.idempotencyKey,
          channel: input.channel,
          recipient: input.recipient,
          phone: input.phone,
          groupId: input.groupId,
          bodyHash: input.bodyHash,
          mediaUrl: input.mediaUrl,
          dryRun: input.dryRun,
          claimKey: input.claimKey,
          bodyDedupeKey: input.bodyDedupeKey,
          etDay: input.etDay,
          status: "queued",
          reason: null,
          sentAt: null,
        },
      });
      return { id: row.id };
    },
  };
}

export async function claimBotWithPrisma(input: BotClaimInput): Promise<BotClaimResult> {
  try {
    return await prisma.$transaction((tx) => claimBotInTx(adapt(tx), input));
  } catch (err) {
    if (err instanceof CapReject) return { ok: false, reason: err.reason };
    if (isUniqueConflict(err)) return { ok: false, reason: reasonForBotConflict(uniqueTargetOf(err)) };
    throw err;
  }
}

export async function markBotSend(
  id: string,
  outcome: { status: "sent" | "failed"; dryRun: boolean; reason?: string; messageHandle?: string; error?: string }
): Promise<void> {
  await prisma.botSend.update({
    where: { id },
    data: {
      status: outcome.status,
      dryRun: outcome.dryRun,
      reason: outcome.reason ?? null,
      sendblueMessageId: outcome.messageHandle ?? null,
      error: outcome.error ?? null,
      sentAt: outcome.status === "sent" ? new Date() : null,
    },
  });
}

export async function logBotSkip(input: BotClaimInput, reason: string): Promise<void> {
  await prisma.botSend.create({
    data: {
      caller: input.caller,
      idempotencyKey: input.idempotencyKey,
      channel: input.channel,
      recipient: input.recipient,
      phone: input.phone,
      groupId: input.groupId,
      bodyHash: input.bodyHash,
      mediaUrl: input.mediaUrl,
      dryRun: input.dryRun,
      etDay: input.etDay,
      claimKey: null,
      bodyDedupeKey: null,
      status: "skipped",
      reason,
      sentAt: null,
    },
  });
}
