import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackCEO } from "@/lib/slack";

// Daily financial audit — runs at 7 AM ET (11 UTC)
// Posts full financial snapshot + action items to CEO Slack DM
export async function GET() {
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "STRIPE_SECRET_KEY not set" }, { status: 400 });
  }

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthName = now.toLocaleDateString("en-US", { month: "long" });
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const issues: string[] = [];
  const alerts: string[] = [];

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

  const collected = dbPayments.reduce((sum, p) => sum + p.amountCents, 0);
  const dbPiIds = new Set(dbPayments.map(p => p.stripePaymentIntentId).filter(Boolean));

  // Find missing payments
  const missingFromDb: string[] = [];
  for (const piId of stripePaymentIds) {
    if (!dbPiIds.has(piId)) missingFromDb.push(piId);
  }

  if (missingFromDb.length > 0) {
    issues.push(`🔴 ${missingFromDb.length} payment(s) in Stripe missing from DB — run backfill`);
    // Look up details for each missing payment
    for (const piId of missingFromDb) {
      try {
        const pi = await stripe.paymentIntents.retrieve(piId);
        const custId = typeof pi.customer === "string" ? pi.customer : null;
        let name = "Unknown";
        if (custId) {
          try {
            const c = await stripe.customers.retrieve(custId);
            if (!("deleted" in c && c.deleted)) name = c.name || c.email || "Unknown";
          } catch { /* */ }
        }
        issues.push(`   → $${(pi.amount/100).toFixed(2)} from ${name} (${piId})`);
      } catch { /* */ }
    }
  }

  const paymentDiff = Math.abs(stripeTotal - collected);
  if (paymentDiff > 100) {
    issues.push(`🔴 Revenue mismatch: Stripe says $${(stripeTotal/100).toFixed(2)}, DB says $${(collected/100).toFixed(2)} (off by $${(paymentDiff/100).toFixed(2)})`);
  }

  // === 2. Check for failed payments (last 48 hours) ===
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  let failedHasMore = true;
  let failedStartingAfter: string | undefined;

  while (failedHasMore) {
    const params: Record<string, unknown> = {
      limit: 100,
      created: {
        gte: Math.floor(twoDaysAgo.getTime() / 1000),
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
        alerts.push(`🚨 Failed payment: $${(pi.amount/100).toFixed(2)} from ${name} — update card ASAP`);
      }
    }

    failedHasMore = batch.has_more;
    if (batch.data.length > 0) {
      failedStartingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  // === 3. Full subscription analysis ===
  const subs = await stripe.subscriptions.list({
    status: "active",
    limit: 100,
    expand: ["data.customer"],
  });

  let activeMrr = 0;
  let pausedMrr = 0;
  let collectibleThisMonth = 0;
  let recoverableMonthly = 0;
  let terminalMrr = 0;
  let pausedCount = 0;
  let activeCount = 0;
  let terminalCount = 0;
  const recoverableNames: string[] = [];
  const terminalNames: string[] = [];

  for (const sub of subs.data) {
    const subRaw = sub as unknown as Record<string, unknown>;
    const isPaused = !!subRaw.pause_collection;
    const cancelAt = typeof subRaw.cancel_at === "number" ? subRaw.cancel_at : null;
    const canceledAt = typeof subRaw.canceled_at === "number" ? subRaw.canceled_at : null;
    const billingAnchor = typeof subRaw.billing_cycle_anchor === "number" ? subRaw.billing_cycle_anchor : 0;

    const customer = typeof sub.customer === "string" ? null : sub.customer;
    const name = customer && !("deleted" in customer && customer.deleted)
      ? (customer.name || customer.email || "Unknown")
      : "Unknown";

    let subMrr = 0;
    let chargeAmount = 0;
    const intervalMonths = sub.items.data[0]?.price.recurring?.interval === "month"
      ? (sub.items.data[0]?.price.recurring?.interval_count || 1)
      : sub.items.data[0]?.price.recurring?.interval === "year" ? 12 : 1;

    for (const item of sub.items.data) {
      const unitAmount = item.price.unit_amount || 0;
      const quantity = item.quantity || 1;
      const interval = item.price.recurring?.interval;
      const intCount = item.price.recurring?.interval_count || 1;

      chargeAmount += unitAmount * quantity;
      if (interval === "month") subMrr += unitAmount * quantity / intCount;
      else if (interval === "year") subMrr += Math.round((unitAmount * quantity) / (12 * intCount));
    }

    // Terminal check
    let isTerminal = false;
    if (cancelAt && canceledAt && billingAnchor > 0 && intervalMonths > 0) {
      const anchor = new Date(billingAnchor * 1000);
      const cancelDate = new Date(cancelAt * 1000);
      const nextBill = new Date(anchor);
      while (nextBill <= now) {
        nextBill.setMonth(nextBill.getMonth() + intervalMonths);
      }
      isTerminal = nextBill >= cancelDate;
    }

    if (isPaused) {
      pausedCount++;
      pausedMrr += subMrr;
      if (intervalMonths === 1) {
        recoverableMonthly += subMrr;
        recoverableNames.push(`${name} ($${(subMrr/100).toFixed(2)}/mo)`);
      }
    } else if (isTerminal) {
      terminalCount++;
      terminalMrr += subMrr;
      terminalNames.push(`${name} ($${(subMrr/100).toFixed(2)}/mo)`);
    } else {
      activeCount++;
      activeMrr += subMrr;

      // Collectible this month
      if (billingAnchor > 0 && intervalMonths > 0) {
        const anchor = new Date(billingAnchor * 1000);
        const nextBill = new Date(anchor);
        while (nextBill <= now) {
          nextBill.setMonth(nextBill.getMonth() + intervalMonths);
        }
        if (nextBill >= thisMonthStart && nextBill <= thisMonthEnd) {
          collectibleThisMonth += chargeAmount;
        }
      }
    }
  }

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

        let amount = 0;
        for (const item of sub.items.data) {
          amount += (item.price.unit_amount || 0) * (item.quantity || 1);
        }

        alerts.push(`📅 ${name} ends in ${daysUntil} days ($${(amount/100).toFixed(2)}/mo) — renewal needed`);
      }
    }
  }

  // === 5. Data quality checks ===
  const unknownPayments = await prisma.payment.findMany({
    where: {
      paidAt: { gte: monthStart, lte: now },
      customerName: null,
      status: { in: ["succeeded", "partially_refunded"] },
    },
  });

  if (unknownPayments.length > 0) {
    issues.push(`⚠️ ${unknownPayments.length} payment(s) with unknown customer:`);
    for (const p of unknownPayments) {
      issues.push(`   → $${(p.amountCents/100).toFixed(2)} on ${p.paidAt.toLocaleDateString()} (${p.stripePaymentIntentId || "no PI"})`);
    }
  }

  // Check for payments marked as wrong status
  const wrongStatus = await prisma.payment.findMany({
    where: {
      paidAt: { gte: monthStart, lte: now },
      customerStatus: "unknown",
      status: { in: ["succeeded", "partially_refunded"] },
    },
  });

  if (wrongStatus.length > 0) {
    issues.push(`⚠️ ${wrongStatus.length} payment(s) with unknown new/returning status — run enrich`);
  }

  // === Build Slack message ===
  const totalRecoverable = recoverableMonthly + terminalMrr;
  const lines: string[] = [];
  lines.push(`📋 *Daily Financial Audit — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}*`);
  lines.push("");
  lines.push(`*${monthName} Snapshot:*`);
  lines.push(`💰 Collected: *$${(collected/100).toFixed(2)}* (${dbPayments.length} payments)`);
  lines.push(`📈 Collectible: *$${(collectibleThisMonth/100).toFixed(2)}* remaining this month`);
  lines.push(`📊 MRR: *$${(activeMrr/100).toFixed(2)}* (${activeCount} active)`);
  lines.push(`⏸️ Paused: $${(pausedMrr/100).toFixed(2)} (${pausedCount} subs)`);
  if (terminalCount > 0) {
    lines.push(`🔚 Terminal: $${(terminalMrr/100).toFixed(2)} (${terminalCount} — ${terminalNames.join(", ")})`);
  }
  lines.push(`🔄 Recoverable: *$${(totalRecoverable/100).toFixed(2)}/mo* if all conversations close`);
  lines.push("");

  if (alerts.length > 0) {
    lines.push("*🚨 Action Items:*");
    for (const a of alerts) lines.push(a);
    lines.push("");
  }

  if (issues.length > 0) {
    lines.push("*⚠️ Data Issues:*");
    for (const i of issues) lines.push(i);
    lines.push("");
  }

  if (alerts.length === 0 && issues.length === 0) {
    lines.push("✅ No action items or data issues");
  }

  const message = lines.join("\n");

  try {
    await sendSlackCEO(message);
  } catch { /* Slack not configured */ }

  return NextResponse.json({
    snapshot: {
      collected,
      collectibleThisMonth,
      activeMrr,
      pausedMrr,
      terminalMrr,
      recoverableMonthly,
      activeCount,
      pausedCount,
      terminalCount,
    },
    alerts,
    issues,
    reconciliation: {
      stripe: { paymentCount: stripePaymentCount, total: stripeTotal },
      db: { paymentCount: dbPayments.length, total: collected },
      missingFromDb: missingFromDb.length,
      matched: paymentDiff <= 100,
    },
    message,
  });
}
