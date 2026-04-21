import { prisma } from "./db";

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

interface CloserPayResult {
  teamMemberId: string;
  name: string;
  dealsClosedCount: number;
  month1Cash: number; // cents
  commission: number; // cents
  weeklyBase: number; // cents
  totalPay: number; // cents
  deals: { prospectName: string; month1Cash: number }[];
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

export async function calculateCloserPay(closerId: string, weekId: string): Promise<CloserPayResult> {
  const closer = await prisma.teamMember.findUniqueOrThrow({ where: { id: closerId } });

  const deals = await prisma.deal.findMany({
    where: {
      weekId,
      closerId,
      status: "closed_won",
    },
    include: {
      payments: { where: { isMonth1: true } },
    },
  });

  const dealDetails = deals.map((d) => ({
    prospectName: d.prospectName,
    month1Cash: d.payments.reduce((sum, p) => sum + p.amountCents, 0),
  }));

  const totalMonth1Cash = dealDetails.reduce((sum, d) => sum + d.month1Cash, 0);
  const commission = Math.round(totalMonth1Cash * 0.20);
  const weeklyBase = Math.round(200000 / 4.33); // $2000/month / 4.33 weeks

  return {
    teamMemberId: closer.id,
    name: closer.name,
    dealsClosedCount: deals.length,
    month1Cash: totalMonth1Cash,
    commission,
    weeklyBase,
    totalPay: weeklyBase + commission,
    deals: dealDetails,
  };
}

export async function calculateShowRateBonus(weekId: string): Promise<ShowRateRepResult | null> {
  const rep = await prisma.teamMember.findFirst({
    where: { role: "show_rate_rep", isActive: true },
  });
  if (!rep) return null;

  // Denominator = everything on the calendar that didn't get rescheduled.
  // Cancels count against us because we failed to get them to show.
  const totalBooked = await prisma.demo.count({
    where: { weekId, status: { not: "rescheduled" } },
  });
  const totalShowed = await prisma.demo.count({
    where: { weekId, status: "showed" },
  });

  const showRate = totalBooked > 0 ? totalShowed / totalBooked : 0;

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

  // Closer pay
  for (const closer of closers) {
    const pay = await calculateCloserPay(closer.id, weekId);
    lineItems.push({
      payrollRunId: payrollRun.id,
      teamMemberId: closer.id,
      lineType: "base",
      description: "Weekly base ($2,000/mo)",
      quantity: 1,
      rateCents: pay.weeklyBase,
      amountCents: pay.weeklyBase,
    });
    if (pay.commission > 0) {
      lineItems.push({
        payrollRunId: payrollRun.id,
        teamMemberId: closer.id,
        lineType: "commission",
        description: `20% of $${(pay.month1Cash / 100).toFixed(2)} Month 1 cash (${pay.dealsClosedCount} deals)`,
        quantity: pay.dealsClosedCount,
        rateCents: Math.round(pay.commission / Math.max(pay.dealsClosedCount, 1)),
        amountCents: pay.commission,
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
