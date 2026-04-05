import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  // Get active MRR from Stripe subscription payments
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  // Active subscriptions from Payment model
  const activeSubscriptions = await prisma.payment.findMany({
    where: {
      isSubscription: true,
      status: "succeeded",
    },
    orderBy: { paidAt: "desc" },
  });

  // Deduplicate by customer — take most recent payment per customer
  const byCustomer = new Map<string, typeof activeSubscriptions[0]>();
  for (const p of activeSubscriptions) {
    const key = p.stripeCustomerId || p.customerEmail || p.id;
    if (!byCustomer.has(key)) byCustomer.set(key, p);
  }

  const activeMrr = Array.from(byCustomer.values()).reduce((sum, p) => sum + p.amountCents, 0);

  // MRR events (churns, new subs)
  const mrrEvents = await prisma.mrrEvent.findMany({
    orderBy: { effectiveDate: "desc" },
    take: 50,
  });

  // This month's events
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
    activeCustomers: byCustomer.size,
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
