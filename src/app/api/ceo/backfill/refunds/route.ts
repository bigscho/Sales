import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Sync refunds for a given month — applies refunds to existing payment records
// Usage: POST /api/ceo/backfill/refunds { "month": 3, "year": 2026 }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { month, year, dryRun = false } = body;

  if (!month || !year) {
    return NextResponse.json({ error: "month and year required" }, { status: 400 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "STRIPE_SECRET_KEY not set" }, { status: 400 });
  }

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  // Pull all refunds for the month
  const refunds: Array<{
    id: string;
    paymentIntent: string | null;
    amount: number;
    created: number;
    reason: string | null;
  }> = [];

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Record<string, unknown> = {
      limit: 100,
      created: {
        gte: Math.floor(startDate.getTime() / 1000),
        lte: Math.floor(endDate.getTime() / 1000),
      },
    };
    if (startingAfter) params.starting_after = startingAfter;

    const batch = await stripe.refunds.list(
      params as Parameters<typeof stripe.refunds.list>[0]
    );

    for (const r of batch.data) {
      const rRaw = r as unknown as Record<string, unknown>;
      refunds.push({
        id: r.id,
        paymentIntent: typeof r.payment_intent === "string" ? r.payment_intent
          : (r.payment_intent as Record<string, string> | null)?.id || null,
        amount: r.amount,
        created: r.created,
        reason: (rRaw.reason as string) || null,
      });
    }

    hasMore = batch.has_more;
    if (batch.data.length > 0) {
      startingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  // Apply each refund to the matching payment
  const results: Array<{
    refundId: string;
    paymentIntent: string | null;
    refundAmount: number;
    refundDate: string;
    customerName: string | null;
    originalAmount: number;
    isFullRefund: boolean;
    action: string;
    reason: string | null;
  }> = [];

  let applied = 0;
  let alreadyApplied = 0;
  let noMatch = 0;

  for (const refund of refunds) {
    if (!refund.paymentIntent) {
      results.push({
        refundId: refund.id,
        paymentIntent: null,
        refundAmount: refund.amount,
        refundDate: new Date(refund.created * 1000).toISOString(),
        customerName: null,
        originalAmount: 0,
        isFullRefund: false,
        action: "no_payment_intent",
        reason: refund.reason,
      });
      noMatch++;
      continue;
    }

    const payment = await prisma.payment.findUnique({
      where: { stripePaymentIntentId: refund.paymentIntent },
    });

    if (!payment) {
      results.push({
        refundId: refund.id,
        paymentIntent: refund.paymentIntent,
        refundAmount: refund.amount,
        refundDate: new Date(refund.created * 1000).toISOString(),
        customerName: null,
        originalAmount: 0,
        isFullRefund: false,
        action: "payment_not_in_db",
        reason: refund.reason,
      });
      noMatch++;
      continue;
    }

    // Check if refund already applied
    if (payment.refundedCents >= refund.amount) {
      results.push({
        refundId: refund.id,
        paymentIntent: refund.paymentIntent,
        refundAmount: refund.amount,
        refundDate: new Date(refund.created * 1000).toISOString(),
        customerName: payment.customerName,
        originalAmount: payment.amountCents,
        isFullRefund: refund.amount >= payment.amountCents,
        action: "already_applied",
        reason: refund.reason,
      });
      alreadyApplied++;
      continue;
    }

    const isFullRefund = refund.amount >= payment.amountCents;

    if (!dryRun) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          refundedCents: refund.amount,
          status: isFullRefund ? "refunded" : "partially_refunded",
        },
      });
    }

    results.push({
      refundId: refund.id,
      paymentIntent: refund.paymentIntent,
      refundAmount: refund.amount,
      refundDate: new Date(refund.created * 1000).toISOString(),
      customerName: payment.customerName,
      originalAmount: payment.amountCents,
      isFullRefund,
      action: dryRun ? "dry_run" : "applied",
      reason: refund.reason,
    });
    applied++;
  }

  return NextResponse.json({
    period: { month, year },
    dryRun,
    summary: {
      totalRefunds: refunds.length,
      totalRefundedCents: refunds.reduce((sum, r) => sum + r.amount, 0),
      applied,
      alreadyApplied,
      noMatch,
    },
    results,
  });
}
