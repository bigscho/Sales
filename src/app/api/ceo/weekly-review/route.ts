import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Get all pending weekly closes, or a specific one
  const weekStart = searchParams.get("weekStart");

  if (weekStart) {
    const start = new Date(weekStart);
    const { end } = getWeekRange(start);

    // Get or create the weekly close record
    let weeklyClose = await prisma.weeklyClose.findUnique({
      where: { weekStart: start },
    });

    if (!weeklyClose) {
      // Count transactions in this week range
      const txCount = await prisma.transaction.count({
        where: { date: { gte: start, lte: end } },
      });

      weeklyClose = await prisma.weeklyClose.create({
        data: {
          weekStart: start,
          weekEnd: end,
          transactionCount: txCount,
        },
      });
    }

    // Get transactions for this week grouped by classification/category
    const transactions = await prisma.transaction.findMany({
      where: { date: { gte: start, lte: end } },
      include: { category: true },
      orderBy: { date: "asc" },
    });

    // Build category summaries
    const categorySummary = buildCategorySummary(transactions);

    return NextResponse.json({
      weeklyClose,
      transactions,
      categorySummary,
      needsReviewCount: transactions.filter((t) => t.status === "needs_review").length,
      totalCount: transactions.length,
    });
  }

  // List all weeks with their status
  const weeklyCloses = await prisma.weeklyClose.findMany({
    orderBy: { weekStart: "desc" },
    take: 12,
  });

  // Find weeks with unreviewed transactions
  const pendingWeeks: Array<{ weekStart: Date; weekEnd: Date; needsReview: number; total: number }> = [];

  // Check last 8 weeks
  for (let i = 0; i < 8; i++) {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1 - i * 7); // Monday
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const existing = weeklyCloses.find(
      (wc) => new Date(wc.weekStart).getTime() === weekStart.getTime()
    );

    if (existing?.status === "confirmed") continue;

    const [needsReview, total] = await Promise.all([
      prisma.transaction.count({
        where: { date: { gte: weekStart, lte: weekEnd }, status: "needs_review" },
      }),
      prisma.transaction.count({
        where: { date: { gte: weekStart, lte: weekEnd } },
      }),
    ]);

    if (total > 0) {
      pendingWeeks.push({ weekStart, weekEnd, needsReview, total });
    }
  }

  return NextResponse.json({ weeklyCloses, pendingWeeks });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { weekStart, action } = body;

  if (!weekStart) {
    return NextResponse.json({ error: "weekStart required" }, { status: 400 });
  }

  const start = new Date(weekStart);
  const { end } = getWeekRange(start);

  if (action === "confirm") {
    // Check all transactions are reviewed
    const needsReview = await prisma.transaction.count({
      where: { date: { gte: start, lte: end }, status: "needs_review" },
    });

    if (needsReview > 0) {
      return NextResponse.json(
        { error: `${needsReview} transactions still need review` },
        { status: 400 }
      );
    }

    const totalCount = await prisma.transaction.count({
      where: { date: { gte: start, lte: end } },
    });

    const reviewedCount = await prisma.transaction.count({
      where: { date: { gte: start, lte: end }, status: "confirmed" },
    });

    // Upsert weekly close
    const weeklyClose = await prisma.weeklyClose.upsert({
      where: { weekStart: start },
      update: {
        status: "confirmed",
        confirmedAt: new Date(),
        transactionCount: totalCount,
        reviewedCount,
      },
      create: {
        weekStart: start,
        weekEnd: end,
        status: "confirmed",
        confirmedAt: new Date(),
        transactionCount: totalCount,
        reviewedCount,
      },
    });

    // Link transactions to this weekly close
    await prisma.transaction.updateMany({
      where: { date: { gte: start, lte: end } },
      data: { weeklyCloseId: weeklyClose.id },
    });

    return NextResponse.json({ success: true, weeklyClose });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

interface TransactionWithCategory {
  classification: string;
  status: string;
  amountCents: number;
  category: { id: string; name: string } | null;
}

function buildCategorySummary(transactions: TransactionWithCategory[]) {
  const summary: Record<string, {
    classification: string;
    categoryName: string | null;
    categoryId: string | null;
    inflow: number;
    outflow: number;
    total: number;
    count: number;
    needsReview: number;
    autoConfirmed: number;
  }> = {};

  for (const tx of transactions) {
    const key = tx.category?.name || tx.classification;
    if (!summary[key]) {
      summary[key] = {
        classification: tx.classification,
        categoryName: tx.category?.name || null,
        categoryId: tx.category?.id || null,
        inflow: 0,
        outflow: 0,
        total: 0,
        count: 0,
        needsReview: 0,
        autoConfirmed: 0,
      };
    }
    if (tx.amountCents > 0) {
      summary[key].inflow += tx.amountCents;
    } else {
      summary[key].outflow += Math.abs(tx.amountCents);
    }
    summary[key].total += tx.amountCents;
    summary[key].count++;
    if (tx.status === "needs_review") summary[key].needsReview++;
    if (tx.status === "auto_categorized") summary[key].autoConfirmed++;
  }

  return Object.entries(summary)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}
