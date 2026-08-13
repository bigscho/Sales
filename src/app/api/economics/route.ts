import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { dealUpfrontCents } from "@/lib/cash";
import { loadDealMeta, commissionExclusionReason } from "@/lib/payroll";

// === Sales economics (admin-only via middleware allowlists) ===
// LANDED basis everywhere (Colin, Aug 13: "shows new revenue THIS WEEK vs
// almost hiding it because the demo was last week"): the per-X metrics are
// cash that HIT THE BANK in the period (commissionable payments minus refunds
// landed — identical rule to the closer scoreboard and payroll) divided by
// the activity that happened in the period: booked calls and shows by
// demoDate, closes by closedAt (same as the scoreboard). Numerator and
// denominator are different cohorts by design — that's the trade-off for a
// number that never hides late-collected money and never restates.
// COHORT cash (a period's demos' eventual upfront cash, dealUpfrontCents) is
// kept as a reference column in the history table — it restates upward as
// late closes land and shows what each week's demos were ultimately worth.
//
// ?granularity=weekly|monthly|all_time        → period series (newest first)
// ?start=ISO&end=ISO&detail=true              → receipts for one period:
//   cohort demo rows, per-setter economics, landed payment rows.

type PeriodDef = { label: string; start: Date; end: Date };

async function buildPeriods(granularity: string): Promise<PeriodDef[]> {
  if (granularity === "monthly") {
    const now = new Date();
    const periods: PeriodDef[] = [];
    for (let i = 0; i < 6; i++) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
      periods.push({
        label: start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
        start,
        end,
      });
    }
    return periods;
  }
  if (granularity === "all_time") {
    return [{ label: "All-Time", start: new Date(0), end: new Date(Date.now() + 7 * 86400000) }];
  }
  // weekly (default): the last 12 defined weeks, current first
  const weeks = await prisma.week.findMany({
    where: { weekStart: { lte: new Date() } },
    orderBy: { weekStart: "desc" },
    take: 12,
  });
  return weeks.map((w) => ({
    label: `${w.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} – ${w.weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
    start: w.weekStart,
    end: new Date(w.weekEnd.getTime() + 1), // weekEnd is 23:59:59.999 → exclusive bound
  }));
}

// Landed cash per period, one query set for the whole span: commissionable
// payments that landed minus refunds that landed — the scoreboard/payroll rule.
async function landedCashByPeriod(periods: PeriodDef[]): Promise<number[]> {
  const spanStart = periods[periods.length - 1].start;
  const spanEnd = periods[0].end;
  const pays = await prisma.payment.findMany({
    where: { paidAt: { gte: spanStart, lt: spanEnd }, dealId: { not: null }, deal: { status: "closed_won" } },
  });
  const refs = await prisma.payment.findMany({
    where: { refundedAt: { gte: spanStart, lt: spanEnd }, refundedCents: { gt: 0 }, dealId: { not: null }, deal: { status: "closed_won" } },
  });
  const meta = await loadDealMeta([...new Set([...pays, ...refs].map((p) => p.dealId!))]);
  return periods.map((per) => {
    let cents = 0;
    for (const p of pays) {
      if (p.paidAt >= per.start && p.paidAt < per.end && commissionExclusionReason(p, meta) === null) cents += p.amountCents;
    }
    for (const p of refs) {
      if (p.refundedAt && p.refundedAt >= per.start && p.refundedAt < per.end && commissionExclusionReason(p, meta) === null) cents -= p.refundedCents;
    }
    return cents;
  });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // === DEMO SEARCH (reconcile drawer): find a demo in ANY week to match a
  // payment to — past demos are the common case for late-arriving cash.
  const demoSearch = params.get("demoSearch");
  if (demoSearch !== null) {
    if (demoSearch.trim().length < 2) return NextResponse.json({ demos: [] });
    const demos = await prisma.demo.findMany({
      where: { booking: { prospectName: { contains: demoSearch.trim(), mode: "insensitive" } } },
      include: {
        booking: { select: { prospectName: true, demoDate: true } },
        closer: { select: { name: true } },
        deal: { select: { status: true } },
      },
      orderBy: { booking: { demoDate: "desc" } },
      take: 10,
    });
    return NextResponse.json({
      demos: demos.map((d) => ({
        id: d.id,
        prospectName: d.booking.prospectName,
        demoDate: d.booking.demoDate,
        status: d.status,
        closerName: d.closer?.name || null,
        dealStatus: d.deal?.status || null,
      })),
    });
  }

  // === RECEIPTS for one period ===
  if (params.get("detail") === "true") {
    const start = new Date(params.get("start") || 0);
    const end = new Date(params.get("end") || Date.now());

    const demos = await prisma.demo.findMany({
      where: { booking: { demoDate: { gte: start, lt: end } } },
      include: {
        booking: { select: { prospectName: true, demoDate: true, setterId: true, setter: { select: { name: true, excludeFromLeaderboard: true } } } },
        closer: { select: { name: true } },
        deal: { include: { payments: true } },
      },
      orderBy: { booking: { demoDate: "asc" } },
    });

    const demoRows = demos.map((d) => ({
      id: d.id,
      demoDate: d.booking.demoDate,
      prospectName: d.booking.prospectName,
      setterName: d.booking.setter?.name || null,
      closerName: d.closer?.name || null,
      status: d.status,
      dealStatus: d.deal?.status || null,
      upfrontCents: d.deal?.status === "closed_won" ? dealUpfrontCents(d.deal.payments) : 0,
    }));

    // Per-setter activity (booked calls/shows by demoDate — rescheduled frozen
    // rows are not calls). Cash is LANDED: payments that hit the bank this
    // period, attributed to the setter of the deal's booking. Non-setter
    // bookers (excludeFromLeaderboard) fold into "Other", no-setter rows into
    // "Unattributed", demo-less organic deals into "Organic (no demo)" — the
    // table must always sum to the period totals.
    const setterBucket = (setter: { name: string; excludeFromLeaderboard: boolean | null } | null, setterId: string | null) => {
      if (setter?.excludeFromLeaderboard) return { key: "other", name: "Other (non-setter bookers)" };
      if (!setterId || !setter) return { key: "unattributed", name: "Unattributed" };
      return { key: setterId, name: setter.name };
    };
    const bySetter = new Map<string, { name: string; bookedCalls: number; shows: number; noShows: number; cancelled: number; cashCents: number }>();
    const getBucket = (key: string, name: string) => {
      const s = bySetter.get(key) || { name, bookedCalls: 0, shows: 0, noShows: 0, cancelled: 0, cashCents: 0 };
      bySetter.set(key, s);
      return s;
    };
    for (const d of demos) {
      if (d.status === "rescheduled") continue;
      const { key, name } = setterBucket(d.booking.setter, d.booking.setterId);
      const s = getBucket(key, name);
      s.bookedCalls++;
      if (d.status === "showed") s.shows++;
      else if (d.status === "no_show") s.noShows++;
      else if (d.status === "cancelled") s.cancelled++;
    }

    // Landed payment rows with the counted/excluded verdict, for the landed tile.
    const pays = await prisma.payment.findMany({
      where: { paidAt: { gte: start, lt: end }, dealId: { not: null }, deal: { status: "closed_won" } },
      include: {
        deal: {
          select: {
            prospectName: true,
            demo: { select: { booking: { select: { setterId: true, setter: { select: { name: true, excludeFromLeaderboard: true } } } } } },
          },
        },
      },
      orderBy: { paidAt: "asc" },
    });
    const refs = await prisma.payment.findMany({
      where: { refundedAt: { gte: start, lt: end }, refundedCents: { gt: 0 }, dealId: { not: null }, deal: { status: "closed_won" } },
      include: {
        deal: {
          select: {
            prospectName: true,
            demo: { select: { booking: { select: { setterId: true, setter: { select: { name: true, excludeFromLeaderboard: true } } } } } },
          },
        },
      },
      orderBy: { refundedAt: "asc" },
    });
    const meta = await loadDealMeta([...new Set([...pays, ...refs].map((p) => p.dealId!))]);

    // Setter cash = landed counted payments (minus landed refunds) attributed
    // through the deal's booking. Demo-less organic deals get their own line.
    const paymentBucket = (p: (typeof pays)[number]) => {
      if (!p.deal!.demo) return { key: "organic", name: "Organic (no demo)" };
      const b = p.deal!.demo.booking;
      return setterBucket(b.setter, b.setterId);
    };
    const landedRows = pays.map((p) => {
      const reason = commissionExclusionReason(p, meta);
      if (reason === null) {
        const { key, name } = paymentBucket(p);
        getBucket(key, name).cashCents += p.amountCents;
      }
      return {
        id: p.id,
        paidAt: p.paidAt,
        prospectName: p.deal!.prospectName,
        amountCents: p.amountCents,
        counted: reason === null,
        excludedReason: reason,
        override: p.upfrontOverride, // include | exclude | null — drives the reconcile drawer controls
      };
    });
    const refundRows = refs
      .filter((p) => commissionExclusionReason(p, meta) === null)
      .map((p) => {
        const { key, name } = paymentBucket(p);
        getBucket(key, name).cashCents -= p.refundedCents;
        return {
          id: `refund-${p.id}`,
          refundedAt: p.refundedAt,
          prospectName: p.deal!.prospectName,
          refundedCents: p.refundedCents,
        };
      });
    const setters = [...bySetter.entries()]
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.cashCents - a.cashCents || b.bookedCalls - a.bookedCalls);

    // Deals closed-won in the period (by closedAt — the closes receipts).
    const closedInPeriod = await prisma.deal.findMany({
      where: { status: "closed_won", closedAt: { gte: start, lt: end } },
      include: {
        closer: { select: { name: true } },
        demo: { select: { booking: { select: { demoDate: true } } } },
      },
      orderBy: { closedAt: "asc" },
    });
    const closedRows = closedInPeriod.map((d) => {
      const demoDate = d.demo?.booking?.demoDate || null;
      return {
        id: d.id,
        prospectName: d.prospectName,
        closedAt: d.closedAt,
        closerName: d.closer?.name || null,
        demoDate,
        demoInPeriod: demoDate !== null && demoDate >= start && demoDate < end,
      };
    });

    // Unlinked payments landed in the period — money that counts NOWHERE.
    // New-client ones are a work queue (match on the demos-page financial
    // feed and they flow into cash + commission); returning ones are shown
    // grayed so "total money in" always reconciles against Stripe.
    const unlinked = await prisma.payment.findMany({
      where: { paidAt: { gte: start, lt: end }, dealId: null, status: { not: "failed" } },
      orderBy: { paidAt: "asc" },
    });
    const unlinkedRows = unlinked.map((p) => ({
      id: p.id,
      paidAt: p.paidAt,
      name: p.customerName || p.customerEmail || "Unknown",
      email: p.customerEmail,
      amountCents: p.amountCents,
      isNew: (p.customerStatusOverride || p.customerStatus) === "new",
    }));

    const activeClosers = await prisma.teamMember.findMany({
      where: { role: "closer", isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    return NextResponse.json({ demoRows, setters, landedRows, refundRows, unlinkedRows, closedRows, activeClosers });
  }

  // === PERIOD SERIES ===
  const granularity = params.get("granularity") || "weekly";
  const periods = await buildPeriods(granularity);
  if (periods.length === 0) return NextResponse.json({ granularity, periods: [] });

  const spanStart = periods[periods.length - 1].start;
  const spanEnd = periods[0].end;

  const demos = await prisma.demo.findMany({
    where: { booking: { demoDate: { gte: spanStart, lt: spanEnd } } },
    include: {
      booking: { select: { demoDate: true } },
      deal: { include: { payments: true } },
    },
  });

  const landed = await landedCashByPeriod(periods);

  // Closes by closedAt (same basis as the scoreboard closer board) — a deal
  // counts in the period it was WON, wherever its demo ran.
  const closedDeals = await prisma.deal.findMany({
    where: {
      status: "closed_won",
      closedAt: { gte: periods[periods.length - 1].start, lt: periods[0].end },
    },
    select: { closedAt: true },
  });

  // Unmatched NEW-client payments: cash that counts nowhere until an operator
  // matches it to a demo (demos-page financial feed). Surfaced as a standing
  // work queue (all time, not just the visible span) so it can't rot silently.
  const allUnlinked = await prisma.payment.findMany({
    where: { dealId: null, status: { not: "failed" } },
    orderBy: { paidAt: "desc" },
  });
  const unmatchedNewQueue = allUnlinked
    .filter((p) => (p.customerStatusOverride || p.customerStatus) === "new")
    .map((p) => ({
      id: p.id,
      paidAt: p.paidAt,
      name: p.customerName || p.customerEmail || "Unknown",
      email: p.customerEmail,
      amountCents: p.amountCents,
    }));

  const series = [];
  for (const [i, p] of periods.entries()) {
    const inPeriod = demos.filter((d) => d.booking.demoDate >= p.start && d.booking.demoDate < p.end);
    let bookedCalls = 0, shows = 0, cohortCashCents = 0;
    for (const d of inPeriod) {
      if (d.status === "rescheduled") continue; // frozen duplicate of a moved demo
      bookedCalls++;
      if (d.status === "showed") shows++;
      if (d.deal?.status === "closed_won") {
        cohortCashCents += dealUpfrontCents(d.deal.payments);
      }
    }
    const closes = closedDeals.filter((d) => d.closedAt && d.closedAt >= p.start && d.closedAt < p.end).length;
    const landedCents = landed[i];
    series.push({
      label: p.label,
      start: p.start,
      end: p.end,
      bookedCalls,
      shows,
      closes,
      cohortCashCents,
      landedCashCents: landedCents,
      unmatchedNewCents: unmatchedNewQueue
        .filter((u) => u.paidAt >= p.start && u.paidAt < p.end)
        .reduce((s, u) => s + u.amountCents, 0),
      cashPerCallCents: bookedCalls > 0 ? Math.round(landedCents / bookedCalls) : 0,
      cashPerShowCents: shows > 0 ? Math.round(landedCents / shows) : 0,
      cashPerCloseCents: closes > 0 ? Math.round(landedCents / closes) : 0,
    });
  }

  return NextResponse.json({ granularity, periods: series, unmatchedNewQueue });
}
