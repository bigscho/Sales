// Quiet-hours guard for prospect-facing confirmation texts (t1 + day_of).
//
// Rule: only send from 8:00 AM up to (not including) 8:00 PM in the PROSPECT's
// local time, i.e. local hours 8..19. Nothing goes out from 8 PM on.
//
// When the prospect timezone is missing, unparseable, or implausible for a US
// phone number (e.g. a US number paired with Europe/London, which renders as
// "GMT+1"), we do NOT trust it and use a conservative fallback window expressed
// in Eastern time:
//   11:00 AM ET (inclusive) .. 8:00 PM ET (exclusive)  => ET hours 11..19.
// That is inside 8 AM-8 PM in every contiguous-US zone (11 AM ET = 8 AM PT,
// 8 PM ET = 5 PM PT), including Arizona. Hawaii/Alaska are not covered by the
// fallback; a real Pacific/Honolulu or America/Anchorage zone from Calendly is
// trusted and uses the normal prospect-local window instead.

export const SEND_START_HOUR = 8; // local, inclusive
export const SEND_END_HOUR = 20; // local, exclusive (no sends from 8 PM on)

export const FALLBACK_START_ET = 11; // ET, inclusive
export const FALLBACK_END_ET = 20; // ET, exclusive (never past 8 PM Eastern)
export const FALLBACK_TZ = "America/New_York";

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 10-digit or +1 numbers = North America (Grassfed prospects are US agents). */
export function isNanpPhone(phone: string | null | undefined): boolean {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length === 10 || (d.length === 11 && d.startsWith("1"));
}

const NA_TZ = /^(America|US|Canada)\/|^Pacific\/Honolulu$/;

export interface ResolvedTz {
  tz: string;
  trusted: boolean; // false = we guessed (fallback ET + conservative window)
}

/**
 * Prospect tz = Calendly invitee tz, but a US/Canada phone paired with a
 * non-American zone (setter booked from abroad, VPN, bad default) is NOT
 * trusted - that is how "12:00 AM GMT+1" reached a US prospect.
 */
export function resolveProspectTz(
  timezone: string | null | undefined,
  phone?: string | null
): ResolvedTz {
  if (!isValidTimezone(timezone)) return { tz: FALLBACK_TZ, trusted: false };
  if (isNanpPhone(phone) && !NA_TZ.test(timezone)) return { tz: FALLBACK_TZ, trusted: false };
  return { tz: timezone, trusted: true };
}

export function hourIn(tz: string, at: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(at);
  return parseInt(h, 10) % 24; // some engines render midnight as "24"
}

/** True when `at` is inside the allowed send window for this resolved zone. */
export function isInWindow(tz: string, trusted: boolean, at: Date): boolean {
  if (trusted) {
    const h = hourIn(tz, at);
    return h >= SEND_START_HOUR && h < SEND_END_HOUR;
  }
  const h = hourIn(FALLBACK_TZ, at);
  return h >= FALLBACK_START_ET && h < FALLBACK_END_ET;
}

export interface WindowCheck {
  ok: boolean;
  tz: string;
  trusted: boolean;
  localHour: number;
  retryAt: Date; // now if ok, else the next whole UTC hour that is inside the window
}

export function checkSendWindow(
  timezone: string | null | undefined,
  phone?: string | null,
  now: Date = new Date()
): WindowCheck {
  const { tz, trusted } = resolveProspectTz(timezone, phone);
  const ok = isInWindow(tz, trusted, now);
  let retryAt = now;
  if (!ok) {
    // Next top-of-hour strictly after `now`, then step hourly until in window.
    // The day-of cron is `0 * * * *`, so this lines up with the next run.
    retryAt = new Date(Math.ceil((now.getTime() + 1) / 3_600_000) * 3_600_000);
    for (let i = 0; i < 48 && !isInWindow(tz, trusted, retryAt); i++) {
      retryAt = new Date(retryAt.getTime() + 3_600_000);
    }
  }
  return { ok, tz, trusted, localHour: hourIn(tz, now), retryAt };
}
