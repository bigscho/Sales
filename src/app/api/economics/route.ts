import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { dealUpfrontCents } from "@/lib/cash";
import { loadDealMeta, commissionExclusionReason } from "@/lib/payroll";

// === Sales economics (admin-only via middleware allowlists) ===
// COHORT basis for unit economics: a period owns the demos that RAN in it
// (booking.demoDate), and all the upfront cash those deals ever produce —
// so cash/booked-call, cash/show, cash/close compare like with like. Past
// periods restate UPWARD as late closes land; that is the honest cohort read.
// LANDED basis for "cash collected this period": commissionable payments that
// hit the bank in the period minus refunds that landed in it — identical rule
// to the closer scoreboard column and payroll.
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

    // Per-setter cohort economics. A booked call belongs to whoever set it,
    // regardless of demo outcome; rescheduled frozen rows are not calls.
    // Non-setter bookers (excludeFromLeaderboard: CEO self-books, junk "Booked
    // by" names) fold into one "Other" line, and no-setter rows into
    // "Unattributed" — the table must always sum to the period totals.
    const bySetter = new Map<string, { name: string; bookedCalls: number; shows: number; noShows: number; cancelled: number; cashCents: number }>();
    for (const d of demos) {
      if (d.status === "rescheduled") continue;
      let key = d.booking.setterId || "unattributed";
      let name = d.booking.setter?.name || "Unattributed";
      if (d.booking.setter?.excludeFromLeaderboard) {
        key = "other";
        name = "Other (non-setter bookers)";
      }
      const s = bySetter.get(key) || { name, bookedCalls: 0, shows: 0, noShows: 0, cancelled: 0, cashCents: 0 };
      s.bookedCalls++;
      if (d.status === "showed") s.shows++;
      else if (d.status === "no_show") s.noShows++;
      else if (d.status === "cancelled") s.cancelled++;
      if (d.deal?.status === "closed_won") s.cashCents += dealUpfrontCents(d.deal.payments);
      bySetter.set(key, s);
    }
    const setters = [...bySetter.entries()]
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.cashCents - a.cashCents || b.bookedCalls - a.bookedCalls);

    // Landed payment rows with the counted/excluded verdict, for the landed tile.
    const pays = await prisma.payment.findMany({
      where: { paidAt: { gte: start, lt: end }, dealId: { not: null }, deal: { status: "closed_won" } },
      include: { deal: { select: { prospectName: true } } },
      orderBy: { paidAt: "asc" },
    });
    const refs = await prisma.payment.findMany({
      where: { refundedAt: { gte: start, lt: end }, refundedCents: { gt: 0 }, dealId: { not: null }, deal: { status: "closed_won" } },
      include: { deal: { select: { prospectName: true } } },
      orderBy: { refundedAt: "asc" },
    });
    const meta = await loadDealMeta([...new Set([...pays, ...refs].map((p) => p.dealId!))]);
    const landedRows = pays.map((p) => {
      const reason = commissionExclusionReason(p, meta);
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
      .map((p) => ({
        id: `refund-${p.id}`,
        refundedAt: p.refundedAt,
        prospectName: p.deal!.prospectName,
        refundedCents: p.refundedCents,
      }));

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

    return NextResponse.json({ demoRows, setters, landedRows, refundRows, unlinkedRows, activeClosers });
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
  for (const p of periods) {
    const inPeriod = demos.filter((d) => d.booking.demoDate >= p.start && d.booking.demoDate < p.end);
    let bookedCalls = 0, shows = 0, closes = 0, cohortCashCents = 0;
    for (const d of inPeriod) {
      if (d.status === "rescheduled") continue; // frozen duplicate of a moved demo
      bookedCalls++;
      if (d.status === "showed") shows++;
      if (d.deal?.status === "closed_won") {
        closes++;
        cohortCashCents += dealUpfrontCents(d.deal.payments);
      }
    }
    series.push({
      label: p.label,
      start: p.start,
      end: p.end,
      bookedCalls,
      shows,
      closes,
      cohortCashCents,
      landedCashCents: landed[series.length],
      unmatchedNewCents: unmatchedNewQueue
        .filter((u) => u.paidAt >= p.start && u.paidAt < p.end)
        .reduce((s, u) => s + u.amountCents, 0),
      cashPerCallCents: bookedCalls > 0 ? Math.round(cohortCashCents / bookedCalls) : 0,
      cashPerShowCents: shows > 0 ? Math.round(cohortCashCents / shows) : 0,
      cashPerCloseCents: closes > 0 ? Math.round(cohortCashCents / closes) : 0,
    });
  }

  return NextResponse.json({ granularity, periods: series, unmatchedNewQueue });
}
