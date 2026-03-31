import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { paymentId, revenueTypeOverride, customerStatusOverride } = body;

  if (!paymentId) {
    return NextResponse.json({ error: "paymentId required" }, { status: 400 });
  }

  const updates: Record<string, string> = {};
  if (revenueTypeOverride !== undefined) {
    if (!["mrr", "one_time", "misc", null].includes(revenueTypeOverride)) {
      return NextResponse.json({ error: "Invalid revenueTypeOverride" }, { status: 400 });
    }
    updates.revenueTypeOverride = revenueTypeOverride;
  }
  if (customerStatusOverride !== undefined) {
    if (!["new", "returning", "misc", null].includes(customerStatusOverride)) {
      return NextResponse.json({ error: "Invalid customerStatusOverride" }, { status: 400 });
    }
    updates.customerStatusOverride = customerStatusOverride;
  }

  const payment = await prisma.payment.update({
    where: { id: paymentId },
    data: updates,
  });

  return NextResponse.json({ payment });
}
