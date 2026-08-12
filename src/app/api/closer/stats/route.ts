import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { getWeekRange, computeShowRate } from "@/lib/utils";
import {
  CLOSER_COMP,
  computeCloserCommission,
  calculateCloserMonthlyBase,
} from "@/lib/payroll";

// Demos-run + closes performance for one closer over a date range:
// show rate on THEIR calendar and overall close rate (closes ÷ shows).
async function closerPerformance(closerId: string, start: Date, end: Date) {
  const [demos, closes] = await Promise.all([
    prisma.demo.findMany({
      where: { closerId, booking: { demoDate: { gte: start, lte: end } } },
      select: { status: true },
    }),
    prisma.deal.count({
      where: { closerId, status: "closed_won", closedAt: { gte: start, lte: end } },
    }),
  ]);
  const shows = demos.filter((d) => d.status === "showed").length;
  const noShows = demos.filter((d) => d.status === "no_show").length;
  const cancelled = demos.filter((d) => d.status === "cancelled").length;
  const pending = demos.filter((d) => d.status === "pending").length;
  return {
    demos: shows + noShows + cancelled + pending,
    shows,
    noShows,
    cancelled,
    pending,
    showRate: shows + noShows + cancelled > 0 ? computeShowRate(shows, noShows, cancelled) : null,
    closes,
    closeRate: shows > 0 ? closes / shows : null,
  };
}

// Closer self-serve numbers (contract §4.11 transparency): month-to-date closes,
// fed close rate, cash split, commission, projected base — everything the closer
// needs to reconcile their own pay against the contract. Closers see their own
// stats; admins can pass ?closerId= to see anyone's.
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const requestedId = request.nextUrl.searchParams.get("closerId");
  const closerId = session.isAdmin && requestedId ? requestedId : session.memberId;

  const closer = await prisma.teamMember.findUnique({ where: { id: closerId } });
  if (!closer || closer.role !== "closer") {
    return NextResponse.json({ error: "Not a closer" }, { status: 404 });
  }
  if (!session.isAdmin && closer.id !== session.memberId) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const comp = CLOSER_COMP[closer.id] || null;

  const now = new Date();
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, monthIndex, 1));
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
  const monthLabel = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  // Month-to-date activity (counts work for every closer, comped or not)
  const [demosShowed, fedDemosShowed, deals] = await Promise.all([
    prisma.demo.count({
      where: { closerId, status: "showed", booking: { demoDate: { gte: monthStart, lte: monthEnd } } },
    }),
    prisma.demo.count({
      where: {
        closerId,
        status: "showed",
        booking: { leadSource: { not: "self_sourced" }, demoDate: { gte: monthStart, lte: monthEnd } },
      },
    }),
    prisma.deal.findMany({
      where: { closerId, status: "closed_won", closedAt: { gte: monthStart, lte: monthEnd } },
      select: { leadSource: true },
    }),
  ]);

  const closes = deals.length;
  const fedCloses = deals.filter((d) => d.leadSource !== "self_sourced").length;
  const selfCloses = closes - fedCloses;
  const fedCloseRate = fedDemosShowed > 0 ? fedCloses / fedDemosShowed : null;

  // Show rate + overall close rate on demos THEY RAN — this week and this month
  const { start: weekStart, end: weekEnd } = getWeekRange(now);
  const [weekPerf, monthPerf] = await Promise.all([
    closerPerformance(closerId, weekStart, weekEnd),
    closerPerformance(closerId, monthStart, monthEnd),
  ]);

  // Money — only for comped closers (Will's contract terms)
  let money = null;
  if (comp) {
    const [monthCommission, weekCommission, projectedBase] = await Promise.all([
      computeCloserCommission(closer.id, comp, monthStart, monthEnd),
      computeCloserCommission(closer.id, comp, weekStart, weekEnd),
      calculateCloserMonthlyBase(closer.id, comp, year, monthIndex),
    ]);
    money = {
      rates: { fed: comp.fedRate, self: comp.selfRate },
      month: {
        fedCashCents: monthCommission.fedCashCents,
        selfCashCents: monthCommission.selfCashCents,
        commissionCents: monthCommission.commissionCents,
        clawbackCents: monthCommission.clawbackCents,
      },
      week: {
        fedCashCents: weekCommission.fedCashCents,
        selfCashCents: weekCommission.selfCashCents,
        commissionCents: weekCommission.commissionCents,
        clawbackCents: weekCommission.clawbackCents,
      },
      projectedBase: {
        amountCents: projectedBase.amountCents,
        note: projectedBase.note,
      },
    };
  }

  return NextResponse.json({
    closer: { id: closer.id, name: closer.name },
    monthLabel,
    activity: { demosShowed, fedDemosShowed, closes, fedCloses, selfCloses, fedCloseRate },
    performance: { week: weekPerf, month: monthPerf },
    money,
  });
}
