import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

// Backfill Stripe payments for a specific date range
// Usage: POST /api/ceo/backfill { "startDate": "2026-03-01", "endDate": "2026-03-03" }
// Optionally: { "dryRun": true } to preview without creating records
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { startDate, endDate, dryRun = false } = body;

  if (!startDate || !endDate) {
    return NextResponse.json({ error: "startDate and endDate required (YYYY-MM-DD)" }, { status: 400 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "STRIPE_SECRET_KEY not set" }, { status: 400 });
  }

  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T23:59:59Z");

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD" }, { status: 400 });
  }

  // Safety: max 7 days per batch
  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff > 7) {
    return NextResponse.json({ error: "Max 7 days per batch for safe auditing" }, { status: 400 });
  }

  let Stripe: typeof import("stripe").default;
  let stripe: InstanceType<typeof Stripe>;
  try {
    Stripe = (await import("stripe")).default;
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    // Quick test to catch bad API keys early
    await stripe.balance.retrieve();
  } catch (err) {
    return NextResponse.json({
      error: `Stripe API key invalid or unreachable: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 400 });
  }

  // Pull all succeeded payment intents in the date range
  const paymentIntents: Array<{
    id: string;
    amount: number;
    currency: string;
    customer: string | null;
    description: string | null;
    invoice: string | null;
    created: number;
    status: string;
  }> = [];

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Record<string, unknown> = {
      limit: 100,
      expand: ["data.invoice"],
      created: {
        gte: Math.floor(start.getTime() / 1000),
        lte: Math.floor(end.getTime() / 1000),
      },
    };
    if (startingAfter) params.starting_after = startingAfter;

    const batch = await stripe.paymentIntents.list(
      params as Parameters<typeof stripe.paymentIntents.list>[0]
    );

    for (const pi of batch.data) {
      if (pi.status === "succeeded") {
        // Extract invoice — could be string ID, expanded object, or null
        const piAny = pi as unknown as Record<string, unknown>;
        let invoiceId: string | null = null;
        if (typeof piAny.invoice === "string") {
          invoiceId = piAny.invoice;
        } else if (piAny.invoice && typeof piAny.invoice === "object") {
          invoiceId = (piAny.invoice as Record<string, string>).id || null;
        }

        paymentIntents.push({
          id: pi.id,
          amount: pi.amount,
          currency: pi.currency || "usd",
          customer: typeof pi.customer === "string" ? pi.customer : pi.customer?.id || null,
          description: pi.description,
          invoice: invoiceId,
          created: pi.created,
          status: pi.status,
        });
      }
    }

    hasMore = batch.has_more;
    if (batch.data.length > 0) {
      startingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  // Also pull refunds in this date range
  const refunds: Array<{
    id: string;
    paymentIntent: string | null;
    amount: number;
    created: number;
  }> = [];

  let refundHasMore = true;
  let refundStartingAfter: string | undefined;

  while (refundHasMore) {
    const params: Record<string, unknown> = {
      limit: 100,
      created: {
        gte: Math.floor(start.getTime() / 1000),
        lte: Math.floor(end.getTime() / 1000),
      },
    };
    if (refundStartingAfter) params.starting_after = refundStartingAfter;

    const batch = await stripe.refunds.list(
      params as Parameters<typeof stripe.refunds.list>[0]
    );

    for (const r of batch.data) {
      refunds.push({
        id: r.id,
        paymentIntent: typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id || null,
        amount: r.amount,
        created: r.created,
      });
    }

    refundHasMore = batch.has_more;
    if (batch.data.length > 0) {
      refundStartingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  // Process each payment
  const results: Array<{
    piId: string;
    amount: number;
    customer: string | null;
    customerName: string | null;
    customerEmail: string | null;
    date: string;
    revenueType: string;
    customerStatus: string;
    isSubscription: boolean;
    subscriptionId: string | null;
    refundedCents: number;
    action: string; // created | skipped_duplicate | dry_run
    confidence: "high" | "medium" | "low";
    flags: string[];
  }> = [];

  for (const pi of paymentIntents) {
    // Check if already in our DB
    const existing = await prisma.payment.findUnique({
      where: { stripePaymentIntentId: pi.id },
    });

    if (existing) {
      results.push({
        piId: pi.id,
        amount: pi.amount,
        customer: pi.customer,
        customerName: existing.customerName,
        customerEmail: existing.customerEmail,
        date: new Date(pi.created * 1000).toISOString(),
        revenueType: existing.revenueType,
        customerStatus: existing.customerStatus,
        isSubscription: existing.isSubscription,
        subscriptionId: existing.stripeSubscriptionId,
        refundedCents: existing.refundedCents,
        action: "skipped_duplicate",
        confidence: "high",
        flags: [],
      });
      continue;
    }

    // Check if this is a real subscription payment
    // Method 1: Check via invoice → subscription link
    let isSubscription = false;
    let subscriptionId: string | null = null;

    if (pi.invoice) {
      try {
        const invoice = await stripe.invoices.retrieve(pi.invoice);
        const invoiceData = invoice as unknown as Record<string, unknown>;
        if (invoiceData.subscription) {
          isSubscription = true;
          subscriptionId = typeof invoiceData.subscription === "string"
            ? invoiceData.subscription
            : (invoiceData.subscription as Record<string, string>).id;
        }
      } catch {
        // Invoice lookup failed
      }
    }

    // Method 2: If no invoice link found, check if customer has subscriptions
    // and if this payment amount matches a subscription price
    if (!isSubscription && pi.customer) {
      try {
        const customerSubs = await stripe.subscriptions.list({
          customer: pi.customer,
          limit: 10,
        });

        for (const sub of customerSubs.data) {
          // Check if any subscription's recurring amount matches this payment
          let subAmount = 0;
          for (const item of sub.items.data) {
            subAmount += (item.price.unit_amount || 0) * (item.quantity || 1);
          }

          if (subAmount === pi.amount) {
            isSubscription = true;
            subscriptionId = sub.id;
            break;
          }
        }
      } catch {
        // Subscription lookup failed
      }
    }

    // Get customer details
    let customerName: string | null = null;
    let customerEmail: string | null = null;

    if (pi.customer) {
      try {
        const customer = await stripe.customers.retrieve(pi.customer);
        if (!("deleted" in customer && customer.deleted)) {
          customerName = customer.name || null;
          customerEmail = customer.email || null;
        }
      } catch {
        // Customer lookup failed
      }
    }

    if (!customerName && pi.description && !pi.description.toLowerCase().includes("subscription")) {
      customerName = pi.description;
    }

    // Classify
    const isMisc = ["delay fee", "adjustment", "credit"].some(
      (p) => (pi.description || "").toLowerCase().includes(p)
    );
    const revenueType = isMisc ? "misc" : isSubscription ? "mrr" : "one_time";

    // New vs returning
    let customerStatus: "new" | "returning" | "unknown" = "unknown";
    if (pi.customer && !isMisc) {
      try {
        const priorPayments = await stripe.paymentIntents.list({
          customer: pi.customer,
          limit: 5,
        });
        const priorSucceeded = priorPayments.data.filter(
          (p) => p.id !== pi.id && p.status === "succeeded" && p.created < pi.created
        );
        customerStatus = priorSucceeded.length > 0 ? "returning" : "new";
      } catch {
        customerStatus = "unknown";
      }
    }

    // Check for refunds on this payment
    const piRefunds = refunds.filter((r) => r.paymentIntent === pi.id);
    const refundedCents = piRefunds.reduce((sum, r) => sum + r.amount, 0);
    const isFullyRefunded = refundedCents >= pi.amount;

    const paidAt = new Date(pi.created * 1000);

    // Build confidence and flags
    const flags: string[] = [];

    if (!customerName && !customerEmail) {
      flags.push("NO_CUSTOMER_INFO: no name or email found in Stripe");
    }
    if (customerStatus === "unknown") {
      flags.push("UNKNOWN_STATUS: couldn't determine new vs returning");
    }
    if (pi.invoice && !isSubscription) {
      flags.push("INVOICE_BUT_NOT_SUBSCRIPTION: has invoice but no subscription attached — verify this is really one-time");
    }
    if (refundedCents > 0 && !isFullyRefunded) {
      flags.push(`PARTIAL_REFUND: $${(refundedCents / 100).toFixed(2)} of $${(pi.amount / 100).toFixed(2)} refunded`);
    }
    if (isFullyRefunded) {
      flags.push("FULLY_REFUNDED: entire payment was refunded");
    }
    if (isMisc) {
      flags.push("MISC_PAYMENT: classified as non-revenue (fee, adjustment, credit)");
    }
    if (isSubscription && pi.amount > 500000) {
      flags.push("LARGE_SUBSCRIPTION: subscription payment over $5,000 — verify amount");
    }

    const confidence: "high" | "medium" | "low" =
      flags.length === 0 ? "high" :
      flags.some(f => f.startsWith("NO_CUSTOMER") || f.startsWith("UNKNOWN_STATUS") || f.startsWith("INVOICE_BUT")) ? "low" :
      "medium";

    if (dryRun) {
      results.push({
        piId: pi.id,
        amount: pi.amount,
        customer: pi.customer,
        customerName,
        customerEmail,
        date: paidAt.toISOString(),
        revenueType,
        customerStatus,
        isSubscription,
        subscriptionId,
        refundedCents,
        action: "dry_run",
        confidence,
        flags,
      });
      continue;
    }

    // Create the payment record
    const { start: weekStart, end: weekEnd } = getWeekRange(paidAt);
    const week = await prisma.week.upsert({
      where: { weekStart },
      create: { weekStart, weekEnd },
      update: {},
    });

    let status = "succeeded";
    if (isFullyRefunded) status = "refunded";
    else if (refundedCents > 0) status = "partially_refunded";

    await prisma.payment.create({
      data: {
        stripePaymentIntentId: pi.id,
        stripeCustomerId: pi.customer,
        stripeSubscriptionId: subscriptionId,
        weekId: week.id,
        amountCents: pi.amount,
        refundedCents,
        currency: pi.currency,
        status,
        paidAt,
        isMonth1: true,
        isSubscription,
        revenueType,
        customerStatus,
        customerName,
        customerEmail,
      },
    });

    results.push({
      piId: pi.id,
      amount: pi.amount,
      customer: pi.customer,
      customerName,
      customerEmail,
      date: paidAt.toISOString(),
      revenueType,
      customerStatus,
      isSubscription,
      subscriptionId,
      refundedCents,
      action: "created",
      confidence,
      flags,
    });
  }

  const created = results.filter((r) => r.action === "created").length;
  const skipped = results.filter((r) => r.action === "skipped_duplicate").length;
  const previewed = results.filter((r) => r.action === "dry_run").length;
  const needsReview = results.filter((r) => r.confidence !== "high" && r.action !== "skipped_duplicate");

  return NextResponse.json({
    period: { startDate, endDate, days: daysDiff },
    dryRun,
    summary: {
      stripePayments: paymentIntents.length,
      stripeRefunds: refunds.length,
      created,
      skipped,
      previewed,
      needsReviewCount: needsReview.length,
    },
    // Items that need your eyes — shown first
    needsReview,
    // All results
    results,
  });
}
