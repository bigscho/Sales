import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";
import { matchPaymentToDemo } from "@/lib/matching";

// Determine if payment is misc (not a real sale)
function isMiscPayment(description: string | null): boolean {
  const desc = (description || "").toLowerCase();
  const miscPatterns = ["delay fee", "adjustment", "credit"];
  return miscPatterns.some((p) => desc.includes(p));
}

// Check if a payment intent is actually from a subscription by looking up the invoice
async function checkSubscriptionViaInvoice(
  invoiceId: string | null,
  stripeKey: string
): Promise<{ isSubscription: boolean; subscriptionId: string | null }> {
  if (!invoiceId) return { isSubscription: false, subscriptionId: null };

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey);
    const invoice = await stripe.invoices.retrieve(invoiceId);

    // Only a real subscription if the invoice has a subscription attached
    const invoiceData = invoice as unknown as Record<string, unknown>;
    if (invoiceData.subscription) {
      const subId = typeof invoiceData.subscription === "string"
        ? invoiceData.subscription
        : (invoiceData.subscription as Record<string, string>).id;
      return { isSubscription: true, subscriptionId: subId };
    }

    return { isSubscription: false, subscriptionId: null };
  } catch {
    // If invoice lookup fails, don't assume subscription
    return { isSubscription: false, subscriptionId: null };
  }
}

// Check Stripe for prior payments from this customer to determine new vs returning
async function classifyNewVsReturning(
  customerId: string | null,
  currentPiId: string,
): Promise<"new" | "returning" | "unknown"> {
  if (!customerId || !process.env.STRIPE_SECRET_KEY) return "unknown";

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Check for any prior succeeded payments from this customer
    const priorPayments = await stripe.paymentIntents.list({
      customer: customerId,
      limit: 5,
    });

    // Filter to succeeded payments that aren't the current one
    const priorSucceeded = priorPayments.data.filter(
      (pi) => pi.id !== currentPiId && pi.status === "succeeded"
    );

    return priorSucceeded.length > 0 ? "returning" : "new";
  } catch {
    return "unknown";
  }
}

// Assign a weekId based on payment date
async function assignWeek(paidAt: Date): Promise<string> {
  const { start, end } = getWeekRange(paidAt);
  const week = await prisma.week.upsert({
    where: { weekStart: start },
    create: { weekStart: start, weekEnd: end },
    update: {},
  });
  return week.id;
}

// Try to auto-match payment to a demo and create/link a deal
async function autoMatchAndLink(paymentId: string, payment: {
  customerName: string | null;
  customerEmail: string | null;
  amountCents: number;
}) {
  const match = await matchPaymentToDemo({
    customerName: payment.customerName,
    customerEmail: payment.customerEmail,
  });

  if (match.demoId && match.result.type === "auto_matched") {
    // Find or create a deal for this demo
    let deal = await prisma.deal.findUnique({ where: { demoId: match.demoId } });

    if (!deal) {
      const demo = await prisma.demo.findUnique({
        where: { id: match.demoId },
        include: { booking: true, closer: true },
      });
      if (demo) {
        deal = await prisma.deal.create({
          data: {
            demoId: demo.id,
            weekId: demo.weekId,
            closerId: demo.closerId,
            prospectName: demo.booking.prospectName,
            prospectEmail: demo.booking.prospectEmail,
            status: "closed_won",
            closedAt: new Date(),
            month1Cash: payment.amountCents,
            // Fed vs self-sourced was fixed when the demo was booked — the deal
            // carries it so closer commission reads it without re-deriving.
            leadSource: demo.booking.leadSource,
          },
        });

        // Auto-confirm demo as showed if still pending
        if (demo.status === "pending") {
          await prisma.demo.update({
            where: { id: demo.id },
            data: {
              status: "showed",
              confirmedBy: "payment_auto",
              confirmedAt: new Date(),
            },
          });
        }
      }
    }

    if (deal) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          dealId: deal.id,
          matchStatus: "matched",
          matchReason: match.result.reason,
        },
      });
      return { matched: true, dealId: deal.id, closerId: deal.closerId, reason: match.result.reason };
    }
  }

  // No match or low confidence
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      matchStatus: match.result.type === "needs_review" ? "needs_review" : "unmatched",
      matchReason: match.result.reason,
    },
  });
  return { matched: false, closerId: null, reason: match.result.reason };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const eventType = body.type;
    const data = body.data?.object;

    if (!data) {
      return NextResponse.json({ error: "No data object" }, { status: 400 });
    }

    // === payment_intent.succeeded ===
    if (eventType === "payment_intent.succeeded") {
      const piId = data.id;
      const amount = data.amount;
      const currency = data.currency || "usd";
      const customerId = data.customer;
      const created = data.created;
      const description = data.description;
      const invoice = data.invoice; // present for invoice-based payments (may or may not be subscription)

      // Check if already recorded
      const existing = await prisma.payment.findUnique({
        where: { stripePaymentIntentId: piId },
      });
      if (existing) {
        return NextResponse.json({ received: true, action: "duplicate_skipped" });
      }

      // Check if this is actually a subscription payment
      // Method 1: Check via invoice → subscription link
      let subCheck = process.env.STRIPE_SECRET_KEY
        ? await checkSubscriptionViaInvoice(invoice, process.env.STRIPE_SECRET_KEY)
        : { isSubscription: false, subscriptionId: null };

      // Method 2: If no invoice link, check if customer has a subscription matching this amount
      if (!subCheck.isSubscription && customerId && process.env.STRIPE_SECRET_KEY) {
        try {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const customerSubs = await stripe.subscriptions.list({
            customer: customerId,
            limit: 10,
          });
          for (const sub of customerSubs.data) {
            let subAmount = 0;
            for (const item of sub.items.data) {
              subAmount += (item.price.unit_amount || 0) * (item.quantity || 1);
            }
            if (subAmount === amount) {
              subCheck = { isSubscription: true, subscriptionId: sub.id };
              break;
            }
          }
        } catch {
          // Subscription lookup failed
        }
      }

      const isMisc = isMiscPayment(description);

      // Get customer details
      let customerName: string | null = null;
      let customerEmail: string | null = data.receipt_email || null;

      if (customerId && process.env.STRIPE_SECRET_KEY) {
        try {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const customer = await stripe.customers.retrieve(customerId);
          if (!("deleted" in customer && customer.deleted)) {
            customerName = customer.name || null;
            customerEmail = customer.email || customerEmail;
          }
        } catch {
          // Customer lookup failed
        }
      }

      // Use description as fallback for customer name (but not "Subscription creation" etc.)
      if (!customerName && description && !description.toLowerCase().includes("subscription")) {
        customerName = description;
      }

      // Revenue type: determined by actual subscription check, not invoice heuristic
      const revenueType = isMisc ? "misc" : subCheck.isSubscription ? "mrr" : "one_time";

      // Customer status: new vs returning (check Stripe payment history)
      const customerStatus = isMisc ? "unknown" : await classifyNewVsReturning(customerId, piId);

      const paidAt = new Date(created * 1000);

      // Assign to correct week
      const weekId = await assignWeek(paidAt);

      // Create payment record
      const payment = await prisma.payment.create({
        data: {
          stripePaymentIntentId: piId,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subCheck.subscriptionId,
          weekId,
          amountCents: amount,
          currency,
          status: "succeeded",
          paidAt,
          isMonth1: true,
          isSubscription: subCheck.isSubscription,
          revenueType,
          customerStatus,
          customerName,
          customerEmail,
        },
      });

      // Auto-match to demo/deal
      const matchResult = await autoMatchAndLink(payment.id, {
        customerName,
        customerEmail,
        amountCents: amount,
      });

      // Audit log
      await prisma.auditLog.create({
        data: {
          entityType: "payment",
          entityId: payment.id,
          action: "stripe_webhook_created",
          newValue: JSON.stringify({
            piId, amount, customer: customerName,
            revenueType, customerStatus, isSubscription: subCheck.isSubscription,
            subscriptionId: subCheck.subscriptionId,
            matched: matchResult.matched,
          }),
          performedBy: "stripe_webhook",
        },
      });

      // Send Slack notifications
      try {
        const { sendSlackTeam, sendSlackCEO } = await import("@/lib/slack");
        const amountStr = `$${(amount / 100).toFixed(2)}`;
        const typeLabel = revenueType === "mrr" ? "MRR" : revenueType === "one_time" ? "One-time" : "Misc";
        const statusLabel = customerStatus === "new" ? "🆕 New" : customerStatus === "returning" ? "🔄 Returning" : "";
        const matchLabel = matchResult.matched ? " → matched to deal" : "";
        const message = `💰 ${statusLabel} ${typeLabel}: ${amountStr} from ${customerName || customerEmail || "Unknown"}${matchLabel}`;

        // #sales-team gets everything
        await sendSlackTeam(message);

        // CEO gets all revenue notifications
        await sendSlackCEO(message);
      } catch { /* Slack not configured */ }

      // Closer channel — only new revenue (not returning)
      if (customerStatus === "new") {
        try {
          const { sendCloseNotification } = await import("@/lib/setter-game");
          await sendCloseNotification(amount, customerName || customerEmail, matchResult.closerId, revenueType, customerStatus);
        } catch { /* closer notification failed */ }
      }

      return NextResponse.json({
        received: true,
        action: "created",
        payment: {
          id: payment.id,
          amount,
          customer: customerName,
          revenueType,
          customerStatus,
          isSubscription: subCheck.isSubscription,
          subscriptionId: subCheck.subscriptionId,
          matched: matchResult.matched,
        },
      });
    }

    // === payment_intent.payment_failed ===
    if (eventType === "payment_intent.payment_failed") {
      const piId = data.id;
      const existing = await prisma.payment.findUnique({
        where: { stripePaymentIntentId: piId },
      });
      if (existing) {
        await prisma.payment.update({
          where: { id: existing.id },
          data: { status: "failed" },
        });
      }
      return NextResponse.json({ received: true, action: "marked_failed" });
    }

    // === charge.refunded (full or partial) ===
    if (eventType === "charge.refunded") {
      const piId = data.payment_intent;
      const amountRefunded = data.amount_refunded; // total refunded in cents
      const totalAmount = data.amount; // original charge amount

      if (piId) {
        const existing = await prisma.payment.findUnique({
          where: { stripePaymentIntentId: piId },
        });

        if (existing) {
          const isFullRefund = amountRefunded >= totalAmount;
          await prisma.payment.update({
            where: { id: existing.id },
            data: {
              refundedCents: amountRefunded,
              status: isFullRefund ? "refunded" : "partially_refunded",
              // First refund timestamp only — keeps the 60-day clawback window
              // anchored to when the money actually went back.
              refundedAt: existing.refundedAt || new Date(),
            },
          });

          // Audit log
          await prisma.auditLog.create({
            data: {
              entityType: "payment",
              entityId: existing.id,
              action: "stripe_refund",
              newValue: JSON.stringify({
                piId,
                amountRefunded,
                totalAmount,
                isFullRefund,
                customer: existing.customerName,
              }),
              performedBy: "stripe_webhook",
            },
          });

          // Slack alert for refunds
          try {
            const { sendSlackCEO } = await import("@/lib/slack");
            const refundStr = `$${(amountRefunded / 100).toFixed(2)}`;
            const label = isFullRefund ? "Full refund" : "Partial refund";
            await sendSlackCEO(`⚠️ ${label}: ${refundStr} for ${existing.customerName || existing.customerEmail || "Unknown"}`);
          } catch { /* Slack not configured */ }
        }
      }

      return NextResponse.json({ received: true, action: "refund_recorded" });
    }

    // === charge.dispute.created ===
    if (eventType === "charge.dispute.created") {
      const piId = data.payment_intent;
      const disputeAmount = data.amount;
      const reason = data.reason;

      if (piId) {
        const existing = await prisma.payment.findUnique({
          where: { stripePaymentIntentId: piId },
        });

        if (existing) {
          await prisma.payment.update({
            where: { id: existing.id },
            data: { status: "disputed" },
          });

          // Audit log
          await prisma.auditLog.create({
            data: {
              entityType: "payment",
              entityId: existing.id,
              action: "stripe_dispute",
              newValue: JSON.stringify({
                piId,
                disputeAmount,
                reason,
                customer: existing.customerName,
              }),
              performedBy: "stripe_webhook",
            },
          });

          // Slack alert — disputes are urgent
          try {
            const { sendSlackCEO, sendSlackTeam } = await import("@/lib/slack");
            const amountStr = `$${(disputeAmount / 100).toFixed(2)}`;
            const msg = `🚨 DISPUTE: ${amountStr} from ${existing.customerName || existing.customerEmail || "Unknown"} — Reason: ${reason || "unknown"}`;
            await sendSlackCEO(msg);
            await sendSlackTeam(msg);
          } catch { /* Slack not configured */ }
        }
      }

      return NextResponse.json({ received: true, action: "dispute_recorded" });
    }

    // === charge.dispute.closed ===
    if (eventType === "charge.dispute.closed") {
      const piId = data.payment_intent;
      const disputeStatus = data.status; // won | lost | warning_closed

      if (piId) {
        const existing = await prisma.payment.findUnique({
          where: { stripePaymentIntentId: piId },
        });

        if (existing) {
          // If we won the dispute, restore to succeeded
          const newStatus = disputeStatus === "won" ? "succeeded" : "refunded";
          const refundedCents = disputeStatus === "won" ? existing.refundedCents : existing.amountCents;

          await prisma.payment.update({
            where: { id: existing.id },
            data: {
              status: newStatus,
              refundedCents,
              // A lost dispute is a reversal for clawback purposes too
              ...(disputeStatus !== "won" ? { refundedAt: existing.refundedAt || new Date() } : {}),
            },
          });

          try {
            const { sendSlackCEO } = await import("@/lib/slack");
            const outcome = disputeStatus === "won" ? "✅ WON" : "❌ LOST";
            await sendSlackCEO(`Dispute ${outcome} for ${existing.customerName || "Unknown"} ($${(existing.amountCents / 100).toFixed(2)})`);
          } catch { /* Slack not configured */ }
        }
      }

      return NextResponse.json({ received: true, action: "dispute_closed" });
    }

    // === customer.subscription.created ===
    if (eventType === "customer.subscription.created") {
      const subRaw = data as Record<string, unknown>;
      const customerId = typeof subRaw.customer === "string" ? subRaw.customer : null;

      // Calculate MRR from subscription items
      let mrrAmount = 0;
      const items = (subRaw.items as Record<string, unknown>)?.data as Array<Record<string, unknown>> || [];
      for (const item of items) {
        const price = item.price as Record<string, unknown>;
        const recurring = price?.recurring as Record<string, unknown> | null;
        const unitAmount = (price?.unit_amount as number) || 0;
        const quantity = (item.quantity as number) || 1;
        if (recurring?.interval === "month") {
          mrrAmount += unitAmount * quantity;
        } else if (recurring?.interval === "year") {
          mrrAmount += Math.round((unitAmount * quantity) / 12);
        }
      }

      // Get customer name
      let clientName = "Unknown";
      if (customerId && process.env.STRIPE_SECRET_KEY) {
        try {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const customer = await stripe.customers.retrieve(customerId);
          if (!("deleted" in customer && customer.deleted)) {
            clientName = customer.name || customer.email || "Unknown";
          }
        } catch { /* customer lookup failed */ }
      }

      // Create MRR event
      await prisma.mrrEvent.create({
        data: {
          type: "new_subscription",
          clientName,
          mrrAmountCents: mrrAmount,
          effectiveDate: new Date(),
          stripeSubscriptionId: data.id,
        },
      });

      try {
        const { sendSlackCEO } = await import("@/lib/slack");
        await sendSlackCEO(`📈 New subscription: ${clientName} at $${(mrrAmount / 100).toFixed(2)}/mo`);
      } catch { /* Slack not configured */ }

      return NextResponse.json({ received: true, action: "subscription_created", clientName, mrr: mrrAmount });
    }

    // === customer.subscription.deleted (CHURN) ===
    if (eventType === "customer.subscription.deleted") {
      const subRaw = data as Record<string, unknown>;
      const customerId = typeof subRaw.customer === "string" ? subRaw.customer : null;

      // Calculate MRR lost
      let mrrAmount = 0;
      const items = (subRaw.items as Record<string, unknown>)?.data as Array<Record<string, unknown>> || [];
      for (const item of items) {
        const price = item.price as Record<string, unknown>;
        const recurring = price?.recurring as Record<string, unknown> | null;
        const unitAmount = (price?.unit_amount as number) || 0;
        const quantity = (item.quantity as number) || 1;
        if (recurring?.interval === "month") {
          mrrAmount += unitAmount * quantity;
        } else if (recurring?.interval === "year") {
          mrrAmount += Math.round((unitAmount * quantity) / 12);
        }
      }

      let clientName = "Unknown";
      if (customerId && process.env.STRIPE_SECRET_KEY) {
        try {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const customer = await stripe.customers.retrieve(customerId);
          if (!("deleted" in customer && customer.deleted)) {
            clientName = customer.name || customer.email || "Unknown";
          }
        } catch { /* customer lookup failed */ }
      }

      await prisma.mrrEvent.create({
        data: {
          type: "churn",
          clientName,
          mrrAmountCents: mrrAmount,
          effectiveDate: new Date(),
          stripeSubscriptionId: data.id,
        },
      });

      try {
        const { sendSlackCEO, sendSlackTeam } = await import("@/lib/slack");
        const msg = `🔴 Churn: ${clientName} canceled — lost $${(mrrAmount / 100).toFixed(2)}/mo MRR`;
        await sendSlackCEO(msg);
        await sendSlackTeam(msg);
      } catch { /* Slack not configured */ }

      return NextResponse.json({ received: true, action: "subscription_churned", clientName, mrrLost: mrrAmount });
    }

    // === customer.subscription.updated (downgrades, cancel_at_period_end, etc.) ===
    if (eventType === "customer.subscription.updated") {
      const subRaw = data as Record<string, unknown>;
      const previousAttributes = (body.data?.previous_attributes || {}) as Record<string, unknown>;
      const customerId = typeof subRaw.customer === "string" ? subRaw.customer : null;

      let clientName = "Unknown";
      if (customerId && process.env.STRIPE_SECRET_KEY) {
        try {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const customer = await stripe.customers.retrieve(customerId);
          if (!("deleted" in customer && customer.deleted)) {
            clientName = customer.name || customer.email || "Unknown";
          }
        } catch { /* customer lookup failed */ }
      }

      // Detect cancel_at_period_end being set (early warning of churn)
      if (subRaw.cancel_at_period_end === true && previousAttributes.cancel_at_period_end === false) {
        try {
          const { sendSlackCEO } = await import("@/lib/slack");
          await sendSlackCEO(`⚠️ ${clientName} set to cancel at period end — churn incoming`);
        } catch { /* Slack not configured */ }
      }

      return NextResponse.json({ received: true, action: "subscription_updated" });
    }

    // === customer.subscription.paused ===
    if (eventType === "customer.subscription.paused") {
      return NextResponse.json({ received: true, action: "subscription_paused" });
    }

    // === customer.subscription.resumed ===
    if (eventType === "customer.subscription.resumed") {
      return NextResponse.json({ received: true, action: "subscription_resumed" });
    }

    return NextResponse.json({ received: true, action: "unhandled_event", type: eventType });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", webhook: "stripe" });
}
