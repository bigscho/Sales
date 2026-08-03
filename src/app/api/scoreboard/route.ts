import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { type TimeDimension, getDateRange } from "@/lib/time-range";
import { getWeekRange, computeShowRate } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  const dimension = (request.nextUrl.searchParams.get("dimension") as TimeDimension) || "weekly";

  // Get all setters (exclude non-setter bookers like CEO, guests)
  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
    orderBy: { name: "asc" },
  });

  // Get the show rate rep
  const showRateRep = await prisma.teamMember.findFirst({
    where: { role: "show_rate_rep", isActive: true },
  });

  // Compute date range based on dimension
  let dateRange: { start: Date; end: Date } | null = null;
  if (dimension === "weekly" && weekId) {
    // Use the selected week's boundaries
    const week = await prisma.week.findUnique({ where: { id: weekId } });
    if (week) {
      dateRange = { start: week.weekStart, end: week.weekEnd };
    } else {
      dateRange = getWeekRange(new Date());
    }
  } else {
    dateRange = getDateRange(dimension);
  }

  // Build date filter for queries
  const dateFilter = dateRange
    ? { gte: dateRange.start, lt: dimension === "weekly" ? new Date(dateRange.end.getTime() + 1) : dateRange.end }
    : undefined;

  // === ACTIVITY: bookings by bookedAt (with createdAt fallback) in range ===
  // Includes gcal_sync so the leaderboard stays accurate when the Calendly webhook is down —
  // gcal_sync is the 10-min backup path and writes real setterId from the event description.
  // bookedAt is bumped on every booking event (create + rebook) so rebooks give the
  // rebooking setter visual activity credit on the day of rebook, not the day the original
  // row was created.
  const activityBookings = await prisma.booking.findMany({
    where: {
      ...(dateFilter
        ? {
            OR: [
              { bookedAt: dateFilter },
              { AND: [{ bookedAt: null }, { createdAt: dateFilter }] },
            ],
          }
        : {}),
      source: { in: ["calendly_webhook", "manual", "gcal_sync"] },
    },
    select: { setterId: true },
  });

  const activityBySetterId: Record<string, number> = {};
  let activityTotal = 0;
  for (const b of activityBookings) {
    const sid = b.setterId || "unattributed";
    activityBySetterId[sid] = (activityBySetterId[sid] || 0) + 1;
    activityTotal++;
  }

  // Immutable reference: rows physically created during this period. createdAt is
  // never mutated and (under the immutable-history model) rows never migrate weeks,
  // so this is the "what we saw live during the week" number and will never restate.
  const asBookedTotal = dateFilter
    ? await prisma.booking.count({
        where: {
          createdAt: dateFilter,
          source: { in: ["calendly_webhook", "manual", "gcal_sync"] },
        },
      })
    : activityTotal;

  // === RESULTS: demos by demoDate in range ===
  const resultsDemos = await prisma.demo.findMany({
    where: {
      ...(dateFilter ? { booking: { demoDate: dateFilter } } : {}),
    },
    include: { booking: { select: { setterId: true } } },
  });

  const resultsBySetterId: Record<string, { shows: number; noShows: number; pending: number; cancelled: number }> = {};
  const resultsTotal = { shows: 0, noShows: 0, pending: 0, cancelled: 0 };

  for (const demo of resultsDemos) {
    const sid = demo.booking.setterId || "unattributed";
    if (!resultsBySetterId[sid]) resultsBySetterId[sid] = { shows: 0, noShows: 0, pending: 0, cancelled: 0 };
    if (demo.status === "showed") { resultsBySetterId[sid].shows++; resultsTotal.shows++; }
    else if (demo.status === "no_show") { resultsBySetterId[sid].noShows++; resultsTotal.noShows++; }
    else if (demo.status === "pending") { resultsBySetterId[sid].pending++; resultsTotal.pending++; }
    else if (demo.status === "cancelled") { resultsBySetterId[sid].cancelled++; resultsTotal.cancelled++; }
  }

  // === PENDING TOTAL: pending demos from current period forward (not historical) ===
  const pendingTotalBySetterId: Record<string, number> = {};
  let pendingTotalAll = 0;
  const pendingCutoff = dateRange ? dateRange.start : undefined;
  const allPendingDemos = await prisma.demo.findMany({
    where: {
      status: "pending",
      ...(pendingCutoff ? { booking: { demoDate: { gte: pendingCutoff } } } : {}),
    },
    include: { booking: { select: { setterId: true } } },
  });
  for (const demo of allPendingDemos) {
    const sid = demo.booking.setterId || "unattributed";
    pendingTotalBySetterId[sid] = (pendingTotalBySetterId[sid] || 0) + 1;
    pendingTotalAll++;
  }

  // Build scoreboard entries
  const scoreboard = setters.map((s) => {
    const activity = activityBySetterId[s.id] || 0;
    const results = resultsBySetterId[s.id] || { shows: 0, noShows: 0, pending: 0, cancelled: 0 };
    const pendingTotal = pendingTotalBySetterId[s.id] || 0;
    return {
      id: s.id,
      name: s.name,
      tier: s.tier,
      creditBalance: s.creditBalance || 0,
      activity: { newBookings: activity },
      results: {
        ...results,
        showRate: computeShowRate(results.shows, results.noShows, results.cancelled),
      },
      pendingTotal,
    };
  });

  const teamShowRate = computeShowRate(resultsTotal.shows, resultsTotal.noShows, resultsTotal.cancelled);

  // Unattributed
  const unattributedActivity = activityBySetterId["unattributed"] || 0;
  const unattributedResults = resultsBySetterId["unattributed"] || { shows: 0, noShows: 0, pending: 0, cancelled: 0 };
  const unattributedPendingTotal = pendingTotalBySetterId["unattributed"] || 0;

  return NextResponse.json({
    scoreboard,
    teamTotals: {
      activity: { newBookings: activityTotal, asBooked: asBookedTotal },
      results: { ...resultsTotal, showRate: teamShowRate },
      pendingTotal: pendingTotalAll,
    },
    unattributed: {
      activity: { newBookings: unattributedActivity },
      results: {
        ...unattributedResults,
        showRate: computeShowRate(unattributedResults.shows, unattributedResults.noShows, unattributedResults.cancelled),
      },
      pendingTotal: unattributedPendingTotal,
    },
    showRateRep: showRateRep ? {
      id: showRateRep.id,
      name: showRateRep.name,
      showRate: teamShowRate,
    } : null,
    dimension,
  });
}
