import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { categorizTransaction } from "@/lib/categorization";

// Re-run auto-categorization on transactions that are needs_review
// Usage: POST /api/ceo/transactions/recategorize { month: 3, year: 2026 }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { month, year, dryRun = false } = body;

  if (!month || !year) {
    return NextResponse.json({ error: "month and year required" }, { status: 400 });
  }

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  const transactions = await prisma.transaction.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
      status: "needs_review",
    },
  });

  let categorized = 0;
  let stillUnknown = 0;

  const results: Array<{
    merchantName: string | null;
    amountCents: number;
    classification: string;
    categoryName: string | null;
    confidence: number;
    action: string;
  }> = [];

  for (const tx of transactions) {
    const result = await categorizTransaction(tx.merchantName, tx.description);

    if (result.confidence > 0) {
      let categoryName: string | null = null;
      if (result.categoryId) {
        const cat = await prisma.financialCategory.findUnique({ where: { id: result.categoryId } });
        categoryName = cat?.name || null;
      }

      if (!dryRun) {
        await prisma.transaction.update({
          where: { id: tx.id },
          data: {
            classification: result.classification,
            categoryId: result.categoryId,
            status: result.confidence >= 0.7 ? "auto_categorized" : "needs_review",
            confidenceScore: result.confidence,
          },
        });
      }

      categorized++;
      results.push({
        merchantName: tx.merchantName,
        amountCents: tx.amountCents,
        classification: result.classification,
        categoryName,
        confidence: result.confidence,
        action: dryRun ? "dry_run" : "categorized",
      });
    } else {
      stillUnknown++;
      results.push({
        merchantName: tx.merchantName,
        amountCents: tx.amountCents,
        classification: "needs_review",
        categoryName: null,
        confidence: 0,
        action: "unknown",
      });
    }
  }

  return NextResponse.json({
    dryRun,
    total: transactions.length,
    categorized,
    stillUnknown,
    results,
  });
}
