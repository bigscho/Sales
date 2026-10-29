// Pure gates for confirmation sends: claim keys, caps, cron auth, and the
// auto-send flags. No database and no Sendblue calls.

import { createHash, timingSafeEqual } from "crypto";

export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Last 10 digits, or "" when the value is not a usable phone. */
export function optOutPhone(p: string | null | undefined): string {
  const digits = String(p ?? "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  return digits.slice(-10);
}

export function claimKeyFor(input: {
  bookingId: string;
  reconnectId?: string | null;
  touchpoint: string;
  dryRun: boolean;
}): string {
  const owner = input.reconnectId ? `reconnect:${input.reconnectId}` : `booking:${input.bookingId}`;
  return `${owner}:${input.touchpoint}:${input.dryRun ? "dry" : "live"}`;
}

export function dayOfGroupDayKeyFor(groupId: string, etDay: string, dryRun: boolean): string {
  return `${groupId}:${etDay}:${dryRun ? "dry" : "live"}`;
}

export function bodyDedupeKeyFor(groupId: string, hash: string, etDay: string, dryRun: boolean): string {
  return `${groupId}:${hash}:${etDay}:${dryRun ? "dry" : "live"}`;
}

/** YYYY-MM-DD in America/New_York. Parts are assembled so the order cannot flip. */
export function etDayString(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftCalendarDay(etDay: string, days: number): string {
  const [y, m, d] = etDay.split("-").map((n) => Number(n));
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** UTC instant of midnight at the start of this Eastern calendar day. */
function easternMidnightUtc(etDay: string): Date {
  const [y, m, d] = etDay.split("-").map((n) => Number(n));
  for (const hour of [4, 5]) {
    const start = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
    if (etDayString(start) !== etDay) continue;
    const clock = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(start);
    const hh = clock.find((p) => p.type === "hour")?.value;
    const mm = clock.find((p) => p.type === "minute")?.value;
    if ((hh === "00" || hh === "24") && mm === "00") return start;
  }
  return new Date(Date.UTC(y, m - 1, d, 5, 0, 0));
}

/** UTC hour bucket, `YYYY-MM-DDTHH`. The global cap counts inside one of these. */
export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

/**
 * UTC instants covering the Eastern calendar day `YYYY-MM-DD`.
 * Used so legacy rows (no etDay column value yet) still count toward the cap.
 */
export function etDayWindow(etDay: string): { start: Date; end: Date } {
  // End is the next Eastern midnight, not start+24h. Fall-back days are 25h
  // and spring-forward days are 23h; a fixed 24h window misses or overlaps an hour.
  return {
    start: easternMidnightUtc(etDay),
    end: easternMidnightUtc(shiftCalendarDay(etDay, 1)),
  };
}

type EnvLike = { [key: string]: string | undefined };

export function maxSendsPerHour(env: EnvLike = process.env): number {
  const raw = env.CONFIRMATIONS_MAX_SENDS_PER_HOUR;
  const n = raw == null || raw === "" ? 30 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.floor(n);
}

export function dedupeWindowMs(env: EnvLike = process.env): number {
  const raw = env.CONFIRMATIONS_DEDUPE_WINDOW_HOURS;
  const n = raw == null || raw === "" ? 24 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 24 * 60 * 60 * 1000;
  return Math.floor(n) * 60 * 60 * 1000;
}

/** Hourly day-of cron sends only when this is exactly "true". Default off. */
export function dayOfAutoEnabled(env: EnvLike = process.env): boolean {
  return env.CONFIRMATIONS_DAYOF_AUTO === "true";
}

/** T-1 cron sends only when this is exactly "true". Default off. */
export function t1AutoEnabled(env: EnvLike = process.env): boolean {
  return env.CONFIRMATIONS_AUTO_SEND === "true";
}

/** Origination texts only when this is exactly "true". Default off. */
export function originationTextingEnabled(env: EnvLike = process.env): boolean {
  return env.CONFIRMATIONS_ORIGINATION_LIVE === "true";
}

const EXACT_OPT_OUT = new Set([
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "opt out",
  "opt-out",
]);

/** True for a STOP-style inbound. Does not match the word inside a longer sentence. */
export function isOptOutText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase().replace(/[.!]+$/g, "").trim();
  if (!t) return false;
  if (EXACT_OPT_OUT.has(t)) return true;
  if (t.length > 80) return false;
  return (
    t.includes("no more texts") ||
    t.includes("stop texting") ||
    t.includes("don't text") ||
    t.includes("dont text") ||
    t.includes("do not text") ||
    t.includes("unsubscribe")
  );
}

export interface OptOutIdentity {
  phone: string;
  groupId: string;
  reason: string;
  source: string;
}

export function inboundOptOutIdentity(input: {
  content?: string | null;
  optedOut?: boolean;
  fromNumber?: string | null;
  groupId?: string | null;
}): OptOutIdentity | null {
  const phone = optOutPhone(input.fromNumber);
  const groupId = input.groupId?.trim() || "";
  if (!phone && !groupId) return null;
  if (input.optedOut) {
    return { phone, groupId, reason: "opted_out", source: "sendblue_flag" };
  }
  if (isOptOutText(input.content)) {
    return { phone, groupId, reason: "stop", source: "sendblue_inbound" };
  }
  return null;
}

export type CronAuth =
  | { ok: true }
  | { ok: false; status: 401 | 405; error: "method_not_allowed" | "unauthorized" | "cron_secret_unconfigured" };

function safeEqual(a: string, b: string): boolean {
  // Hash first so the compare is fixed-length. timingSafeEqual throws (and
  // the early length return leaks) when the raw strings differ in length.
  const ah = createHash("sha256").update(a, "utf8").digest();
  const bh = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ah, bh);
}

function bearerMatches(
  request: { headers: { get(name: string): string | null } },
  secret: string | undefined
): CronAuth {
  if (!secret) {
    return { ok: false, status: 401, error: "cron_secret_unconfigured" };
  }
  const header = request.headers.get("authorization")?.trim() ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix) || !safeEqual(header.slice(prefix.length), secret)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

/**
 * Vercel cron style: `Authorization: Bearer $CRON_SECRET`.
 * GET and HEAD are always rejected — a link preview must not send texts.
 * Missing CRON_SECRET fails closed.
 */
export function authorizeCron(
  request: { method?: string; headers: { get(name: string): string | null } },
  secret: string | undefined = process.env.CRON_SECRET
): CronAuth {
  const method = (request.method || "").toUpperCase();
  if (method !== "POST") {
    return { ok: false, status: 405, error: "method_not_allowed" };
  }
  return bearerMatches(request, secret);
}

/**
 * Scheduler auth that also allows GET. Vercel Cron calls GET and, when
 * CRON_SECRET is set, sends `Authorization: Bearer $CRON_SECRET`.
 * A link preview does not send that header. Missing secret fails closed.
 * Day-of and T-1 do not use this — their GET handlers never send.
 */
export function authorizeScheduler(
  request: { method?: string; headers: { get(name: string): string | null } },
  secret: string | undefined = process.env.CRON_SECRET
): CronAuth {
  const method = (request.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return { ok: false, status: 405, error: "method_not_allowed" };
  }
  return bearerMatches(request, secret);
}
