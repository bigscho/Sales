import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { calculateWeeklyKPIs } from "@/lib/kpis";
import { sendSlackMessage } from "@/lib/slack";
import { getWeekRange, formatCents, formatPercent, getWeekLabel } from "@/lib/utils";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { type } = body; // "midweek" or "weekly"

  const { start, end } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart: start } });
  if (!week) {
    return NextResponse.json({ error: "No week found" }, { status: 404 });
  }

  const kpis = await calculateWeeklyKPIs(week.id);
  const weekLabel = getWeekLabel(start, end);

  const payroll = await prisma.payrollRun.findFirst({
    where: { weekId: week.id },
    orderBy: { createdAt: "desc" },
    include: { lineItems: true },
  });
  const totalPayroll = payroll?.lineItems.reduce((s, i) => s + i.amountCents, 0) || 0;

  const expenses = await prisma.expense.findMany({ where: { weekId: week.id } });
  const totalExpenses = expenses.reduce((s, e) => s + e.amountCents, 0);

  if (type === "midweek") {
    const message = [
      `*Mid-Week Check (${weekLabel})*`,
      "",
      `Bookings: *${kpis.totalBookings}*`,
      `Shows: *${kpis.totalShows}* | No-Shows: *${kpis.totalNoShows}* | Pending: *${kpis.totalPending}*`,
      `Show Rate: *${formatPercent(kpis.showRate)}*`,
      "",
      kpis.totalPending > 0
        ? `_${kpis.totalPending} demos still need confirmation._`
        : "_All demos confirmed._",
    ].join("\n");

    await sendSlackMessage(message);
  } else {
    const message = [
      `*Weekly Summary (${weekLabel})*`,
      "",
      "*KPIs*",
      `Bookings: *${kpis.totalBookings}* | Shows: *${kpis.totalShows}* | Show Rate: *${formatPercent(kpis.showRate)}*`,
      `Closes: *${kpis.totalCloses}* | Close Rate: *${formatPercent(kpis.closeRate)}*`,
      `Cash Collected: *${formatCents(kpis.cashCollected)}*`,
      `Avg Cash/Close: *${formatCents(kpis.avgCashPerClose)}* | Cash/Show: *${formatCents(kpis.cashPerShow)}*`,
      "",
      "*Setters*",
      ...kpis.setterStats.map(
        (s) => `  ${s.setterName}: ${s.bookings} booked, ${s.shows} showed (${formatPercent(s.showRate)})`
      ),
      "",
      "*Closers*",
      ...kpis.closerStats.map(
        (c) => `  ${c.closerName}: ${c.shows} shows, ${c.closes} closes (${formatPercent(c.closeRate)}) - ${formatCents(c.cashCollected)}`
      ),
      "",
      `*Payroll*: ${payroll ? formatCents(totalPayroll) + ` (${payroll.status})` : "Not generated"}`,
      `*Expenses*: ${formatCents(totalExpenses)}`,
      `*Net*: ${formatCents(kpis.cashCollected - totalExpenses)}`,
      "",
      kpis.totalPending > 0 ? `_Action needed: ${kpis.totalPending} demos pending._` : "",
      payroll?.status === "draft" ? "_Action needed: Payroll not yet confirmed._" : "",
    ].filter(Boolean).join("\n");

    await sendSlackMessage(message);
  }

  return NextResponse.json({ success: true });
}
