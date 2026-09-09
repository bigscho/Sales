// Origination reply — the line answers the setter's first text in a brand-new
// group within seconds: "Thanks Jake, talk Tuesday John. Definitely check out
// the FAQ^!" (the ^ points up at the setter's handoff text, which carries the
// FAQ link — we send text only).
//
// Matching is two-tier:
//  - PHONE match (group participant == booking prospectPhone): full
//    personalized copy. This is the same match T-1/day-of rely on.
//  - TIME match fallback: the setter creates the group within minutes of the
//    booking landing, so a brand-new group + exactly ONE brand-new unclaimed
//    booking inside ±30 min = almost certainly the same prospect. Sends the
//    GENERIC copy (no names — a wrong name would sit visibly contradicted in
//    the thread) and is used for this greeting ONLY: it never writes the
//    group<->booking link, so T-1/day-of still require the phone match.
//    Zero or 2+ candidates -> silence.
//
// Triggered ONLY by the SendBlue inbound webhook, never by polling: a group
// that surfaces late (daily poll sync) would get a weird hours-late reply, so
// anything past the freshness window stays silent. The webhook fires on EVERY
// inbound message, so this must be idempotent — the ConfirmationSend log is
// the retrigger guard.
//
// SAFETY: real texts require BOTH SENDBLUE_LIVE=true (global) AND
// CONFIRMATIONS_ORIGINATION_LIVE=true (this touchpoint). Prod is already live
// for t1/day-of, so without the second flag this logs dry-run rows only.
import { prisma } from "@/lib/db";
import { sendConfirmation } from "./send";
import { everSent, type WorklistRow } from "./worklist";
import {
  renderOrigination,
  formatDemoDay,
  formatDemoTime,
  firstNameOf,
} from "./copy";

function originationLive(): boolean {
  return process.env.CONFIRMATIONS_ORIGINATION_LIVE === "true";
}

/** Only reply to a group the webhook just registered. */
const FRESH_WINDOW_MS = 60 * 60 * 1000;

/** Time-match fallback: booking row must land within this of the group. */
const TIME_MATCH_WINDOW_MS = 30 * 60 * 1000;

// The reply is contextual (setter just texted, prospect just got off the
// booking call), so the window is wide — this only blocks genuinely odd hours.
const LOCAL_HOUR_MIN = 7; // inclusive
const LOCAL_HOUR_MAX = 22; // exclusive

export interface OriginationOutcome {
  action: "sent" | "dry_run" | "skipped" | "failed";
  reason?: string;
  matchSource?: "phone" | "time";
}

function prospectLocalHour(timezone: string | null): number {
  const tz = timezone && timezone.trim() ? timezone : "America/New_York";
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", hour12: false };
  try {
    return parseInt(new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(new Date()), 10);
  } catch {
    return parseInt(
      new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "America/New_York" }).format(new Date()),
      10
    );
  }
}

const bookingInclude = { demo: { include: { closer: true } }, setter: true } as const;

/**
 * Time-based fallback matcher. Returns a booking ONLY when it's the single
 * unambiguous candidate: created within ±30 min of the group, upcoming, not
 * cancelled, not already tied to any group (phone-matched elsewhere), and not
 * already greeted. Anything else -> null (silence beats a wrong guess).
 */
async function timeMatchCandidate(groupCreatedAt: Date) {
  const t = groupCreatedAt.getTime();
  const candidates = await prisma.booking.findMany({
    where: {
      supersededAt: null,
      createdAt: { gte: new Date(t - TIME_MATCH_WINDOW_MS), lte: new Date(t + TIME_MATCH_WINDOW_MS) },
      demoDate: { gt: new Date() },
    },
    include: bookingInclude,
  });

  const viable = [];
  for (const b of candidates) {
    if ((b.demo?.status || "pending") === "cancelled") continue;
    const claimed = await prisma.sendblueGroup.findFirst({
      where: { bookingId: b.id },
      select: { id: true },
    });
    if (claimed) continue;
    const greeted = await prisma.confirmationSend.findFirst({
      where: { bookingId: b.id, touchpoint: "origination", status: "sent" },
      select: { id: true },
    });
    if (greeted) continue;
    viable.push(b);
  }
  return { booking: viable.length === 1 ? viable[0] : null, candidateCount: viable.length };
}

/**
 * Called by the SendBlue webhook after it upserts/matches the group. Sends the
 * origination reply when every gate passes; otherwise reports why it skipped.
 */
export async function maybeSendOriginationReply(groupId: string): Promise<OriginationOutcome> {
  const group = await prisma.sendblueGroup.findUnique({ where: { groupId } });
  if (!group) return { action: "skipped", reason: "group_unknown" };
  if (Date.now() - group.createdAt.getTime() > FRESH_WINDOW_MS) {
    return { action: "skipped", reason: "stale_group" };
  }

  // Tier 1: phone match (set by the webhook/poll sync). Tier 2: time match.
  // No match at all = silence — this is what keeps the ops group and any
  // non-prospect group safe. (Group-before-booking race self-resolves: the
  // next inbound message re-fires the webhook and both tiers re-run.)
  let matchSource: "phone" | "time";
  let booking;
  if (group.bookingId) {
    matchSource = "phone";
    booking = await prisma.booking.findUnique({
      where: { id: group.bookingId },
      include: bookingInclude,
    });
    if (!booking) return { action: "skipped", reason: "booking_missing" };
  } else {
    matchSource = "time";
    const { booking: candidate, candidateCount } = await timeMatchCandidate(group.createdAt);
    if (!candidate) {
      return {
        action: "skipped",
        reason: candidateCount > 1 ? "time_ambiguous" : "no_booking_match",
      };
    }
    booking = candidate;
  }

  const demoStatus = booking.demo?.status || "pending";
  if (demoStatus === "cancelled") return { action: "skipped", reason: "cancelled" };
  if (booking.demoDate.getTime() < Date.now()) return { action: "skipped", reason: "demo_past" };

  // Once per prospect ever (real sends), same rule as T-1 — a reschedule with
  // a fresh group must not get the greeting twice.
  if (await everSent("origination", booking.prospectEmail, booking.prospectPhone)) {
    return { action: "skipped", reason: "already_sent", matchSource };
  }
  // Retrigger guard incl. dry runs — one logged attempt per booking is enough.
  const prior = await prisma.confirmationSend.findFirst({
    where: { bookingId: booking.id, touchpoint: "origination", status: "sent" },
    select: { id: true },
  });
  if (prior) return { action: "skipped", reason: "already_sent", matchSource };

  const hour = prospectLocalHour(booking.prospectTimezone);
  if (hour < LOCAL_HOUR_MIN || hour >= LOCAL_HOUR_MAX) {
    return { action: "skipped", reason: "quiet_hours", matchSource };
  }

  const prospectFirstName = firstNameOf(booking.prospectName);
  const body = renderOrigination({
    setterFirstName: booking.setter?.name ? firstNameOf(booking.setter.name) : null,
    dayLabel: formatDemoDay(booking.demoDate, booking.prospectTimezone),
    prospectFirstName,
    generic: matchSource === "time",
  });

  const row: WorklistRow = {
    bookingId: booking.id,
    prospectName: booking.prospectName,
    prospectFirstName,
    prospectPhone: booking.prospectPhone,
    prospectEmail: booking.prospectEmail,
    demoDate: booking.demoDate.toISOString(),
    demoTimeLabel: formatDemoTime(booking.demoDate, booking.prospectTimezone),
    closerName: booking.demo?.closer?.name || null,
    setterName: booking.setter?.name || null,
    caseType: "area",
    addressVariable: null,
    addressSource: "none",
    ambiguous: false,
    emailCount: null,
    body,
    // records which matcher produced the send — audit + readiness data
    variant: matchSource === "time" ? "time_matched" : "phone_matched",
    groupId,
    sendable: true,
    skipReason: null,
    blockReason: null,
    sendStatus: "not_sent",
    sentDryRun: false,
    sentAt: null,
  };

  const outcome = await sendConfirmation(row, "origination", {
    autoSent: true,
    forceDryRun: !originationLive(),
  });
  if (outcome.status === "sent") {
    return { action: outcome.dryRun ? "dry_run" : "sent", matchSource };
  }
  return { action: "failed", reason: outcome.error || outcome.status, matchSource };
}
