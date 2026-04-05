import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Delete transactions by source and month
// Usage: POST /api/ceo/transactions/clear { source: "amex", month: 3, year: 2026 }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { source, month, year } = body;

  if (!source || !month || !year) {
    return NextResponse.json({ error: "source, month, and year required" }, { status: 400 });
  }

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  const deleted = await prisma.transaction.deleteMany({
    where: {
      source,
      date: { gte: startDate, lte: endDate },
    },
  });

  return NextResponse.json({ success: true, deleted: deleted.count });
}
