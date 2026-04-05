import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const view = searchParams.get("view") || "monthly"; // weekly | monthly | mtd
  const month = parseInt(searchParams.get("month") || String(new Date().getMonth() + 1));
  const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()));
  const weekId = searchParams.get("weekId") || undefined;

  // === Real MRR from Stripe subscriptions ===
  const stripeMrr = await getStripeMRR();

  // === Payment-based revenue (from the Payment table) ===
  let dateFilter: { gte: Date; lte: Date };

  if (weekId) {
    const week = await prisma.week.findUnique({ where: { id: weekId } });
    if (!week) return NextResponse.json({ error: "Week not found" }, { status: 404 });
    dateFilter = { gte: week.weekStart, lte: week.weekEnd };
  } else if (view === "mtd") {
    dateFilter = { gte: new Date(year, month - 1, 1), lte: new Date() };
  } else {
    dateFilter = {
      gte: new Date(year, month - 1, 1),
      lte: new Date(year, month, 0, 23, 59, 59),
    };
  }

  const payments = await prisma.payment.findMany({
    where: { paidAt: dateFilter, status: "succeeded" },
    include: { deal: true, week: true },
    orderBy: { paidAt: "desc" },
  });

  // Revenue breakdown
  let newRevenue = 0;
  let returningRevenue = 0;
  let mrrPayments = 0;
  let oneTimePayments = 0;
  let miscPayments = 0;

  const byCustomer: Record<string, {
    name: string;
    email: string | null;
    total: number;
    payments: number;
    revenueType: string;
    customerStatus: string;
    lastPaidAt: string;
  }> = {};

  const byWeek: Record<string, {
    weekId: string;
    weekStart: string;
    weekEnd: string;
    total: number;
    newRevenue: number;
    returningRevenue: number;
    paymentCount: number;
  }> = {};

  for (const p of payments) {
    const effectiveType = p.revenueTypeOverride || p.revenueType;
    const effectiveStatus = p.customerStatusOverride || p.customerStatus;

    // By type
    if (effectiveType === "mrr") mrrPayments += p.amountCents;
    else if (effectiveType === "one_time") oneTimePayments += p.amountCents;
    else miscPayments += p.amountCents;

    // By customer status
    if (effectiveStatus === "new") newRevenue += p.amountCents;
    else if (effectiveStatus === "returning") returningRevenue += p.amountCents;

    // By customer
    const custKey = p.stripeCustomerId || p.customerEmail || p.customerName || "unknown";
    if (!byCustomer[custKey]) {
      byCustomer[custKey] = {
        name: p.customerName || "Unknown",
        email: p.customerEmail,
        total: 0,
        payments: 0,
        revenueType: effectiveType,
        customerStatus: effectiveStatus,
        lastPaidAt: p.paidAt.toISOString(),
      };
    }
    byCustomer[custKey].total += p.amountCents;
    byCustomer[custKey].payments++;

    // By week
    if (p.weekId && p.week) {
      if (!byWeek[p.weekId]) {
        byWeek[p.weekId] = {
          weekId: p.weekId,
          weekStart: p.week.weekStart.toISOString(),
          weekEnd: p.week.weekEnd.toISOString(),
          total: 0,
          newRevenue: 0,
          returningRevenue: 0,
          paymentCount: 0,
        };
      }
      byWeek[p.weekId].total += p.amountCents;
      byWeek[p.weekId].paymentCount++;
      if (effectiveStatus === "new") byWeek[p.weekId].newRevenue += p.amountCents;
      if (effectiveStatus === "returning") byWeek[p.weekId].returningRevenue += p.amountCents;
    }
  }

  const totalRevenue = payments.reduce((sum, p) => sum + p.amountCents, 0);

  // Previous period comparison
  const prevStart = new Date(dateFilter.gte);
  const prevEnd = new Date(dateFilter.lte);
  const periodDays = Math.ceil((prevEnd.getTime() - prevStart.getTime()) / (1000 * 60 * 60 * 24));
  prevStart.setDate(prevStart.getDate() - periodDays);
  prevEnd.setDate(prevEnd.getDate() - periodDays);

  const prevPayments = await prisma.payment.findMany({
    where: { paidAt: { gte: prevStart, lte: prevEnd }, status: "succeeded" },
  });
  const prevTotal = prevPayments.reduce((sum, p) => sum + p.amountCents, 0);

  return NextResponse.json({
    period: { month, year, view },
    // Live Stripe MRR (from subscriptions API)
    stripeMrr,
    // Payment-based revenue for the period
    totalRevenue,
    newRevenue,
    returningRevenue,
    byType: {
      mrr: mrrPayments,
      oneTime: oneTimePayments,
      misc: miscPayments,
    },
    byCustomer: Object.values(byCustomer)
      .sort((a, b) => b.total - a.total),
    byWeek: Object.values(byWeek)
      .sort((a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime()),
    payments: payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      paidAt: p.paidAt,
      customerName: p.customerName,
      customerEmail: p.customerEmail,
      revenueType: p.revenueTypeOverride || p.revenueType,
      customerStatus: p.customerStatusOverride || p.customerStatus,
      matchStatus: p.matchStatus,
      dealId: p.dealId,
      stripeCustomerId: p.stripeCustomerId,
    })),
    paymentCount: payments.length,
    comparison: {
      prevTotal,
      change: prevTotal > 0 ? (totalRevenue - prevTotal) / prevTotal : 0,
    },
  });
}

async function getStripeMRR(): Promise<{
  activeMrr: number;
  activeCount: number;
  subscriptions: Array<{
    clientName: string;
    email: string | null;
    mrrCents: number;
    status: string;
    currentPeriodEnd: string;
  }>;
  error?: string;
}> {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { activeMrr: 0, activeCount: 0, subscriptions: [], error: "STRIPE_SECRET_KEY not set" };
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Pull ALL active subscriptions from Stripe — this is the real MRR
    const subs = await stripe.subscriptions.list({
      status: "active",
      limit: 100,
      expand: ["data.customer"],
    });

    let activeMrr = 0;
    const subscriptions: Array<{
      clientName: string;
      email: string | null;
      mrrCents: number;
      status: string;
      currentPeriodEnd: string;
    }> = [];

    for (const sub of subs.data) {
      // Calculate MRR from subscription items
      let subMrr = 0;
      for (const item of sub.items.data) {
        const price = item.price;
        const quantity = item.quantity || 1;
        const unitAmount = price.unit_amount || 0;

        // Normalize to monthly
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
      subscriptions.push({
        clientName,
        email,
        mrrCents: subMrr,
        status: sub.status,
        currentPeriodEnd: new Date(((sub as unknown as Record<string, number>).current_period_end || 0) * 1000).toISOString(),
      });
    }

    // Sort by MRR descending
    subscriptions.sort((a, b) => b.mrrCents - a.mrrCents);

    return { activeMrr, activeCount: subs.data.length, subscriptions };
  } catch (err) {
    return {
      activeMrr: 0,
      activeCount: 0,
      subscriptions: [],
      error: err instanceof Error ? err.message : "Stripe API error",
    };
  }
}
