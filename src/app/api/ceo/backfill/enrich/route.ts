import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Re-enrich payments that have missing customer info
// Looks up customer name/email and subscription status from Stripe
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

  // Find payments with missing customer info
  const payments = await prisma.payment.findMany({
    where: {
      paidAt: { gte: startDate, lte: endDate },
      OR: [
        { customerName: null },
        { customerName: "" },
        { customerName: "Unknown" },
      ],
    },
  });

  const results: Array<{
    id: string;
    piId: string | null;
    oldName: string | null;
    newName: string | null;
    newEmail: string | null;
    amount: number;
    oldRevenueType: string;
    newRevenueType: string;
    oldStatus: string;
    newStatus: string;
    subscriptionId: string | null;
    action: string;
  }> = [];

  for (const payment of payments) {
    if (!payment.stripePaymentIntentId) {
      results.push({
        id: payment.id,
        piId: null,
        oldName: payment.customerName,
        newName: null,
        newEmail: null,
        amount: payment.amountCents,
        oldRevenueType: payment.revenueType,
        newRevenueType: payment.revenueType,
        oldStatus: payment.status,
        newStatus: payment.status,
        subscriptionId: null,
        action: "no_pi_id",
      });
      continue;
    }

    try {
      // Look up the payment intent from Stripe
      const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      const customerId = typeof pi.customer === "string" ? pi.customer : pi.customer?.id || null;

      let customerName: string | null = null;
      let customerEmail: string | null = null;

      if (customerId) {
        try {
          const customer = await stripe.customers.retrieve(customerId);
          if (!("deleted" in customer && customer.deleted)) {
            customerName = customer.name || null;
            customerEmail = customer.email || null;
          }
        } catch { /* customer lookup failed */ }
      }

      if (!customerName && pi.description && !pi.description.toLowerCase().includes("subscription")) {
        customerName = pi.description;
      }

      // Check subscription status via charge
      let isSubscription = payment.isSubscription;
      let subscriptionId = payment.stripeSubscriptionId;
      let revenueType = payment.revenueType;

      if (!isSubscription) {
        // Method 1: Check charge for invoice
        try {
          const charges = await stripe.charges.list({ payment_intent: payment.stripePaymentIntentId, limit: 1 });
          if (charges.data.length > 0) {
            const charge = charges.data[0] as unknown as Record<string, unknown>;
            const chargeInvoice = typeof charge.invoice === "string" ? charge.invoice
              : (charge.invoice as Record<string, string> | null)?.id || null;
            if (chargeInvoice) {
              try {
                const invoice = await stripe.invoices.retrieve(chargeInvoice);
                const invoiceData = invoice as unknown as Record<string, unknown>;
                if (invoiceData.subscription) {
                  isSubscription = true;
                  subscriptionId = typeof invoiceData.subscription === "string"
                    ? invoiceData.subscription
                    : (invoiceData.subscription as Record<string, string>).id;
                  revenueType = "mrr";
                }
              } catch { /* invoice lookup failed */ }
            }
          }
        } catch { /* charge lookup failed */ }

        // Method 2: Check customer subscriptions
        if (!isSubscription && customerId) {
          try {
            const customerSubs = await stripe.subscriptions.list({
              customer: customerId,
              status: "all" as "active",
              limit: 20,
            });
            for (const sub of customerSubs.data) {
              let subAmount = 0;
              for (const item of sub.items.data) {
                subAmount += (item.price.unit_amount || 0) * (item.quantity || 1);
              }
              if (subAmount === payment.amountCents) {
                isSubscription = true;
                subscriptionId = sub.id;
                revenueType = "mrr";
                break;
              }
            }
          } catch { /* subscription lookup failed */ }
        }
      }

      // Check actual payment status from Stripe
      const stripeStatus = pi.status === "succeeded" ? "succeeded"
        : pi.status === "canceled" ? "failed"
        : pi.status;

      // Check for refunds
      let refundedCents = 0;
      try {
        const charges = await stripe.charges.list({ payment_intent: payment.stripePaymentIntentId, limit: 1 });
        if (charges.data.length > 0) {
          const charge = charges.data[0] as unknown as Record<string, unknown>;
          refundedCents = (charge.amount_refunded as number) || 0;
        }
      } catch { /* charge lookup failed */ }

      const isFullyRefunded = refundedCents >= payment.amountCents;
      let newStatus = stripeStatus;
      if (isFullyRefunded) newStatus = "refunded";
      else if (refundedCents > 0) newStatus = "partially_refunded";

      // Determine new vs returning
      let customerStatus = payment.customerStatus;
      if (customerStatus === "unknown" && customerId) {
        try {
          const priorPayments = await stripe.paymentIntents.list({ customer: customerId, limit: 5 });
          const priorSucceeded = priorPayments.data.filter(
            (p) => p.id !== payment.stripePaymentIntentId && p.status === "succeeded" && p.created < Math.floor(payment.paidAt.getTime() / 1000)
          );
          customerStatus = priorSucceeded.length > 0 ? "returning" : "new";
        } catch {
          customerStatus = "unknown";
        }
      }

      if (!dryRun) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            customerName: customerName || payment.customerName,
            customerEmail: customerEmail || payment.customerEmail,
            stripeCustomerId: customerId || payment.stripeCustomerId,
            isSubscription,
            stripeSubscriptionId: subscriptionId,
            revenueType,
            status: newStatus,
            refundedCents,
            customerStatus,
          },
        });
      }

      results.push({
        id: payment.id,
        piId: payment.stripePaymentIntentId,
        oldName: payment.customerName,
        newName: customerName,
        newEmail: customerEmail,
        amount: payment.amountCents,
        oldRevenueType: payment.revenueType,
        newRevenueType: revenueType,
        oldStatus: payment.status,
        newStatus,
        subscriptionId,
        action: dryRun ? "dry_run" : "enriched",
      });
    } catch (err) {
      results.push({
        id: payment.id,
        piId: payment.stripePaymentIntentId,
        oldName: payment.customerName,
        newName: null,
        newEmail: null,
        amount: payment.amountCents,
        oldRevenueType: payment.revenueType,
        newRevenueType: payment.revenueType,
        oldStatus: payment.status,
        newStatus: payment.status,
        subscriptionId: null,
        action: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return NextResponse.json({
    period: { month, year },
    dryRun,
    total: payments.length,
    results,
  });
}
