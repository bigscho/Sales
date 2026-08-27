import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { type TimeDimension, getDateRange } from "@/lib/time-range";
import { getWeekRange, computeShowRate } from "@/lib/utils";
import { loadDealMeta, isCommissionable, commissionExclusionReason } from "@/lib/payroll";
import { newBookingActivityWhere } from "@/lib/booking-activity";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  const dimension = (request.nextUrl.searchParams.get("dimension") as TimeDimension) || "weekly";

  // Get all setters (exclude non-setter bookers like CEO, guests)
  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
    orderBy: { name: "asc" },
  });

  // Get the show rate rep
  const showRateRep = await prisma.teamMember.findFirst({
    where: { role: "show_rate_rep", isActive: true },
  });

  // Compute date range based on dimension
  let dateRange: { start: Date; end: Date } | null = null;
  if (dimension === "weekly" && weekId) {
    // Use the selected week's boundaries
    const week = await prisma.week.findUnique({ where: { id: weekId } });
    if (week) {
      dateRange = { start: week.weekStart, end: week.weekEnd };
    } else {
      dateRange = getWeekRange(new Date());
    }
  } else {
    dateRange = getDateRange(dimension);
  }

  // Build date filter for queries
  const dateFilter = dateRange
    ? { gte: dateRange.start, lt: dimension === "weekly" ? new Date(dateRange.end.getTime() + 1) : dateRange.end }
    : undefined;

  // === CLOSER DRILL-DOWN: ?closerId=X returns the raw rows behind that closer's
  // board numbers, using the SAME dateFilter as the board itself so the detail
  // can never drift from the aggregate. Tallies are recomputed from the listed
  // rows — the drill-down IS the audit trail. No cash anywhere (team-visible).
  const detailCloserId = request.nextUrl.searchParams.get("closerId");
  if (detailCloserId) {
    const closer = await prisma.teamMember.findUnique({ where: { id: detailCloserId } });
    if (!closer) return NextResponse.json({ error: "Unknown closer" }, { status: 404 });

    const demos = await prisma.demo.findMany({
      where: {
        closerId: detailCloserId,
        ...(dateFilter ? { booking: { demoDate: dateFilter } } : {}),
      },
      include: {
        booking: {
          select: {
            prospectName: true,
            demoDate: true,
            leadSource: true,
            setter: { select: { name: true } },
          },
        },
      },
      orderBy: { booking: { demoDate: "asc" } },
    });

    const closedDeals = await prisma.deal.findMany({
      where: {
        status: "closed_won",
        closerId: detailCloserId,
        ...(dateFilter ? { closedAt: dateFilter } : {}),
      },
      include: {
        demo: { include: { booking: { select: { demoDate: true } } } },
      },
      orderBy: { closedAt: "asc" },
    });

    // Mirror the board's bucketing exactly: rescheduled rows fall through every
    // branch and are NOT part of the demo count (frozen history of a moved demo).
    const t = { shows: 0, noShows: 0, pending: 0, cancelled: 0, rescheduled: 0 };
    const demoRows = demos.map((d) => {
      if (d.status === "showed") t.shows++;
      else if (d.status === "no_show") t.noShows++;
      else if (d.status === "pending") t.pending++;
      else if (d.status === "cancelled") t.cancelled++;
      else if (d.status === "rescheduled") t.rescheduled++;
      const countsAs =
        d.status === "showed" || d.status === "no_show" || d.status === "cancelled"
          ? "show-rate denominator"
          : d.status === "pending"
          ? "demo count only (still TBD)"
          : "not counted (moved/frozen)";
      return {
        id: d.id,
        demoDate: d.booking.demoDate,
        prospectName: d.booking.prospectName,
        setterName: d.booking.setter?.name || "—",
        leadSource: d.booking.leadSource,
        status: d.status,
        countsAs,
      };
    });

    // Cash collected this period on this closer's deals — payment by payment,
    // counted rows AND excluded rows (with the reason), so the column total can
    // always be traced by hand. Same commissionable rule as payroll.
    const rawPayments = await prisma.payment.findMany({
      where: {
        ...(dateFilter ? { paidAt: dateFilter } : {}),
        deal: { closerId: detailCloserId },
      },
      include: { deal: { select: { id: true, prospectName: true, leadSource: true, status: true } } },
      orderBy: { paidAt: "asc" },
    });
    const rawRefunds = await prisma.payment.findMany({
      where: {
        refundedCents: { gt: 0 },
        ...(dateFilter ? { refundedAt: dateFilter } : { refundedAt: { not: null } }),
        deal: { closerId: detailCloserId },
      },
      include: { deal: { select: { id: true, prospectName: true, leadSource: true, status: true } } },
      orderBy: { refundedAt: "asc" },
    });
    const cashMeta = await loadDealMeta([
      ...new Set([...rawPayments, ...rawRefunds].map((p) => p.dealId!).filter(Boolean)),
    ]);
    const exclusionReason = (p: (typeof rawPayments)[number]): string | null =>
      p.deal!.status !== "closed_won"
        ? `deal is ${p.deal!.status.replace("_", " ")}, not closed-won`
        : commissionExclusionReason(p, cashMeta);

    let cashTotalCents = 0;
    const paymentRows = rawPayments.map((p) => {
      const reason = exclusionReason(p);
      if (reason === null) cashTotalCents += p.amountCents;
      return {
        id: p.id,
        paidAt: p.paidAt,
        prospectName: p.deal!.prospectName,
        dealId: p.deal!.id,
        leadSource: p.deal!.leadSource,
        amountCents: p.amountCents,
        counted: reason === null,
        excludedReason: reason,
      };
    });
    const refundRows = rawRefunds
      .filter((p) => exclusionReason(p) === null) // only reverse cash we counted (now or in a prior period)
      .map((p) => {
        cashTotalCents -= p.refundedCents;
        return {
          id: `refund-${p.id}`,
          refundedAt: p.refundedAt,
          paidAt: p.paidAt,
          prospectName: p.deal!.prospectName,
          dealId: p.deal!.id,
          leadSource: p.deal!.leadSource,
          refundedCents: p.refundedCents,
        };
      });

    const activeClosers = await prisma.teamMember.findMany({
      where: { role: "closer", isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    const closeRows = closedDeals.map((deal) => {
      const demoDate = deal.demo?.booking?.demoDate || null;
      const demoInPeriod =
        !dateFilter || (demoDate !== null && demoDate >= dateFilter.gte && demoDate < dateFilter.lt);
      return {
        id: deal.id,
        prospectName: deal.prospectName,
        closedAt: deal.closedAt,
        leadSource: deal.leadSource,
        demoDate,
        demoInPeriod,
      };
    });

    return NextResponse.json({
      closer: { id: closer.id, name: closer.name },
      range: dateRange ? { start: dateRange.start, end: dateRange.end } : null,
      dimension,
      demos: demoRows,
      closes: closeRows,
      cash: {
        payments: paymentRows,
        refunds: refundRows,
        totalCents: cashTotalCents,
      },
      activeClosers,
      tallies: {
        demos: t.shows + t.noShows + t.pending + t.cancelled,
        ...t,
        showRate: computeShowRate(t.shows, t.noShows, t.cancelled),
        closes: closeRows.length,
        closeRate: t.shows > 0 ? closeRows.length / t.shows : 0,
      },
    });
  }

  // === ACTIVITY: bookings by bookedAt (with createdAt fallback) in range ===
  // Includes gcal_sync so the leaderboard stays accurate when the Calendly webhook is down —
  // gcal_sync is the 10-min backup path and writes real setterId from the event description.
  // Counts CHAIN ROOTS ONLY (see newBookingActivityWhere): one credit per prospect, in the
  // week it was first booked, under the original setter. A rescheduled/rebooked successor is
  // never its own activity, so a past week's count is frozen once the week ends and can no
  // longer restate. Matches every other activity aggregate in the app (all use the same helper).
  const activityBookings = await prisma.booking.findMany({
    where: {
      ...newBookingActivityWhere(dateFilter ?? undefined),
      source: { in: ["calendly_webhook", "manual", "gcal_sync"] },
    },
    select: { setterId: true },
  });

  const activityBySetterId: Record<string, number> = {};
  let activityTotal = 0;
  for (const b of activityBookings) {
    const sid = b.setterId || "unattributed";
    activityBySetterId[sid] = (activityBySetterId[sid] || 0) + 1;
    activityTotal++;
  }

  // Immutable reference: rows physically created during this period. createdAt is
  // never mutated and (under the immutable-history model) rows never migrate weeks,
  // so this is the "what we saw live during the week" number and will never restate.
  const asBookedTotal = dateFilter
    ? await prisma.booking.count({
        where: {
          createdAt: dateFilter,
          source: { in: ["calendly_webhook", "manual", "gcal_sync"] },
          supersededAt: null,
        },
      })
    : activityTotal;

  // === RESULTS: demos by demoDate in range ===
  const resultsDemos = await prisma.demo.findMany({
    where: {
      ...(dateFilter ? { booking: { demoDate: dateFilter } } : {}),
    },
    include: { booking: { select: { setterId: true } } },
  });

  const resultsBySetterId: Record<string, { shows: number; noShows: number; pending: number; cancelled: number }> = {};
  const resultsTotal = { shows: 0, noShows: 0, pending: 0, cancelled: 0 };

  for (const demo of resultsDemos) {
    const sid = demo.booking.setterId || "unattributed";
    if (!resultsBySetterId[sid]) resultsBySetterId[sid] = { shows: 0, noShows: 0, pending: 0, cancelled: 0 };
    if (demo.status === "showed") { resultsBySetterId[sid].shows++; resultsTotal.shows++; }
    else if (demo.status === "no_show") { resultsBySetterId[sid].noShows++; resultsTotal.noShows++; }
    else if (demo.status === "pending") { resultsBySetterId[sid].pending++; resultsTotal.pending++; }
    else if (demo.status === "cancelled") { resultsBySetterId[sid].cancelled++; resultsTotal.cancelled++; }
  }

  // === PENDING TOTAL: pending demos from current period forward (not historical) ===
  const pendingTotalBySetterId: Record<string, number> = {};
  let pendingTotalAll = 0;
  const pendingCutoff = dateRange ? dateRange.start : undefined;
  const allPendingDemos = await prisma.demo.findMany({
    where: {
      status: "pending",
      ...(pendingCutoff ? { booking: { demoDate: { gte: pendingCutoff } } } : {}),
    },
    include: { booking: { select: { setterId: true } } },
  });
  for (const demo of allPendingDemos) {
    const sid = demo.booking.setterId || "unattributed";
    pendingTotalBySetterId[sid] = (pendingTotalBySetterId[sid] || 0) + 1;
    pendingTotalAll++;
  }

  // Closers double as setters — include any active closer who has setter-credited
  // activity in the period (bookings/demos/pending with their setterId). They ride
  // the same aggregates; setter PAYROLL stays role-gated so this is display-only.
  const closers = await prisma.teamMember.findMany({
    where: { role: "closer", isActive: true, excludeFromLeaderboard: { not: true } },
    orderBy: { name: "asc" },
  });
  const activeCloserSetters = closers.filter((c) =>
    (activityBySetterId[c.id] || 0) > 0 ||
    resultsBySetterId[c.id] !== undefined ||
    (pendingTotalBySetterId[c.id] || 0) > 0
  );

  // === CLOSER BOARD: whole team sees closer activity — demos run, show rate
  // on THEIR calendar, closes, close rate. Deliberately no cash (sales money
  // is upfront-only and lives on admin views / each closer's own My Numbers).
  const closerDemos = await prisma.demo.findMany({
    where: {
      closerId: { not: null },
      ...(dateFilter ? { booking: { demoDate: dateFilter } } : {}),
    },
    select: { closerId: true, status: true },
  });
  const closerAgg: Record<string, { shows: number; noShows: number; pending: number; cancelled: number }> = {};
  for (const d of closerDemos) {
    const cid = d.closerId!;
    if (!closerAgg[cid]) closerAgg[cid] = { shows: 0, noShows: 0, pending: 0, cancelled: 0 };
    if (d.status === "showed") closerAgg[cid].shows++;
    else if (d.status === "no_show") closerAgg[cid].noShows++;
    else if (d.status === "pending") closerAgg[cid].pending++;
    else if (d.status === "cancelled") closerAgg[cid].cancelled++;
  }
  const closerDeals = await prisma.deal.findMany({
    where: {
      status: "closed_won",
      closerId: { not: null },
      ...(dateFilter ? { closedAt: dateFilter } : {}),
    },
    select: { closerId: true },
  });
  const closesByCloser: Record<string, number> = {};
  for (const d of closerDeals) {
    closesByCloser[d.closerId!] = (closesByCloser[d.closerId!] || 0) + 1;
  }

  // === CASH COLLECTED (Colin, 2026-08-13: cash per closer is team-visible on
  // this board). Upfront payments that LANDED in the period on closed-won deals
  // minus refunds that landed in the period — the same commissionable rule and
  // cash-collected basis as payroll, so this column always reconciles with
  // commission. The ?closerId drill-down lists every row behind each cell.
  const boardPayments = await prisma.payment.findMany({
    where: {
      ...(dateFilter ? { paidAt: dateFilter } : {}),
      dealId: { not: null },
      deal: { status: "closed_won" },
    },
    include: { deal: { select: { closerId: true } } },
  });
  const boardRefunds = await prisma.payment.findMany({
    where: {
      refundedCents: { gt: 0 },
      ...(dateFilter ? { refundedAt: dateFilter } : { refundedAt: { not: null } }),
      dealId: { not: null },
      deal: { status: "closed_won" },
    },
    include: { deal: { select: { closerId: true } } },
  });
  const boardMeta = await loadDealMeta([
    ...new Set([...boardPayments, ...boardRefunds].map((p) => p.dealId!)),
  ]);
  const cashByCloser: Record<string, number> = {};
  let unattributedCashCents = 0;
  for (const p of boardPayments) {
    if (!isCommissionable(p, boardMeta)) continue;
    const cid = p.deal!.closerId;
    if (cid) cashByCloser[cid] = (cashByCloser[cid] || 0) + p.amountCents;
    else unattributedCashCents += p.amountCents;
  }
  for (const p of boardRefunds) {
    if (!isCommissionable(p, boardMeta)) continue;
    const cid = p.deal!.closerId;
    if (cid) cashByCloser[cid] = (cashByCloser[cid] || 0) - p.refundedCents;
    else unattributedCashCents -= p.refundedCents;
  }

  const closerBoard = closers
    .map((c) => {
      const r = closerAgg[c.id] || { shows: 0, noShows: 0, pending: 0, cancelled: 0 };
      const closes = closesByCloser[c.id] || 0;
      return {
        id: c.id,
        name: c.name,
        demos: r.shows + r.noShows + r.pending + r.cancelled,
        ...r,
        showRate: computeShowRate(r.shows, r.noShows, r.cancelled),
        closes,
        closeRate: r.shows > 0 ? closes / r.shows : 0,
        cashCents: cashByCloser[c.id] || 0,
      };
    })
    .filter((c) => c.demos > 0 || c.closes > 0 || c.cashCents !== 0);

  // Build scoreboard entries
  const scoreboard = [...setters, ...activeCloserSetters].map((s) => {
    const activity = activityBySetterId[s.id] || 0;
    const results = resultsBySetterId[s.id] || { shows: 0, noShows: 0, pending: 0, cancelled: 0 };
    const pendingTotal = pendingTotalBySetterId[s.id] || 0;
    return {
      id: s.id,
      name: s.name,
      tier: s.tier,
      creditBalance: s.creditBalance || 0,
      activity: { newBookings: activity },
      results: {
        ...results,
        showRate: computeShowRate(results.shows, results.noShows, results.cancelled),
      },
      pendingTotal,
    };
  });

  const teamShowRate = computeShowRate(resultsTotal.shows, resultsTotal.noShows, resultsTotal.cancelled);

  // Unattributed
  const unattributedActivity = activityBySetterId["unattributed"] || 0;
  const unattributedResults = resultsBySetterId["unattributed"] || { shows: 0, noShows: 0, pending: 0, cancelled: 0 };
  const unattributedPendingTotal = pendingTotalBySetterId["unattributed"] || 0;

  return NextResponse.json({
    scoreboard,
    closerBoard,
    unattributedCashCents,
    teamTotals: {
      activity: { newBookings: activityTotal, asBooked: asBookedTotal },
      results: { ...resultsTotal, showRate: teamShowRate },
      pendingTotal: pendingTotalAll,
    },
    unattributed: {
      activity: { newBookings: unattributedActivity },
      results: {
        ...unattributedResults,
        showRate: computeShowRate(unattributedResults.shows, unattributedResults.noShows, unattributedResults.cancelled),
      },
      pendingTotal: unattributedPendingTotal,
    },
    showRateRep: showRateRep ? {
      id: showRateRep.id,
      name: showRateRep.name,
      showRate: teamShowRate,
    } : null,
    dimension,
  });
}
