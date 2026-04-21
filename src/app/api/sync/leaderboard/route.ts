import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackMessage } from "@/lib/slack";
import { getWeekRange, formatPercent } from "@/lib/utils";

export async function POST() {
  const { start } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart: start } });
  if (!week) {
    return NextResponse.json({ error: "No current week found" }, { status: 404 });
  }

  // Get setter stats for the week
  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true },
  });

  const stats: { name: string; bookings: number; shows: number; showRate: number }[] = [];

  for (const setter of setters) {
    // Bookings denominator: everything on the calendar except rescheduled.
    // Cancels count against the show rate — we failed to get them to show.
    const bookings = await prisma.demo.count({
      where: {
        weekId: week.id,
        booking: { setterId: setter.id },
        status: { not: "rescheduled" },
      },
    });
    const shows = await prisma.demo.count({
      where: {
        weekId: week.id,
        booking: { setterId: setter.id },
        status: "showed",
      },
    });
    stats.push({
      name: setter.name,
      bookings,
      shows,
      showRate: bookings > 0 ? shows / bookings : 0,
    });
  }

  // Sort by bookings descending
  stats.sort((a, b) => b.bookings - a.bookings);

  // Get total team stats
  const totalBookings = stats.reduce((s, st) => s + st.bookings, 0);
  const totalShows = stats.reduce((s, st) => s + st.shows, 0);
  const teamShowRate = totalBookings > 0 ? totalShows / totalBookings : 0;

  // Get day of week for context
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = dayNames[new Date().getDay()];

  // Build Slack message
  const medals = ["🥇", "🥈", "🥉", "  4."];
  const leaderboard = stats.map((s, i) => {
    const medal = medals[i] || `  ${i + 1}.`;
    const bar = "█".repeat(Math.min(s.bookings, 20));
    return `${medal} *${s.name}*: ${s.bookings} bookings, ${s.shows} shows (${formatPercent(s.showRate)}) ${bar}`;
  }).join("\n");

  const message = [
    `*Setter Leaderboard* — ${today} Update`,
    "",
    leaderboard,
    "",
    `Team Total: *${totalBookings}* bookings | *${totalShows}* shows | *${formatPercent(teamShowRate)}* show rate`,
    totalBookings < 15 ? "\n_Let's keep pushing! 💪_" : "\n_Great pace this week! 🔥_",
  ].join("\n");

  await sendSlackMessage(message);

  return NextResponse.json({ success: true, stats, message });
}
