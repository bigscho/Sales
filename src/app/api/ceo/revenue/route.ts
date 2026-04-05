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
    where: {
      paidAt: dateFilter,
      status: { in: ["succeeded", "refunded", "partially_refunded", "disputed"] },
    },
    include: { deal: true, week: true },
    orderBy: { paidAt: "desc" },
  });

  // Revenue breakdown
  let newRevenue = 0;
  let returningRevenue = 0;
  let mrrPayments = 0;
  let oneTimePayments = 0;
  let miscPayments = 0;
  let totalRefunded = 0;

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

    // Track refunds (count before skipping)
    if (p.refundedCents > 0) totalRefunded += p.refundedCents;

    // For fully refunded/disputed: include in gross but not in type/status breakdowns
    if (p.status === "refunded" || p.status === "disputed") continue;

    // Use net amount for partially refunded payments
    const netAmount = p.amountCents - (p.refundedCents || 0);

    // By type
    if (effectiveType === "mrr") mrrPayments += netAmount;
    else if (effectiveType === "one_time") oneTimePayments += netAmount;
    else miscPayments += netAmount;

    // By customer status
    if (effectiveStatus === "new") newRevenue += netAmount;
    else if (effectiveStatus === "returning") returningRevenue += netAmount;

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
    byCustomer[custKey].total += netAmount;
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
      byWeek[p.weekId].total += netAmount;
      byWeek[p.weekId].paymentCount++;
      if (effectiveStatus === "new") byWeek[p.weekId].newRevenue += netAmount;
      if (effectiveStatus === "returning") byWeek[p.weekId].returningRevenue += netAmount;
    }
  }

  // Gross = all succeeded + partially refunded payments (full refunds still count toward gross)
  const grossRevenue = payments
    .filter((p) => p.status !== "failed")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const totalRevenue = grossRevenue - totalRefunded;

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
    grossRevenue,
    totalRefunded,
    totalRevenue, // net: gross - refunds
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
      refundedCents: p.refundedCents || 0,
      netCents: p.amountCents - (p.refundedCents || 0),
      paidAt: p.paidAt,
      status: p.status,
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

async function getStripeMRR() {
  if (!process.env.STRIPE_SECRET_KEY) {
    return {
      activeMrr: 0, pausedMrr: 0, terminalMrr: 0, totalOnBooks: 0,
      activeCount: 0, pausedCount: 0, terminalCount: 0, totalCount: 0,
      renewalsNeeded: [] as Array<{ clientName: string; email: string | null; mrrCents: number; cancelAt: string | null }>,
      subscriptions: [] as Array<Record<string, unknown>>,
      error: "STRIPE_SECRET_KEY not set",
    };
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
    let pausedMrr = 0;
    let terminalMrr = 0;
    const subscriptions: Array<{
      clientName: string;
      email: string | null;
      mrrCents: number;
      status: string;
      isPaused: boolean;
      isTerminal: boolean;
      currentPeriodEnd: string;
      cancelAt: string | null;
      cancelAtPeriodEnd: boolean;
      type: "auto-renew" | "fixed-term" | "canceling" | "paused" | "terminal";
      startDate: string;
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

      // Access raw subscription fields via cast
      const subRaw = sub as unknown as Record<string, unknown>;
      const currentPeriodEnd = typeof subRaw.current_period_end === "number" ? subRaw.current_period_end : 0;
      const cancelAt = typeof subRaw.cancel_at === "number" ? subRaw.cancel_at : null;
      const cancelAtPeriodEnd = subRaw.cancel_at_period_end === true;
      const startDate = typeof subRaw.start_date === "number" ? subRaw.start_date : (typeof subRaw.created === "number" ? subRaw.created : 0);

      // Check if paused
      const pauseCollection = subRaw.pause_collection as Record<string, unknown> | null;
      const isPaused = !!pauseCollection;

      // Check if terminal (cancel_at exists and last billing already happened)
      const isTerminal = !!(cancelAt && currentPeriodEnd && cancelAt <= currentPeriodEnd);

      // Determine subscription type
      let subType: "auto-renew" | "fixed-term" | "canceling" | "paused" | "terminal" = "auto-renew";
      if (isPaused) subType = "paused";
      else if (isTerminal) subType = "terminal";
      else if (cancelAt) subType = "fixed-term";
      else if (cancelAtPeriodEnd) subType = "canceling";

      // Only count toward real MRR if actively billing
      const countsTowardMrr = !isPaused && !isTerminal && sub.status === "active";

      if (countsTowardMrr) activeMrr += subMrr;
      if (isPaused) pausedMrr += subMrr;
      if (isTerminal) terminalMrr += subMrr;

      subscriptions.push({
        clientName,
        email,
        mrrCents: subMrr,
        status: sub.status,
        isPaused,
        isTerminal,
        currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : "unknown",
        cancelAt: cancelAt ? new Date(cancelAt * 1000).toISOString() : null,
        cancelAtPeriodEnd,
        type: subType,
        startDate: startDate ? new Date((startDate as number) * 1000).toISOString() : "unknown",
      });
    }

    // Sort by MRR descending
    subscriptions.sort((a, b) => b.mrrCents - a.mrrCents);

    const activeCount = subscriptions.filter(s => !s.isPaused && !s.isTerminal).length;
    const pausedCount = subscriptions.filter(s => s.isPaused).length;
    const terminalCount = subscriptions.filter(s => s.isTerminal).length;
    const renewalsNeeded = subscriptions.filter(s => s.isTerminal);

    return {
      activeMrr,
      pausedMrr,
      terminalMrr,
      totalOnBooks: activeMrr + pausedMrr + terminalMrr,
      activeCount,
      pausedCount,
      terminalCount,
      totalCount: subs.data.length,
      renewalsNeeded,
      subscriptions,
    };
  } catch (err) {
    return {
      activeMrr: 0,
      activeCount: 0,
      subscriptions: [],
      error: err instanceof Error ? err.message : "Stripe API error",
    };
  }
}
