import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const syncLogs = await prisma.syncLog.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
  });

  const categories = await prisma.expenseCategory.findMany({
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json({ syncLogs, categories });
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.action === "add_category") {
    const maxOrder = await prisma.expenseCategory.findFirst({
      orderBy: { sortOrder: "desc" },
    });
    const category = await prisma.expenseCategory.create({
      data: {
        name: body.name,
        sortOrder: (maxOrder?.sortOrder || 0) + 1,
      },
    });
    return NextResponse.json({ category });
  }

  if (body.action === "delete_category") {
    await prisma.expenseCategory.delete({ where: { id: body.id } });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
