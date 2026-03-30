import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");

  // Get all setters
  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true },
    orderBy: { name: "asc" },
  });

  // Get the show rate rep
  const showRateRep = await prisma.teamMember.findFirst({
    where: { role: "show_rate_rep", isActive: true },
  });

  // Current week stats
  let weekStats: Record<string, { bookings: number; shows: number; noShows: number; pending: number }> = {};
  let weekTotal = { bookings: 0, shows: 0, noShows: 0, pending: 0 };

  if (weekId) {
    const demos = await prisma.demo.findMany({
      where: { weekId },
      include: { booking: { select: { setterId: true } } },
    });

    for (const demo of demos) {
      const sid = demo.booking.setterId || "unattributed";
      if (!weekStats[sid]) weekStats[sid] = { bookings: 0, shows: 0, noShows: 0, pending: 0 };
      weekStats[sid].bookings++;
      weekTotal.bookings++;
      if (demo.status === "showed") { weekStats[sid].shows++; weekTotal.shows++; }
      else if (demo.status === "no_show") { weekStats[sid].noShows++; weekTotal.noShows++; }
      else if (demo.status === "pending") { weekStats[sid].pending++; weekTotal.pending++; }
    }
  }

  // All-time stats (across all weeks in DB)
  const allDemos = await prisma.demo.findMany({
    include: { booking: { select: { setterId: true } } },
  });

  const allTimeStats: Record<string, { bookings: number; shows: number; noShows: number }> = {};
  let allTimeTotal = { bookings: 0, shows: 0, noShows: 0 };

  for (const demo of allDemos) {
    const sid = demo.booking.setterId || "unattributed";
    if (!allTimeStats[sid]) allTimeStats[sid] = { bookings: 0, shows: 0, noShows: 0 };
    allTimeStats[sid].bookings++;
    allTimeTotal.bookings++;
    if (demo.status === "showed") { allTimeStats[sid].shows++; allTimeTotal.shows++; }
    else if (demo.status === "no_show") { allTimeStats[sid].noShows++; allTimeTotal.noShows++; }
  }

  // Build scoreboard entries sorted by bookings desc
  const scoreboard = setters.map((s) => {
    const week = weekStats[s.id] || { bookings: 0, shows: 0, noShows: 0, pending: 0 };
    const allTime = allTimeStats[s.id] || { bookings: 0, shows: 0, noShows: 0 };
    return {
      id: s.id,
      name: s.name,
      tier: s.tier,
      week: {
        ...week,
        showRate: week.bookings > 0 ? week.shows / week.bookings : 0,
      },
      allTime: {
        ...allTime,
        showRate: allTime.bookings > 0 ? allTime.shows / allTime.bookings : 0,
      },
    };
  });

  // Sort by this week's bookings desc, then all-time
  scoreboard.sort((a, b) => b.week.bookings - a.week.bookings || b.allTime.bookings - a.allTime.bookings);

  // Unattributed stats
  const unattributed = {
    week: weekStats["unattributed"] || { bookings: 0, shows: 0, noShows: 0, pending: 0 },
    allTime: allTimeStats["unattributed"] || { bookings: 0, shows: 0, noShows: 0 },
  };

  return NextResponse.json({
    scoreboard,
    weekTotal,
    allTimeTotal,
    unattributed,
    showRateRep: showRateRep ? {
      id: showRateRep.id,
      name: showRateRep.name,
      weekShowRate: weekTotal.bookings > 0 ? weekTotal.shows / weekTotal.bookings : 0,
      allTimeShowRate: allTimeTotal.bookings > 0 ? allTimeTotal.shows / allTimeTotal.bookings : 0,
    } : null,
  });
}
