import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackCEO } from "@/lib/slack";
import { getWeekRange, formatCents } from "@/lib/utils";

export async function POST() {
  const { start } = getWeekRange(new Date());

  const week = await prisma.week.findFirst({ where: { weekStart: start } });
  if (!week) {
    return NextResponse.json({ error: "No week found" }, { status: 404 });
  }

  // Revenue
  const payments = await prisma.payment.findMany({
    where: { weekId: week.id, status: "succeeded" },
  });
  const totalRevenue = payments.reduce((s, p) => s + p.amountCents, 0);
  const mrrRevenue = payments
    .filter((p) => p.revenueType === "mrr" || p.isSubscription)
    .reduce((s, p) => s + p.amountCents, 0);
  const oneTimeRevenue = totalRevenue - mrrRevenue;

  // Demos
  const demos = await prisma.demo.findMany({ where: { weekId: week.id } });
  const booked = demos.length;
  const showed = demos.filter((d) => d.status === "showed").length;
  const showRate = booked > 0 ? ((showed / booked) * 100).toFixed(1) : "0.0";

  // Closes
  const deals = await prisma.deal.findMany({
    where: { weekId: week.id, status: "closed_won" },
  });
  const closeCount = deals.length;
  const closeRate = showed > 0 ? ((closeCount / showed) * 100).toFixed(1) : "0.0";

  // Cash per booking
  const cashPerBooking = booked > 0 ? Math.round(totalRevenue / booked) : 0;

  // Anomaly flags
  const flags: string[] = [];

  if (booked > 0 && parseFloat(showRate) < 40) {
    flags.push("⚠️ Show rate is low");
  }

  // Closers with 0 closes
  const closers = await prisma.teamMember.findMany({
    where: { role: "closer", isActive: true },
  });
  for (const closer of closers) {
    const closerDeals = deals.filter((d) => d.closerId === closer.id);
    if (closerDeals.length === 0) {
      flags.push(`⚠️ ${closer.name} had 0 closes`);
    }
  }

  // Unmatched payments
  const unmatchedCount = payments.filter((p) => p.matchStatus === "unmatched").length;
  if (unmatchedCount > 0) {
    flags.push(`⚠️ ${unmatchedCount} payments need reconciliation`);
  }

  const weekLabel = start.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const lines = [
    `📈 *CEO Weekly Briefing — Week of ${weekLabel}*`,
    "",
    `*Revenue:* ${formatCents(totalRevenue)} (${formatCents(mrrRevenue)} MRR + ${formatCents(oneTimeRevenue)} one-time)`,
    `*Demos:* ${booked} booked, ${showed} showed (${showRate}% show rate)`,
    `*Closes:* ${closeCount} closed (${closeRate}% close rate)`,
    `*Cash/booking:* ${formatCents(cashPerBooking)}`,
  ];

  if (flags.length > 0) {
    lines.push("");
    lines.push("*Anomaly Flags:*");
    lines.push(...flags);
  }

  const message = lines.join("\n");
  await sendSlackCEO(message);

  return NextResponse.json({ success: true });
}

export async function GET() {
  // Vercel cron calls GET — delegate to POST handler
  const res = await POST();
  return res;
}
