import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  const expenses = await prisma.expense.findMany({
    where: { weekId },
    orderBy: { date: "asc" },
  });

  const categories = await prisma.expenseCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json({ expenses, categories });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { weekId, category, vendor, description, amountCents, date, source } = body;

  const expense = await prisma.expense.create({
    data: {
      weekId,
      category,
      vendor,
      description,
      amountCents: Math.round(amountCents),
      date: new Date(date),
      source: source || "manual",
    },
  });

  return NextResponse.json({ expense });
}

export async function DELETE(request: NextRequest) {
  const { id } = await request.json();
  await prisma.expense.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
