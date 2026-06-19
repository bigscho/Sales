import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackVerify, sendSlackCEO } from "@/lib/slack";
import { formatMention, isWeekday, getWeeklyShowStats } from "@/lib/setter-game";
import { getWeekRange, computeShowRate } from "@/lib/utils";

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
        OR: [
          { bookedAt: { gte: weekStart, lt: new Date(weekEnd.getTime() + 1) } },
          { AND: [{ bookedAt: null }, { createdAt: { gte: weekStart, lt: new Date(weekEnd.getTime() + 1) } }] },
        ],
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
    const cancelled = demos.filter(d => d.status === "cancelled").length;
    const denom = shows + noShows + cancelled;
    const showRate = denom > 0 ? (computeShowRate(shows, noShows, cancelled) * 100).toFixed(0) : "--";

    const reviewLink = `${BASE_URL}/verify?weekId=${week.id}&setter=${setter.id}`;

    // Check if they've already confirmed today
    const existingVerification = await prisma.setterVerification.findUnique({
      where: { setterId_weekId: { setterId: setter.id, weekId: week.id } },
    });
    const confirmStatus = existingVerification
      ? existingVerification.status === "confirmed" ? " ✅ Confirmed" : " 🚩 Has flags"
      : "";

    const cancelledPart = cancelled > 0 ? ` | ${cancelled} cancelled` : "";
    const message = [
      `${mention}${confirmStatus}`,
      `*Week-to-date:* ${newBookings} booked | ${shows} showed | ${noShows} no-show${cancelledPart} | ${pending} pending`,
      `*Show rate:* ${showRate}%`,
      existingVerification ? `<${reviewLink}|Update Verification>` : `<${reviewLink}|Review & Confirm Your Demos>`,
    ].join("\n");

    await sendSlackVerify(message);

    const statusLabel = existingVerification ? ` [${existingVerification.status}]` : " [not confirmed]";
    setterSummaries.push(`${setter.name}: ${newBookings} booked, ${shows}/${denom} showed (${showRate}%), ${pending} pending${statusLabel}`);
  }

  // Team totals for CEO summary — cancels count against show rate
  const { totalShows, totalNoShows, totalPending, totalCancelled } = await getWeeklyShowStats();
  const teamDenom = totalShows + totalNoShows + totalCancelled;
  const teamShowRate = teamDenom > 0 ? (computeShowRate(totalShows, totalNoShows, totalCancelled) * 100).toFixed(0) : "--";

  const ceoMessage = [
    `*Daily Setter Verification Summary*`,
    `Team show rate: ${teamShowRate}% (${totalShows}/${teamDenom})${totalPending > 0 ? ` | ${totalPending} pending` : ""}${totalCancelled > 0 ? ` | ${totalCancelled} cancelled` : ""}`,
    ``,
    ...setterSummaries,
  ].join("\n");

  await sendSlackCEO(ceoMessage);

  return NextResponse.json({ success: true, setters: setters.length });
}

export async function GET() {
  return POST();
}
