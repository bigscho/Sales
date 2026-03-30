import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generatePayroll } from "@/lib/payroll";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  const payrollRun = await prisma.payrollRun.findFirst({
    where: { weekId },
    orderBy: { createdAt: "desc" },
    include: {
      lineItems: {
        include: { teamMember: true },
        orderBy: { teamMember: { name: "asc" } },
      },
    },
  });

  return NextResponse.json({ payrollRun });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { weekId, action } = body;

  if (action === "generate") {
    const payrollRun = await generatePayroll(weekId);
    return NextResponse.json({ payrollRun });
  }

  if (action === "confirm") {
    const { payrollRunId } = body;
    const payrollRun = await prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: { status: "confirmed", confirmedAt: new Date() },
      include: { lineItems: { include: { teamMember: true } } },
    });
    return NextResponse.json({ payrollRun });
  }

  if (action === "mark_paid") {
    const { payrollRunId } = body;
    const payrollRun = await prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: { status: "paid" },
      include: { lineItems: { include: { teamMember: true } } },
    });
    return NextResponse.json({ payrollRun });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
