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

  const stats: { name: string; bookings: number; shows: number; noShows: number; showRate: number }[] = [];

  for (const setter of setters) {
    const bookings = await prisma.booking.count({
      where: { weekId: week.id, setterId: setter.id },
    });
    const shows = await prisma.demo.count({
      where: {
        weekId: week.id,
        booking: { setterId: setter.id },
        status: "showed",
      },
    });
    const noShows = await prisma.demo.count({
      where: {
        weekId: week.id,
        booking: { setterId: setter.id },
        status: "no_show",
      },
    });
    stats.push({
      name: setter.name,
      bookings,
      shows,
      noShows,
      showRate: (shows + noShows) > 0 ? shows / (shows + noShows) : 0,
    });
  }

  // Sort by bookings descending
  stats.sort((a, b) => b.bookings - a.bookings);

  // Get total team stats
  const totalBookings = stats.reduce((s, st) => s + st.bookings, 0);
  const totalShows = stats.reduce((s, st) => s + st.shows, 0);
  const totalNoShows = stats.reduce((s, st) => s + st.noShows, 0);
  const teamShowRate = (totalShows + totalNoShows) > 0 ? totalShows / (totalShows + totalNoShows) : 0;

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
