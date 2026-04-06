import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const categories = await prisma.financialCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json({ categories });
}

export async function PATCH(req: NextRequest) {
  const { categoryId, costPurpose } = await req.json();

  if (!categoryId || !["cogs", "cac", "overhead"].includes(costPurpose)) {
    return NextResponse.json({ error: "Invalid categoryId or costPurpose" }, { status: 400 });
  }

  const updated = await prisma.financialCategory.update({
    where: { id: categoryId },
    data: { costPurpose },
  });

  return NextResponse.json({ updated });
}
