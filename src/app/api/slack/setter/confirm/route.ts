import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackVerify, sendSlackCEO } from "@/lib/slack";
import { formatMention, isWeekday, getWeeklyShowStats } from "@/lib/setter-game";
import { getWeekRange } from "@/lib/utils";

const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.NEXTAUTH_URL || "https://sales-puce-six.vercel.app";

export async function POST() {
  if (!isWeekday()) {
    return NextResponse.json({ skipped: true, reason: "weekend" });
  }

  const { start: weekStart, end: weekEnd } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart } });
  if (!week) {
    return NextResponse.json({ skipped: true, reason: "no_week" });
  }

  // Get active setters (exclude non-setter bookers)
  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
  });

  const setterSummaries: string[] = [];

  for (const setter of setters) {
    const mention = formatMention(setter);

    // WTD bookings (activity)
    const newBookings = await prisma.booking.count({
      where: {
        setterId: setter.id,
        createdAt: { gte: weekStart, lt: new Date(weekEnd.getTime() + 1) },
        source: { in: ["calendly_webhook", "manual"] },
      },
    });

    // WTD demo results
    const demos = await prisma.demo.findMany({
      where: { weekId: week.id, booking: { setterId: setter.id } },
    });
    const shows = demos.filter(d => d.status === "showed").length;
    const noShows = demos.filter(d => d.status === "no_show").length;
    const pending = demos.filter(d => d.status === "pending").length;
    const confirmed = shows + noShows;
    const showRate = confirmed > 0 ? ((shows / confirmed) * 100).toFixed(0) : "--";

    const reviewLink = `${BASE_URL}/demos?weekId=${week.id}&setter=${setter.id}`;

    const message = [
      `${mention}`,
      `*Week-to-date:* ${newBookings} booked | ${shows} showed | ${noShows} no-show | ${pending} pending`,
      `*Show rate:* ${showRate}%`,
      `<${reviewLink}|Review & Confirm Your Demos>`,
    ].join("\n");

    await sendSlackVerify(message);

    setterSummaries.push(`${setter.name}: ${newBookings} booked, ${shows}/${confirmed} showed (${showRate}%), ${pending} pending`);
  }

  // Team totals for CEO summary
  const { totalShows, totalNoShows, totalPending } = await getWeeklyShowStats();
  const teamConfirmed = totalShows + totalNoShows;
  const teamShowRate = teamConfirmed > 0 ? ((totalShows / teamConfirmed) * 100).toFixed(0) : "--";

  const ceoMessage = [
    `*Daily Setter Verification Summary*`,
    `Team show rate: ${teamShowRate}% (${totalShows}/${teamConfirmed})${totalPending > 0 ? ` | ${totalPending} pending` : ""}`,
    ``,
    ...setterSummaries,
  ].join("\n");

  await sendSlackCEO(ceoMessage);

  return NextResponse.json({ success: true, setters: setters.length });
}

export async function GET() {
  return POST();
}
