import { prisma } from "./db";
import { computeShowRate } from "./utils";

interface SetterPayResult {
  teamMemberId: string;
  name: string;
  tier: number;
  showsThisWeek: number;
  perShowRate: number; // cents
  showPay: number; // cents
  basePay: number; // cents
  totalPay: number; // cents
  breakdown: string;
}

// === Closer comp (1099 contract, Aug 2026) ===
// Will is the only comped closer — Colin and Matthew close deals but draw no
// pay from this system. Contract terms (§4): weekly commission on NEW-BUSINESS
// cash collected that week (16% fed / 25% self-sourced), monthly base $3,500
// paid in arrears, gated by a volume floor (<20 closes → no base) and a quality
// floor (fed close rate <25% → −$200 per full point, floor $1,500, applied only
// in months with 15+ fed demos showed). Refunds/chargebacks within 60 days of
// collection reverse the commission (§4.8).
export interface CloserCompConfig {
  fedRate: number;
  selfRate: number;
  monthlyBaseCents: number;
}

export const CLOSER_COMP: Record<string, CloserCompConfig> = {
  "closer-will": { fedRate: 0.16, selfRate: 0.25, monthlyBaseCents: 350000 },
};

export interface CloserMonthlyBase {
  monthLabel: string; // "August 2026"
  closes: number;
  fedCloses: number;
  fedDemosShowed: number;
  fedCloseRate: number | null; // 0–1; null when no fed demos showed
  amountCents: number;
  note: string;
}

export interface CloserCommissionRange {
  fedCashCents: number;
  selfCashCents: number;
  commissionCents: number;
  clawbackCents: number; // negative or 0
  paymentCount: number;
  deals: { prospectName: string; cashCents: number; leadSource: string }[];
}

interface CloserPayResult {
  teamMemberId: string;
  name: string;
  hasComp: boolean;
  dealsClosedCount: number;
  month1Cash: number; // cents — total commissionable cash this week
  fedCashCents: number;
  selfCashCents: number;
  commission: number; // cents
  clawback: number; // cents, negative or 0
  monthlyBase: CloserMonthlyBase | null; // present only in the week containing a month end
  totalPay: number; // cents
  deals: { prospectName: string; cashCents: number; leadSource: string }[];
}

interface ShowRateRepResult {
  teamMemberId: string;
  name: string;
  showRate: number;
  bonus: number; // cents
  tier: string;
}

export function calculatePerShowRate(tier: number, showsThisWeek: number): number {
  if (tier === 1) return 2500; // $25 flat
  // Tiers 2-4 use same tiered rate
  if (showsThisWeek >= 15) return 4000; // $40
  if (showsThisWeek >= 10) return 3500; // $35
  return 2500; // $25
}

export function calculateSetterBase(tier: number, showsThisWeek: number): number {
  if (tier === 3) {
    return showsThisWeek >= 10 ? 50000 : 0; // $500 if 10+ shows
  }
  if (tier === 4) {
    if (showsThisWeek >= 15) return 100000; // $1000
    if (showsThisWeek >= 10) return 50000; // $500
    return 0;
  }
  return 0; // Tiers 1-2 have no base
}

export async function calculateSetterPay(setterId: string, weekId: string): Promise<SetterPayResult> {
  const setter = await prisma.teamMember.findUniqueOrThrow({ where: { id: setterId } });

  const shows = await prisma.demo.count({
    where: {
      weekId,
      booking: { setterId },
      status: "showed",
    },
  });

  const perShowRate = calculatePerShowRate(setter.tier, shows);
  const showPay = shows * perShowRate;
  const basePay = calculateSetterBase(setter.tier, shows);
  const totalPay = showPay + basePay;

  const breakdown = [
    `${shows} shows x ${(perShowRate / 100).toFixed(0)}/show = $${(showPay / 100).toFixed(2)}`,
    basePay > 0 ? `Base: $${(basePay / 100).toFixed(2)}` : null,
  ].filter(Boolean).join(" + ");

  return {
    teamMemberId: setter.id,
    name: setter.name,
    tier: setter.tier,
    showsThisWeek: shows,
    perShowRate,
    showPay,
    basePay,
    totalPay,
    breakdown,
  };
}

// === What counts as commissionable cash (§4.5, §5 "Cash Collected") ===
// The NEW-BUSINESS test lives on the DEAL, not the payment: Stripe marks the
// 2nd installment of a split first-month payment "returning" (any prior
// succeeded charge does that), so filtering per-payment silently drops real
// month-1 cash. A deal is new business iff its FIRST payment wasn't from an
// already-paying client (customerStatus override wins — ops can correct).
//
// Month-1 window: commission covers cash collected within MONTH1_WINDOW_DAYS
// of the deal's first payment. Empirically (Aug 2026): split first-month
// payments land within 7 days; subscription renewals start at 28+ days. 21
// days cleanly separates "new-business cash" from "renewal/repeat revenue,
// which belongs entirely to Company".
const MONTH1_WINDOW_DAYS = 21;

type DealMeta = { firstPaidAt: Date; isNewBusiness: boolean };

// First payment per deal → month-1 anchor + deal-level new-business test.
async function loadDealMeta(dealIds: string[]): Promise<Map<string, DealMeta>> {
  const meta = new Map<string, DealMeta>();
  if (dealIds.length === 0) return meta;
  const payments = await prisma.payment.findMany({
    where: { dealId: { in: dealIds }, status: { not: "failed" } },
    orderBy: { paidAt: "asc" },
    select: { dealId: true, paidAt: true, customerStatus: true, customerStatusOverride: true },
  });
  for (const p of payments) {
    if (!p.dealId || meta.has(p.dealId)) continue;
    meta.set(p.dealId, {
      firstPaidAt: p.paidAt,
      isNewBusiness: (p.customerStatusOverride || p.customerStatus) !== "returning",
    });
  }
  return meta;
}

function isCommissionable(
  p: { paidAt: Date; status: string; revenueType: string; revenueTypeOverride: string | null; dealId: string | null },
  meta: Map<string, DealMeta>
): boolean {
  if (!p.dealId) return false;
  if (p.status === "failed") return false;
  if ((p.revenueTypeOverride || p.revenueType) === "misc") return false;
  const dm = meta.get(p.dealId);
  if (!dm || !dm.isNewBusiness) return false; // reorder/repeat client → Company's revenue (§4.5)
  const windowMs = MONTH1_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return p.paidAt.getTime() - dm.firstPaidAt.getTime() <= windowMs; // renewals/repeats beyond month 1 excluded
}

// Commission + clawback for a date range, cash-collected basis (§4.7):
// commission accrues on payments that LANDED in the range; clawback reverses
// commission on payments whose refund landed in the range within 60 days of
// collection (§4.8).
export async function computeCloserCommission(
  closerId: string,
  comp: CloserCompConfig,
  rangeStart: Date,
  rangeEnd: Date
): Promise<CloserCommissionRange> {
  const collected = await prisma.payment.findMany({
    where: {
      paidAt: { gte: rangeStart, lte: rangeEnd },
      deal: { closerId, status: "closed_won" },
    },
    include: { deal: { select: { id: true, prospectName: true, leadSource: true } } },
  });

  // Clawback: refunds recorded in the range on this closer's deals, where the
  // reversal came within 60 days of collection.
  const refunded = await prisma.payment.findMany({
    where: {
      refundedAt: { gte: rangeStart, lte: rangeEnd },
      refundedCents: { gt: 0 },
      deal: { closerId },
    },
    include: { deal: { select: { id: true, prospectName: true, leadSource: true } } },
  });

  const dealIds = [...new Set([...collected, ...refunded].map((p) => p.dealId!).filter(Boolean))];
  const meta = await loadDealMeta(dealIds);

  let fedCashCents = 0;
  let selfCashCents = 0;
  let commissionCents = 0;
  const dealAgg = new Map<string, { prospectName: string; cashCents: number; leadSource: string }>();

  for (const p of collected) {
    if (!p.deal || !isCommissionable(p, meta)) continue;
    const self = p.deal.leadSource === "self_sourced";
    if (self) selfCashCents += p.amountCents;
    else fedCashCents += p.amountCents;
    commissionCents += Math.round(p.amountCents * (self ? comp.selfRate : comp.fedRate));

    const key = p.deal.prospectName;
    const agg = dealAgg.get(key) || { prospectName: key, cashCents: 0, leadSource: p.deal.leadSource };
    agg.cashCents += p.amountCents;
    dealAgg.set(key, agg);
  }

  let clawbackCents = 0;
  for (const p of refunded) {
    if (!p.deal || !isCommissionable(p, meta)) continue;
    if (!p.refundedAt) continue;
    const withinWindow = p.refundedAt.getTime() - p.paidAt.getTime() <= 60 * 24 * 60 * 60 * 1000;
    if (!withinWindow) continue;
    const self = p.deal.leadSource === "self_sourced";
    clawbackCents -= Math.round(p.refundedCents * (self ? comp.selfRate : comp.fedRate));
  }

  return {
    fedCashCents,
    selfCashCents,
    commissionCents,
    clawbackCents,
    paymentCount: collected.length,
    deals: Array.from(dealAgg.values()),
  };
}

// Monthly base with the two contract floors (§4.2–4.4).
export async function calculateCloserMonthlyBase(
  closerId: string,
  comp: CloserCompConfig,
  year: number,
  monthIndex: number // 0-based
): Promise<CloserMonthlyBase> {
  const monthStart = new Date(Date.UTC(year, monthIndex, 1));
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
  const monthLabel = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const deals = await prisma.deal.findMany({
    where: { closerId, status: "closed_won", closedAt: { gte: monthStart, lte: monthEnd } },
    select: { leadSource: true },
  });
  const closes = deals.length;
  const fedCloses = deals.filter((d) => d.leadSource !== "self_sourced").length;

  // Quality-floor denominator: fed demos that actually SHOWED this month (§5).
  const fedDemosShowed = await prisma.demo.count({
    where: {
      closerId,
      status: "showed",
      booking: {
        leadSource: { not: "self_sourced" },
        demoDate: { gte: monthStart, lte: monthEnd },
      },
    },
  });

  const fedCloseRate = fedDemosShowed > 0 ? fedCloses / fedDemosShowed : null;

  let amountCents = comp.monthlyBaseCents;
  let note = "full base";

  if (closes < 20) {
    // Volume floor (§4.3): under 20 closes → commission only, no base.
    amountCents = 0;
    note = `volume floor: ${closes}/20 closes — no base this month`;
  } else if (fedDemosShowed >= 15 && fedCloseRate !== null) {
    // Quality floor (§4.4): −$200 per full point below 25%, floored at $1,500.
    const pct = fedCloseRate * 100;
    if (pct < 25) {
      const pointsUnder = Math.floor(25 - pct);
      amountCents = Math.max(comp.monthlyBaseCents - pointsUnder * 20000, 150000);
      note = `quality floor: ${pct.toFixed(1)}% fed close rate (−$${pointsUnder * 200})`;
    }
  } else if (closes >= 20 && fedDemosShowed < 15) {
    note = "quality floor waived (<15 fed demos showed)";
  }

  return { monthLabel, closes, fedCloses, fedDemosShowed, fedCloseRate, amountCents, note };
}

// The month whose last day falls inside [weekStart, weekEnd], if any — that's
// the payroll week where the monthly base is emitted (base paid in arrears).
function monthEndingInWeek(weekStart: Date, weekEnd: Date): { year: number; monthIndex: number } | null {
  const lastDayOfStartMonth = new Date(Date.UTC(
    weekStart.getUTCFullYear(), weekStart.getUTCMonth() + 1, 0, 23, 59, 59, 999
  ));
  if (lastDayOfStartMonth >= weekStart && lastDayOfStartMonth <= weekEnd) {
    return { year: weekStart.getUTCFullYear(), monthIndex: weekStart.getUTCMonth() };
  }
  return null;
}

export async function calculateCloserPay(closerId: string, weekId: string): Promise<CloserPayResult> {
  const closer = await prisma.teamMember.findUniqueOrThrow({ where: { id: closerId } });
  const comp = CLOSER_COMP[closer.id];

  if (!comp) {
    // Tracked closer with no comp (Colin, Matthew) — demos/deals count, pay doesn't.
    return {
      teamMemberId: closer.id,
      name: closer.name,
      hasComp: false,
      dealsClosedCount: 0,
      month1Cash: 0,
      fedCashCents: 0,
      selfCashCents: 0,
      commission: 0,
      clawback: 0,
      monthlyBase: null,
      totalPay: 0,
      deals: [],
    };
  }

  const week = await prisma.week.findUniqueOrThrow({ where: { id: weekId } });
  const range = await computeCloserCommission(closer.id, comp, week.weekStart, week.weekEnd);

  const monthEnd = monthEndingInWeek(week.weekStart, week.weekEnd);
  const monthlyBase = monthEnd
    ? await calculateCloserMonthlyBase(closer.id, comp, monthEnd.year, monthEnd.monthIndex)
    : null;

  return {
    teamMemberId: closer.id,
    name: closer.name,
    hasComp: true,
    dealsClosedCount: range.deals.length,
    month1Cash: range.fedCashCents + range.selfCashCents,
    fedCashCents: range.fedCashCents,
    selfCashCents: range.selfCashCents,
    commission: range.commissionCents,
    clawback: range.clawbackCents,
    monthlyBase,
    totalPay: range.commissionCents + range.clawbackCents + (monthlyBase?.amountCents || 0),
    deals: range.deals,
  };
}

export async function calculateShowRateBonus(weekId: string): Promise<ShowRateRepResult | null> {
  const rep = await prisma.teamMember.findFirst({
    where: { role: "show_rate_rep", isActive: true },
  });
  if (!rep) return null;

  const totalShowed = await prisma.demo.count({
    where: { weekId, status: "showed" },
  });
  const totalNoShow = await prisma.demo.count({
    where: { weekId, status: "no_show" },
  });
  const totalCancelled = await prisma.demo.count({
    where: { weekId, status: "cancelled" },
  });

  const showRate = computeShowRate(totalShowed, totalNoShow, totalCancelled);

  let bonus = 0;
  let tier = "Below 50%";
  if (showRate >= 0.70) {
    bonus = 30000; // $300
    tier = "70%+ ($300)";
  } else if (showRate >= 0.60) {
    bonus = 20000; // $200
    tier = "60%+ ($200)";
  } else if (showRate >= 0.50) {
    bonus = 10000; // $100
    tier = "50%+ ($100)";
  }

  return {
    teamMemberId: rep.id,
    name: rep.name,
    showRate,
    bonus,
    tier,
  };
}

export async function generatePayroll(weekId: string) {
  // Delete existing draft payroll for this week
  await prisma.payrollRun.deleteMany({
    where: { weekId, status: "draft" },
  });

  const payrollRun = await prisma.payrollRun.create({
    data: { weekId },
  });

  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true },
  });

  const closers = await prisma.teamMember.findMany({
    where: { role: "closer", isActive: true },
  });

  const lineItems = [];

  // Setter pay
  for (const setter of setters) {
    const pay = await calculateSetterPay(setter.id, weekId);
    if (pay.showPay > 0) {
      lineItems.push({
        payrollRunId: payrollRun.id,
        teamMemberId: setter.id,
        lineType: "per_show",
        description: `${pay.showsThisWeek} shows @ $${(pay.perShowRate / 100).toFixed(0)}/show (Tier ${pay.tier})`,
        quantity: pay.showsThisWeek,
        rateCents: pay.perShowRate,
        amountCents: pay.showPay,
      });
    }
    if (pay.basePay > 0) {
      lineItems.push({
        payrollRunId: payrollRun.id,
        teamMemberId: setter.id,
        lineType: "base",
        description: `Tier ${pay.tier} weekly base (${pay.showsThisWeek} shows)`,
        quantity: 1,
        rateCents: pay.basePay,
        amountCents: pay.basePay,
      });
    }
  }

  // Closer pay — contract terms, comped closers only (Colin/Matthew are tracked
  // for attribution but draw no pay; see CLOSER_COMP).
  for (const closer of closers) {
    const pay = await calculateCloserPay(closer.id, weekId);
    if (!pay.hasComp) continue;

    if (pay.commission > 0) {
      const fedStr = `fed $${(pay.fedCashCents / 100).toFixed(2)} @16%`;
      const selfStr = pay.selfCashCents > 0 ? ` + self $${(pay.selfCashCents / 100).toFixed(2)} @25%` : "";
      lineItems.push({
        payrollRunId: payrollRun.id,
        teamMemberId: closer.id,
        lineType: "commission",
        description: `New-business commission: ${fedStr}${selfStr} (${pay.dealsClosedCount} deals)`,
        quantity: pay.dealsClosedCount,
        rateCents: Math.round(pay.commission / Math.max(pay.dealsClosedCount, 1)),
        amountCents: pay.commission,
      });
    }
    if (pay.clawback < 0) {
      lineItems.push({
        payrollRunId: payrollRun.id,
        teamMemberId: closer.id,
        lineType: "commission",
        description: "Clawback — refund/chargeback within 60 days of collection",
        quantity: 1,
        rateCents: pay.clawback,
        amountCents: pay.clawback,
      });
    }
    if (pay.monthlyBase) {
      lineItems.push({
        payrollRunId: payrollRun.id,
        teamMemberId: closer.id,
        lineType: "base",
        description: `Monthly base — ${pay.monthlyBase.monthLabel}: ${pay.monthlyBase.note} (${pay.monthlyBase.closes} closes, ${pay.monthlyBase.fedCloses}/${pay.monthlyBase.fedDemosShowed} fed)`,
        quantity: 1,
        rateCents: pay.monthlyBase.amountCents,
        amountCents: pay.monthlyBase.amountCents,
      });
    }
  }

  // Show rate rep bonus
  const showRateResult = await calculateShowRateBonus(weekId);
  if (showRateResult && showRateResult.bonus > 0) {
    lineItems.push({
      payrollRunId: payrollRun.id,
      teamMemberId: showRateResult.teamMemberId,
      lineType: "show_rate_bonus",
      description: `Show rate bonus: ${showRateResult.tier} (${(showRateResult.showRate * 100).toFixed(1)}% show rate)`,
      quantity: 1,
      rateCents: showRateResult.bonus,
      amountCents: showRateResult.bonus,
    });
  }

  // Bulk create line items
  if (lineItems.length > 0) {
    await prisma.payrollLineItem.createMany({ data: lineItems });
  }

  return prisma.payrollRun.findUnique({
    where: { id: payrollRun.id },
    include: {
      lineItems: { include: { teamMember: true } },
    },
  });
}
