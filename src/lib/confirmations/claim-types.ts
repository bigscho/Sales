// Shared claim shapes. Kept free of Prisma so tests can run the same decision
// function the database transaction runs.

export type ClaimReason = "already_claimed" | "body_dedupe" | "dayof_cap" | "rate_cap";

export type ClaimResult = { ok: true; id: string } | { ok: false; reason: ClaimReason };

/** Fields written on a ConfirmationSend row. Unique keys are null for skips. */
export interface ClaimRow {
  bookingId: string;
  prospectEmail: string | null;
  prospectPhone: string | null;
  touchpoint: string;
  variant: string | null;
  addressSource: string | null;
  body: string;
  groupId: string | null;
  error: string | null;
  edited: boolean;
  autoSent: boolean;
  approvedBy: string | null;
  dryRun: boolean;
  reconnectId: string | null;
  claimKey: string | null;
  dayOfGroupDayKey: string | null;
  bodyDedupeKey: string | null;
  bodyHash: string | null;
  etDay: string | null;
}

export interface ClaimInput {
  bookingId: string;
  touchpoint: string;
  dryRun: boolean;
  reconnectId: string | null;
  groupId: string;
  bodyHash: string;
  etDay: string;
  etDayStart: Date;
  etDayEnd: Date;
  hourBucket: string;
  rateLimit: number;
  windowStart: Date;
  now: Date;
  row: ClaimRow;
}

export interface ClaimSnapshot {
  bookingId: string;
  touchpoint: string;
  dryRun: boolean;
  reconnectId: string | null;
  status: string;
  groupId: string | null;
  bodyHash: string | null;
  body: string;
  etDay: string | null;
  createdAt: Date;
  claimKey: string | null;
  dayOfGroupDayKey: string | null;
  bodyDedupeKey: string | null;
}

const OPEN = new Set(["queued", "sent", "failed"]);

export function isOpenClaim(status: string): boolean {
  return OPEN.has(status);
}

export function priorClaimExists(rows: ClaimSnapshot[], input: ClaimInput): boolean {
  return rows.some(
    (r) =>
      isOpenClaim(r.status) &&
      r.bookingId === input.bookingId &&
      r.touchpoint === input.touchpoint &&
      r.dryRun === input.dryRun &&
      (r.reconnectId ?? null) === (input.reconnectId ?? null)
  );
}

export function bodyWindowHit(rows: ClaimSnapshot[], input: ClaimInput): boolean {
  return rows.some(
    (r) =>
      isOpenClaim(r.status) &&
      r.groupId === input.groupId &&
      r.dryRun === input.dryRun &&
      r.createdAt >= input.windowStart &&
      (r.bodyHash === input.bodyHash || (r.bodyHash == null && r.body === input.row.body))
  );
}

export function dayOfHit(rows: ClaimSnapshot[], input: ClaimInput): boolean {
  return rows.some(
    (r) =>
      isOpenClaim(r.status) &&
      r.groupId === input.groupId &&
      r.touchpoint === "day_of" &&
      r.dryRun === input.dryRun &&
      (r.etDay === input.etDay ||
        (r.etDay == null && r.createdAt >= input.etDayStart && r.createdAt < input.etDayEnd))
  );
}

/** Which unique key the new row would collide with, or null. */
export function uniqueConflictTarget(rows: ClaimSnapshot[], row: ClaimRow): string | null {
  if (row.claimKey && rows.some((r) => r.claimKey === row.claimKey)) return "claimKey";
  if (row.dayOfGroupDayKey && rows.some((r) => r.dayOfGroupDayKey === row.dayOfGroupDayKey)) return "dayOfGroupDayKey";
  if (row.bodyDedupeKey && rows.some((r) => r.bodyDedupeKey === row.bodyDedupeKey)) return "bodyDedupeKey";
  return null;
}

export class UniqueConflict extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`unique_conflict:${target}`);
    this.name = "UniqueConflict";
    this.target = target;
  }
}

export function isUniqueConflict(err: unknown): boolean {
  if (err instanceof UniqueConflict) return true;
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
}

export function uniqueTargetOf(err: unknown): string {
  if (err instanceof UniqueConflict) return err.target;
  if (typeof err === "object" && err !== null && "meta" in err) {
    const target = (err as { meta?: { target?: unknown } }).meta?.target;
    if (Array.isArray(target)) return target.join(",");
    if (typeof target === "string") return target;
  }
  return "";
}

export function reasonForUniqueTarget(target: string): ClaimReason {
  const t = target.toLowerCase();
  if (t.includes("dayof")) return "dayof_cap";
  if (t.includes("body")) return "body_dedupe";
  return "already_claimed";
}
