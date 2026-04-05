import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackCEO } from "@/lib/slack";

// Daily financial audit — runs at 7 AM ET (11 UTC)
// Compares our DB against Stripe, flags discrepancies, alerts on action items
export async function GET() {
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "STRIPE_SECRET_KEY not set" }, { status: 400 });
  }

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthName = now.toLocaleDateString("en-US", { month: "long" });

  const issues: string[] = [];
  const alerts: string[] = [];
  const summary: string[] = [];

  // === 1. Compare MTD payments: Stripe vs DB ===
  let stripePaymentCount = 0;
  let stripeTotal = 0;
  const stripePaymentIds = new Set<string>();

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Record<string, unknown> = {
      limit: 100,
      created: {
        gte: Math.floor(monthStart.getTime() / 1000),
        lte: Math.floor(now.getTime() / 1000),
      },
    };
    if (startingAfter) params.starting_after = startingAfter;

    const batch = await stripe.paymentIntents.list(
      params as Parameters<typeof stripe.paymentIntents.list>[0]
    );

    for (const pi of batch.data) {
      if (pi.status === "succeeded") {
        stripePaymentCount++;
        stripeTotal += pi.amount;
        stripePaymentIds.add(pi.id);
      }
    }

    hasMore = batch.has_more;
    if (batch.data.length > 0) {
      startingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  const dbPayments = await prisma.payment.findMany({
    where: {
      paidAt: { gte: monthStart, lte: now },
      status: { in: ["succeeded", "partially_refunded"] },
    },
  });

  const dbTotal = dbPayments.reduce((sum, p) => sum + p.amountCents, 0);
  const dbPiIds = new Set(dbPayments.map(p => p.stripePaymentIntentId).filter(Boolean));

  // Find missing payments
  const missingFromDb: string[] = [];
  for (const piId of stripePaymentIds) {
    if (!dbPiIds.has(piId)) missingFromDb.push(piId);
  }

  if (missingFromDb.length > 0) {
    issues.push(`🔴 ${missingFromDb.length} payment(s) in Stripe not in our DB`);
  }

  const paymentDiff = Math.abs(stripeTotal - dbTotal);
  if (paymentDiff > 100) { // more than $1 difference
    issues.push(`🔴 Payment total mismatch: Stripe $${(stripeTotal/100).toFixed(2)} vs DB $${(dbTotal/100).toFixed(2)} (diff: $${(paymentDiff/100).toFixed(2)})`);
  }

  summary.push(`💰 ${monthName} collected: $${(dbTotal/100).toFixed(2)} (${dbPayments.length} payments)`);

  // === 2. Check for failed payments (last 24 hours) ===
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  let failedHasMore = true;
  let failedStartingAfter: string | undefined;

  while (failedHasMore) {
    const params: Record<string, unknown> = {
      limit: 100,
      created: {
        gte: Math.floor(yesterday.getTime() / 1000),
        lte: Math.floor(now.getTime() / 1000),
      },
    };
    if (failedStartingAfter) params.starting_after = failedStartingAfter;

    const batch = await stripe.paymentIntents.list(
      params as Parameters<typeof stripe.paymentIntents.list>[0]
    );

    for (const pi of batch.data) {
      if (pi.status === "requires_payment_method" || pi.status === "canceled") {
        const customerId = typeof pi.customer === "string" ? pi.customer : pi.customer?.id || null;
        let name = "Unknown";
        if (customerId) {
          try {
            const customer = await stripe.customers.retrieve(customerId);
            if (!("deleted" in customer && customer.deleted)) {
              name = customer.name || customer.email || "Unknown";
            }
          } catch { /* */ }
        }
        alerts.push(`⚠️ Payment failed: $${(pi.amount/100).toFixed(2)} from ${name} — card needs updating`);
      }
    }

    failedHasMore = batch.has_more;
    if (batch.data.length > 0) {
      failedStartingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  // === 3. MRR check: count active subs ===
  const subs = await stripe.subscriptions.list({ status: "active", limit: 100 });
  let activeMrr = 0;
  let pausedCount = 0;
  let activeCount = 0;

  for (const sub of subs.data) {
    const subRaw = sub as unknown as Record<string, unknown>;
    const isPaused = !!subRaw.pause_collection;

    let subMrr = 0;
    for (const item of sub.items.data) {
      const unitAmount = item.price.unit_amount || 0;
      const quantity = item.quantity || 1;
      const interval = item.price.recurring?.interval;
      const intervalCount = item.price.recurring?.interval_count || 1;

      if (interval === "month") subMrr += unitAmount * quantity / intervalCount;
      else if (interval === "year") subMrr += Math.round((unitAmount * quantity) / (12 * intervalCount));
    }

    if (isPaused) pausedCount++;
    else {
      activeMrr += subMrr;
      activeCount++;
    }
  }

  summary.push(`📊 MRR: $${(activeMrr/100).toFixed(2)} (${activeCount} active, ${pausedCount} paused)`);

  // === 4. Upcoming term endings (within 14 days) ===
  for (const sub of subs.data) {
    const subRaw = sub as unknown as Record<string, unknown>;
    const cancelAt = typeof subRaw.cancel_at === "number" ? subRaw.cancel_at : null;

    if (cancelAt) {
      const cancelDate = new Date(cancelAt * 1000);
      const daysUntil = Math.ceil((cancelDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      if (daysUntil > 0 && daysUntil <= 14) {
        const customer = typeof sub.customer === "string" ? null : sub.customer;
        const name = customer && !("deleted" in customer && customer.deleted)
          ? (customer.name || customer.email || "Unknown")
          : "Unknown";

        let subMrr = 0;
        for (const item of sub.items.data) {
          subMrr += (item.price.unit_amount || 0) * (item.quantity || 1);
        }

        alerts.push(`📅 ${name} subscription ends in ${daysUntil} days ($${(subMrr/100).toFixed(2)}) — renewal needed`);
      }
    }
  }

  // === 5. Payments with missing customer info ===
  const unknownPayments = await prisma.payment.count({
    where: {
      paidAt: { gte: monthStart, lte: now },
      customerName: null,
      status: "succeeded",
    },
  });

  if (unknownPayments > 0) {
    issues.push(`⚠️ ${unknownPayments} payment(s) with unknown customer — run enrich`);
  }

  // === Build Slack message ===
  const lines: string[] = [];
  lines.push(`📋 *Daily Financial Audit — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}*`);
  lines.push("");

  for (const s of summary) lines.push(s);
  lines.push("");

  if (alerts.length > 0) {
    lines.push("*Action Items:*");
    for (const a of alerts) lines.push(a);
    lines.push("");
  }

  if (issues.length > 0) {
    lines.push("*Data Issues:*");
    for (const i of issues) lines.push(i);
    lines.push("");
  }

  if (alerts.length === 0 && issues.length === 0) {
    lines.push("✅ All clear — no issues found");
  }

  const message = lines.join("\n");

  try {
    await sendSlackCEO(message);
  } catch { /* Slack not configured */ }

  return NextResponse.json({
    summary,
    alerts,
    issues,
    details: {
      stripe: { paymentCount: stripePaymentCount, total: stripeTotal },
      db: { paymentCount: dbPayments.length, total: dbTotal },
      missingFromDb: missingFromDb.length,
      activeMrr,
      activeCount,
      pausedCount,
      unknownPayments,
    },
    message,
  });
}
