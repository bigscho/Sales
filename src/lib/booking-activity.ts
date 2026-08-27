import type { Prisma } from "@prisma/client";

/** A period bound, e.g. { gte, lt } or { gte, lte } or open-ended { gte }. */
type ActivityRange = { gte?: Date; lt?: Date; lte?: Date };

/**
 * THE canonical "new booking activity" filter. Use this everywhere a surface
 * counts bookings-credited-in-a-period (scoreboard, dashboard KPIs, pigeon
 * tiers, weekly credits, Slack setter recaps, Bookings Today). Do not re-derive
 * this where-clause inline — the whole point is that every surface agrees.
 *
 * Semantics (count each real booking EVENT once, in its own week, under its own setter):
 *   - Activity is credited by `bookedAt` (the booking moment), with a `createdAt`
 *     fallback ONLY for legacy rows whose bookedAt is null.
 *   - We count `isBookingEvent` rows. That flag (set at write time, see below) is
 *     true for an original booking AND for a genuine RE-BOOK after a terminal outcome
 *     (showed / no_show / cancelled) — a re-book is new setter effort, so it earns a
 *     fresh credit in the rebooker's week. It is false only for a pending-reschedule
 *     successor, which is the SAME meeting moved to a new time (inherited bookedAt) and
 *     must not double-count.
 *
 * Consequences:
 *   - A no-show that rebooks counts as TWO bookings (two real booking events) but only
 *     ONE show (the show is an outcome, counted once by demoDate — not here).
 *   - `isBookingEvent` and `bookedAt` are frozen at creation and never restated, so a
 *     past week's count is stable forever. This is what fixes the "past weeks shrink"
 *     bug: the old `supersededAt: null` filter dropped a terminal original the moment
 *     its prospect rebooked; now the original keeps its credit and the rebook adds its
 *     own in a later week.
 */
export function newBookingActivityWhere(range?: ActivityRange): Prisma.BookingWhereInput {
  return {
    isBookingEvent: true,
    ...(range
      ? {
          OR: [
            { bookedAt: range },
            { AND: [{ bookedAt: null }, { createdAt: range }] },
          ],
        }
      : {}),
  };
}
