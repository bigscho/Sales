import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { type TimeDimension, getDateRange } from "@/lib/time-range";
import { getWeekRange } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  const dimension = (request.nextUrl.searchParams.get("dimension") as TimeDimension) || "weekly";

  // Get all setters
  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true },
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

  // === ACTIVITY: bookings by createdAt in range ===
  // Excludes bulk-imported historical data (source: "auto") — only real-time activity
  const activityBookings = await prisma.booking.findMany({
    where: {
      ...(dateFilter ? { createdAt: dateFilter } : {}),
      source: { not: "auto" },
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

  // === RESULTS: demos by demoDate in range ===
  const resultsDemos = await prisma.demo.findMany({
    where: {
      ...(dateFilter ? { booking: { demoDate: dateFilter } } : {}),
    },
    include: { booking: { select: { setterId: true } } },
  });

  const resultsBySetterId: Record<string, { shows: number; noShows: number; pending: number }> = {};
  const resultsTotal = { shows: 0, noShows: 0, pending: 0 };

  for (const demo of resultsDemos) {
    const sid = demo.booking.setterId || "unattributed";
    if (!resultsBySetterId[sid]) resultsBySetterId[sid] = { shows: 0, noShows: 0, pending: 0 };
    if (demo.status === "showed") { resultsBySetterId[sid].shows++; resultsTotal.shows++; }
    else if (demo.status === "no_show") { resultsBySetterId[sid].noShows++; resultsTotal.noShows++; }
    else if (demo.status === "pending") { resultsBySetterId[sid].pending++; resultsTotal.pending++; }
  }

  // Build scoreboard entries
  const scoreboard = setters.map((s) => {
    const activity = activityBySetterId[s.id] || 0;
    const results = resultsBySetterId[s.id] || { shows: 0, noShows: 0, pending: 0 };
    const confirmed = results.shows + results.noShows;
    return {
      id: s.id,
      name: s.name,
      tier: s.tier,
      activity: { newBookings: activity },
      results: {
        ...results,
        showRate: confirmed > 0 ? results.shows / confirmed : 0,
      },
    };
  });

  const teamShowRate = (resultsTotal.shows + resultsTotal.noShows) > 0
    ? resultsTotal.shows / (resultsTotal.shows + resultsTotal.noShows)
    : 0;

  // Unattributed
  const unattributedActivity = activityBySetterId["unattributed"] || 0;
  const unattributedResults = resultsBySetterId["unattributed"] || { shows: 0, noShows: 0, pending: 0 };
  const unattributedConfirmed = unattributedResults.shows + unattributedResults.noShows;

  return NextResponse.json({
    scoreboard,
    teamTotals: {
      activity: { newBookings: activityTotal },
      results: { ...resultsTotal, showRate: teamShowRate },
    },
    unattributed: {
      activity: { newBookings: unattributedActivity },
      results: {
        ...unattributedResults,
        showRate: unattributedConfirmed > 0 ? unattributedResults.shows / unattributedConfirmed : 0,
      },
    },
    showRateRep: showRateRep ? {
      id: showRateRep.id,
      name: showRateRep.name,
      showRate: teamShowRate,
    } : null,
    dimension,
  });
}
