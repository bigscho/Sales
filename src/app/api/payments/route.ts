import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { paymentId, revenueTypeOverride, customerStatusOverride, matchToDemoId, customerName, customerEmail, matchStatus } = body;

  if (!paymentId) {
    return NextResponse.json({ error: "paymentId required" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};

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

  if (customerName !== undefined) updates.customerName = customerName;
  if (customerEmail !== undefined) updates.customerEmail = customerEmail;
  if (matchStatus !== undefined) updates.matchStatus = matchStatus;

  // Match payment to a demo — link via deal
  if (matchToDemoId) {
    const demo = await prisma.demo.findUnique({
      where: { id: matchToDemoId },
      include: { booking: true, closer: true },
    });

    if (!demo) {
      return NextResponse.json({ error: "Demo not found" }, { status: 404 });
    }

    // Find or create deal for this demo
    let deal = await prisma.deal.findUnique({ where: { demoId: matchToDemoId } });
    if (!deal) {
      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      deal = await prisma.deal.create({
        data: {
          demoId: demo.id,
          weekId: demo.weekId,
          closerId: demo.closerId,
          prospectName: demo.booking.prospectName,
          prospectEmail: demo.booking.prospectEmail,
          status: "closed_won",
          closedAt: new Date(),
          month1Cash: payment?.amountCents || 0,
          leadSource: demo.booking.leadSource,
        },
      });
    }

    updates.dealId = deal.id;
    updates.matchStatus = "matched";
    updates.matchReason = `Manually matched to ${demo.booking.prospectName}`;
    updates.customerName = demo.booking.prospectName;
    updates.customerEmail = demo.booking.prospectEmail;

    // Auto-confirm demo as showed if pending
    if (demo.status === "pending") {
      await prisma.demo.update({
        where: { id: demo.id },
        data: { status: "showed", confirmedBy: "payment_match", confirmedAt: new Date() },
      });
    }
  }

  const payment = await prisma.payment.update({
    where: { id: paymentId },
    data: updates,
  });

  return NextResponse.json({ payment });
}
