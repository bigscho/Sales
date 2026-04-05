import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  // === Real MRR from Stripe subscriptions API ===
  let activeMrr = 0;
  let activeCustomers = 0;
  const subscriptionDetails: Array<{
    clientName: string;
    email: string | null;
    mrrCents: number;
    currentPeriodEnd: string;
  }> = [];

  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      const subs = await stripe.subscriptions.list({
        status: "active",
        limit: 100,
        expand: ["data.customer"],
      });

      for (const sub of subs.data) {
        let subMrr = 0;
        for (const item of sub.items.data) {
          const price = item.price;
          const quantity = item.quantity || 1;
          const unitAmount = price.unit_amount || 0;

          if (price.recurring?.interval === "month") {
            subMrr += unitAmount * quantity / (price.recurring.interval_count || 1);
          } else if (price.recurring?.interval === "year") {
            subMrr += Math.round((unitAmount * quantity) / (12 * (price.recurring.interval_count || 1)));
          } else if (price.recurring?.interval === "week") {
            subMrr += Math.round((unitAmount * quantity * 52) / (12 * (price.recurring.interval_count || 1)));
          }
        }

        const customer = typeof sub.customer === "string" ? null : sub.customer;
        const clientName = customer && !("deleted" in customer && customer.deleted)
          ? (customer.name || customer.email || "Unknown")
          : "Unknown";
        const email = customer && !("deleted" in customer && customer.deleted)
          ? customer.email
          : null;

        activeMrr += subMrr;
        subscriptionDetails.push({
          clientName,
          email,
          mrrCents: subMrr,
          currentPeriodEnd: new Date(((sub as unknown as Record<string, number>).current_period_end || 0) * 1000).toISOString(),
        });
      }

      activeCustomers = subs.data.length;
      subscriptionDetails.sort((a, b) => b.mrrCents - a.mrrCents);
    } catch {
      // Stripe API failed — fall back gracefully
    }
  }

  // MRR events (manual churn flags, new sub events)
  const mrrEvents = await prisma.mrrEvent.findMany({
    orderBy: { effectiveDate: "desc" },
    take: 50,
  });

  const thisMonthEvents = mrrEvents.filter(
    (e) => new Date(e.effectiveDate) >= monthStart && new Date(e.effectiveDate) <= monthEnd
  );

  const newMrr = thisMonthEvents
    .filter((e) => e.type === "new_subscription")
    .reduce((sum, e) => sum + e.mrrAmountCents, 0);

  const churnedMrr = thisMonthEvents
    .filter((e) => e.type === "churn")
    .reduce((sum, e) => sum + e.mrrAmountCents, 0);

  // Pending churns (flagged but not yet reflected in Stripe)
  const pendingChurns = mrrEvents.filter(
    (e) => e.type === "churn" && new Date(e.effectiveDate) > now
  );

  const pendingChurnMrr = pendingChurns.reduce((sum, e) => sum + e.mrrAmountCents, 0);
  const projectedMrr = activeMrr - pendingChurnMrr;

  return NextResponse.json({
    activeMrr,
    projectedMrr,
    newMrr,
    churnedMrr,
    netMrrChange: newMrr - churnedMrr,
    activeCustomers,
    subscriptions: subscriptionDetails,
    pendingChurns: pendingChurns.map((e) => ({
      clientName: e.clientName,
      mrrAmountCents: e.mrrAmountCents,
      effectiveDate: e.effectiveDate,
      notes: e.notes,
    })),
    recentEvents: mrrEvents.slice(0, 20),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { type, clientName, mrrAmountCents, effectiveDate, stripeSubscriptionId, notes } = body;

  if (!type || !clientName || !mrrAmountCents) {
    return NextResponse.json(
      { error: "type, clientName, and mrrAmountCents are required" },
      { status: 400 }
    );
  }

  const event = await prisma.mrrEvent.create({
    data: {
      type,
      clientName,
      mrrAmountCents,
      effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
      stripeSubscriptionId: stripeSubscriptionId || null,
      notes: notes || null,
    },
  });

  return NextResponse.json({ success: true, event });
}
