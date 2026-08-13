import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { paymentId, revenueTypeOverride, customerStatusOverride, upfrontOverride, matchToDemoId, organicCloserId, customerName, customerEmail, matchStatus } = body;

  if (!paymentId) {
    return NextResponse.json({ error: "paymentId required" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};

  if (upfrontOverride !== undefined) {
    if (!["include", "exclude", null].includes(upfrontOverride)) {
      return NextResponse.json({ error: "Invalid upfrontOverride" }, { status: 400 });
    }
    updates.upfrontOverride = upfrontOverride;
  }

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

  // Organic new revenue — no demo ever happened. Creates a demo-less
  // closed-won deal under the chosen closer and force-counts the payment
  // (upfrontOverride=include). Cash flows to landed totals, the closer's
  // scoreboard, and commission; it deliberately stays OUT of cohort
  // cash-per-call/show — no call produced it. leadSource defaults to fed
  // (§4.12b: ambiguity protects the company) — flip on /deals if it was
  // truly self-sourced.
  if (organicCloserId && !matchToDemoId) {
    const closer = await prisma.teamMember.findUnique({ where: { id: organicCloserId } });
    if (!closer) return NextResponse.json({ error: "Closer not found" }, { status: 404 });
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

    let weekId = payment.weekId;
    if (!weekId) {
      const week = await prisma.week.findFirst({
        where: { weekStart: { lte: payment.paidAt }, weekEnd: { gte: payment.paidAt } },
        orderBy: { weekStart: "desc" },
      });
      weekId = week?.id || (await prisma.week.findFirstOrThrow({ orderBy: { weekStart: "desc" } })).id;
    }

    const deal = await prisma.deal.create({
      data: {
        weekId,
        closerId: organicCloserId,
        prospectName: payment.customerName || payment.customerEmail || "Unknown",
        prospectEmail: payment.customerEmail,
        stripeCustomerId: payment.stripeCustomerId,
        dealType: "one_time",
        leadSource: "fed",
        status: "closed_won",
        closedAt: payment.paidAt,
        month1Cash: payment.amountCents,
        notes: "Organic new revenue — no demo (reconciled)",
      },
    });

    updates.dealId = deal.id;
    updates.matchStatus = "matched";
    updates.matchReason = `Organic new revenue — no demo, closer ${closer.name} (reconciled)`;
    updates.upfrontOverride = "include";
  }

  const before = await prisma.payment.findUnique({ where: { id: paymentId } });

  const payment = await prisma.payment.update({
    where: { id: paymentId },
    data: updates,
  });

  // Overrides and matches are comp-relevant (they flip cash + commission) —
  // audit WHO reconciled what (§4.11c: company records are the comp source).
  if (before && (upfrontOverride !== undefined || customerStatusOverride !== undefined || revenueTypeOverride !== undefined || matchToDemoId || organicCloserId)) {
    const session = await getSession();
    await prisma.auditLog.create({
      data: {
        entityType: "payment",
        entityId: paymentId,
        action: "payment_reconcile",
        oldValue: JSON.stringify({
          upfrontOverride: before.upfrontOverride,
          customerStatusOverride: before.customerStatusOverride,
          revenueTypeOverride: before.revenueTypeOverride,
          dealId: before.dealId,
        }),
        newValue: JSON.stringify({
          upfrontOverride: payment.upfrontOverride,
          customerStatusOverride: payment.customerStatusOverride,
          revenueTypeOverride: payment.revenueTypeOverride,
          dealId: payment.dealId,
        }),
        performedBy: session?.name || "admin",
      },
    });
  }

  return NextResponse.json({ payment });
}
