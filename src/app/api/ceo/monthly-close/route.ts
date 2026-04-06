import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { month, year } = body;

  if (!month || !year) {
    return NextResponse.json({ error: "month and year required" }, { status: 400 });
  }

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  // Check all weeks in the month are confirmed
  const pendingWeeks = await prisma.weeklyClose.findMany({
    where: {
      weekStart: { gte: startDate, lte: endDate },
      status: "pending",
    },
  });

  // Check for unreviewed transactions
  const needsReview = await prisma.transaction.count({
    where: {
      date: { gte: startDate, lte: endDate },
      status: "needs_review",
    },
  });

  if (needsReview > 0) {
    return NextResponse.json(
      { error: `${needsReview} transactions still need review before closing the month` },
      { status: 400 }
    );
  }

  // Calculate snapshot totals
  const transactions = await prisma.transaction.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
      classification: { not: "internal_transfer" },
    },
  });

  let totalRevenue = 0;
  let totalExpenses = 0;
  let totalPayroll = 0;
  let totalPersonal = 0;

  for (const tx of transactions) {
    if (tx.amountCents > 0) {
      totalRevenue += tx.amountCents;
    } else if (tx.amountCents < 0) {
      const amt = Math.abs(tx.amountCents);
      if (tx.classification === "payroll") totalPayroll += amt;
      else if (tx.classification === "personal") totalPersonal += amt;
      else if (tx.classification === "business") totalExpenses += amt;
      // internal_transfer and needs_review are excluded from P&L
    }
  }

  const netProfit = totalRevenue - totalExpenses - totalPayroll;

  const monthlyClose = await prisma.monthlyClose.upsert({
    where: { month_year: { month, year } },
    update: {
      status: "confirmed",
      confirmedAt: new Date(),
      totalRevenueCents: totalRevenue,
      totalExpensesCents: totalExpenses,
      totalPayrollCents: totalPayroll,
      totalPersonalCents: totalPersonal,
      netProfitCents: netProfit,
    },
    create: {
      month,
      year,
      status: "confirmed",
      confirmedAt: new Date(),
      totalRevenueCents: totalRevenue,
      totalExpensesCents: totalExpenses,
      totalPayrollCents: totalPayroll,
      totalPersonalCents: totalPersonal,
      netProfitCents: netProfit,
    },
  });

  return NextResponse.json({
    success: true,
    monthlyClose,
    warnings: pendingWeeks.length > 0
      ? `${pendingWeeks.length} weekly close(s) still pending`
      : null,
  });
}
