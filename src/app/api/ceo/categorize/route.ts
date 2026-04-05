import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { learnMapping } from "@/lib/categorization";

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { transactionId, transactionIds, classification, categoryId, notes } = body;

  const ids = transactionIds || [transactionId];
  if (!ids.length) {
    return NextResponse.json({ error: "No transaction IDs provided" }, { status: 400 });
  }

  const updateData: Record<string, unknown> = { status: "confirmed" };
  if (classification) updateData.classification = classification;
  if (categoryId !== undefined) updateData.categoryId = categoryId || null;
  if (notes !== undefined) updateData.notes = notes;

  // Update all specified transactions
  const updated = await prisma.transaction.updateMany({
    where: { id: { in: ids } },
    data: updateData,
  });

  // Learn from the first transaction's merchant name
  if (classification && classification !== "needs_review") {
    const tx = await prisma.transaction.findFirst({
      where: { id: { in: ids }, merchantName: { not: null } },
    });
    if (tx?.merchantName) {
      await learnMapping(tx.merchantName, classification, categoryId || null);
    }
  }

  return NextResponse.json({ updated: updated.count });
}
