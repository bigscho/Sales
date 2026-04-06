import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const month = parseInt(searchParams.get("month") || String(new Date().getMonth() + 1));
  const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()));
  const view = searchParams.get("view") || "monthly"; // monthly | weekly | mtd

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);
  const today = new Date();

  // For MTD, end at today
  const effectiveEnd = view === "mtd" && today < endDate ? today : endDate;

  // Get all transactions for the period
  const transactions = await prisma.transaction.findMany({
    where: {
      date: { gte: startDate, lte: effectiveEnd },
      classification: { not: "internal_transfer" },
    },
    include: { category: true },
    orderBy: { date: "asc" },
  });

  // Revenue: positive amounts from mercury/stripe that aren't internal transfers
  const revenue = {
    mrr: 0,
    oneTime: 0,
    other: 0,
    total: 0,
  };

  // Expenses by category
  const expensesByCategory: Record<string, { total: number; items: number }> = {};
  let totalBusiness = 0;
  let totalPayroll = 0;
  let totalPersonal = 0;

  for (const tx of transactions) {
    if (tx.amountCents > 0) {
      // Revenue (inflows only)
      if (tx.source === "stripe" && tx.description?.includes("subscription")) {
        revenue.mrr += tx.amountCents;
      } else if (tx.source === "stripe") {
        revenue.oneTime += tx.amountCents;
      } else {
        revenue.other += tx.amountCents;
      }
      revenue.total += tx.amountCents;
    } else if (tx.amountCents < 0) {
      // Expense (outflows only)
      const catName = tx.category?.name || tx.classification;

      if (tx.classification === "payroll") {
        totalPayroll += Math.abs(tx.amountCents);
      } else if (tx.classification === "personal") {
        totalPersonal += Math.abs(tx.amountCents);
      } else if (tx.classification === "business") {
        totalBusiness += Math.abs(tx.amountCents);
        if (!expensesByCategory[catName]) expensesByCategory[catName] = { total: 0, items: 0 };
        expensesByCategory[catName].total += Math.abs(tx.amountCents);
        expensesByCategory[catName].items++;
      }
    }
  }

  // Stripe processing fees — pull from balance transactions
  let stripeFees = 0;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      let hasMore = true;
      let startingAfter: string | undefined;

      while (hasMore) {
        const params: Record<string, unknown> = {
          limit: 100,
          created: {
            gte: Math.floor(startDate.getTime() / 1000),
            lte: Math.floor(effectiveEnd.getTime() / 1000),
          },
        };
        if (startingAfter) params.starting_after = startingAfter;

        const batch = await stripe.balanceTransactions.list(
          params as Parameters<typeof stripe.balanceTransactions.list>[0]
        );

        for (const bt of batch.data) {
          // fee is always positive, represents Stripe's cut
          if (bt.fee > 0) stripeFees += bt.fee;
        }

        hasMore = batch.has_more;
        if (batch.data.length > 0) {
          startingAfter = batch.data[batch.data.length - 1].id;
        }
      }
    } catch { /* Stripe API unavailable */ }
  }

  const totalExpenses = totalBusiness + stripeFees;
  const netProfit = revenue.total - totalExpenses - totalPayroll;
  const margin = revenue.total > 0 ? netProfit / revenue.total : 0;

  // Get monthly close status
  const monthlyClose = await prisma.monthlyClose.findUnique({
    where: { month_year: { month, year } },
  });

  // Get weekly closes for this month
  const weeklyCloses = await prisma.weeklyClose.findMany({
    where: {
      weekStart: { gte: startDate, lte: endDate },
    },
    orderBy: { weekStart: "asc" },
  });

  // Previous month comparison
  const prevStart = new Date(year, month - 2, 1);
  const prevEnd = new Date(year, month - 1, 0, 23, 59, 59);
  const prevTransactions = await prisma.transaction.findMany({
    where: {
      date: { gte: prevStart, lte: prevEnd },
      classification: { not: "internal_transfer" },
    },
  });

  let prevRevenue = 0;
  let prevExpenses = 0;
  for (const tx of prevTransactions) {
    if (tx.amountCents > 0) prevRevenue += tx.amountCents;
    else if (tx.classification === "business" || tx.classification === "payroll")
      prevExpenses += Math.abs(tx.amountCents);
  }

  return NextResponse.json({
    period: { month, year, view },
    revenue,
    expenses: {
      business: totalBusiness,
      stripeFees,
      totalBusinessWithFees: totalExpenses,
      payroll: totalPayroll,
      personal: totalPersonal,
      byCategory: [
        ...Object.entries(expensesByCategory)
          .map(([name, data]) => ({ name, ...data }))
          .sort((a, b) => b.total - a.total),
        ...(stripeFees > 0 ? [{ name: "Stripe Processing Fees", total: stripeFees, items: 0 }] : []),
      ],
    },
    netProfit,
    margin,
    monthlyClose,
    weeklyCloses,
    comparison: {
      prevRevenue,
      prevExpenses,
      prevNetProfit: prevRevenue - prevExpenses,
      revenueChange: prevRevenue > 0 ? (revenue.total - prevRevenue) / prevRevenue : 0,
    },
    transactionCount: transactions.length,
    needsReviewCount: transactions.filter((t) => t.status === "needs_review").length,
  });
}
