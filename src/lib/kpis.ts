import { prisma } from "./db";
import { computeShowRate } from "./utils";

export interface WeeklyKPIs {
  weekId: string;
  weekStart: string;
  weekEnd: string;
  totalBookings: number;
  newBookings: number; // bookings created in this week (activity metric)
  totalShows: number;
  totalNoShows: number;
  totalPending: number;
  totalCancelled: number;
  showRate: number; // shows / (shows + noShows + cancelled) — cancels count against us
  confirmedShowRate: number; // shows / (shows + noShows) — excludes cancels, for reference
  totalConfirmed: number; // shows + noShows
  totalCloses: number;
  totalHeld: number;
  totalLost: number;
  closeRate: number; // closes / shows
  cashCollected: number; // cents
  avgCashPerClose: number; // cents
  cashPerBooking: number; // cents
  cashPerShow: number; // cents
  newRevenue: number; // cents
  returningRevenue: number; // cents
  setterStats: SetterKPI[];
  closerStats: CloserKPI[];
}

export interface SetterKPI {
  setterId: string;
  setterName: string;
  newBookings: number;
  shows: number;
  noShows: number;
  pending: number;
  cancelled: number;
  pendingTotal: number;
  showRate: number;
}

export interface CloserKPI {
  closerId: string;
  closerName: string;
  shows: number;
  closes: number;
  held: number;
  lost: number;
  closeRate: number;
  cashCollected: number;
}

export async function calculateWeeklyKPIs(weekId: string): Promise<WeeklyKPIs> {
  const week = await prisma.week.findUniqueOrThrow({ where: { id: weekId } });

  const allDemos = await prisma.demo.findMany({
    where: { weekId },
    include: {
      booking: { include: { setter: true } },
      closer: true,
      deal: { include: { payments: true } },
    },
  });

  const totalBookings = allDemos.length;

  // Activity metric: bookings CREATED during this week (regardless of demo date)
  // Only counts real setter activity: Calendly webhooks + manual entries
  // Excludes "auto" (historical import) and "gcal_sync" (backup/discovery mechanism)
  const newBookings = await prisma.booking.count({
    where: {
      createdAt: { gte: week.weekStart, lt: new Date(week.weekEnd.getTime() + 1) },
      source: { in: ["calendly_webhook", "manual"] },
    },
  });

  const totalShows = allDemos.filter((d) => d.status === "showed").length;
  const totalNoShows = allDemos.filter((d) => d.status === "no_show").length;
  const totalPending = allDemos.filter((d) => d.status === "pending").length;
  const totalCancelled = allDemos.filter((d) => d.status === "cancelled").length;
  const showRate = computeShowRate(totalShows, totalNoShows, totalCancelled);
  const totalConfirmed = totalShows + totalNoShows;
  const confirmedShowRate = totalConfirmed > 0 ? totalShows / totalConfirmed : 0;

  const deals = await prisma.deal.findMany({
    where: { weekId },
    include: { payments: true },
  });

  const totalCloses = deals.filter((d) => d.status === "closed_won").length;
  const totalHeld = deals.filter((d) => d.status === "held").length;
  const totalLost = deals.filter((d) => d.status === "closed_lost").length;
  const closeRate = totalShows > 0 ? totalCloses / totalShows : 0;

  const cashCollected = deals
    .filter((d) => d.status === "closed_won")
    .reduce((sum, d) => sum + d.payments.reduce((s, p) => s + p.amountCents, 0), 0);

  // Also include unlinked payments for this week (not tied to a deal but assigned to this week)
  const unlinkedPayments = await prisma.payment.findMany({
    where: { weekId, dealId: null, status: "succeeded" },
  });
  const unlinkedCash = unlinkedPayments.reduce((sum, p) => sum + p.amountCents, 0);
  const totalCash = cashCollected + unlinkedCash;

  const allWeekPayments = await prisma.payment.findMany({
    where: { weekId, status: "succeeded" },
  });
  const newRevenue = allWeekPayments
    .filter(p => (p.customerStatusOverride || p.customerStatus) === "new")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const returningRevenue = allWeekPayments
    .filter(p => (p.customerStatusOverride || p.customerStatus) === "returning")
    .reduce((sum, p) => sum + p.amountCents, 0);

  const avgCashPerClose = totalCloses > 0 ? Math.round(totalCash / totalCloses) : 0;
  const cashPerBooking = totalBookings > 0 ? Math.round(totalCash / totalBookings) : 0;
  const cashPerShow = totalShows > 0 ? Math.round(totalCash / totalShows) : 0;

  // Setter stats — per-setter new bookings (activity by createdAt)
  const setterNewBookings = await prisma.booking.findMany({
    where: {
      createdAt: { gte: week.weekStart, lt: new Date(week.weekEnd.getTime() + 1) },
      source: { in: ["calendly_webhook", "manual"] },
      setterId: { not: null },
    },
    select: { setterId: true },
  });
  const newBookingsBySetter: Record<string, number> = {};
  for (const b of setterNewBookings) {
    newBookingsBySetter[b.setterId!] = (newBookingsBySetter[b.setterId!] || 0) + 1;
  }

  // Setter stats — per-setter pending total (this week forward only, not historical)
  const setterPendingTotal = await prisma.demo.findMany({
    where: {
      status: "pending",
      booking: { setterId: { not: null }, demoDate: { gte: week.weekStart } },
    },
    include: { booking: { select: { setterId: true } } },
  });
  const pendingTotalBySetter: Record<string, number> = {};
  for (const d of setterPendingTotal) {
    const sid = d.booking.setterId!;
    pendingTotalBySetter[sid] = (pendingTotalBySetter[sid] || 0) + 1;
  }

  // Setter stats — results from calendar (demos scheduled this week)
  const setterMap = new Map<string, SetterKPI>();
  for (const demo of allDemos) {
    const setter = demo.booking?.setter;
    if (!setter) continue;
    if (setter.excludeFromLeaderboard) continue;
    if (!setterMap.has(setter.id)) {
      setterMap.set(setter.id, {
        setterId: setter.id,
        setterName: setter.name,
        newBookings: newBookingsBySetter[setter.id] || 0,
        shows: 0,
        noShows: 0,
        pending: 0,
        cancelled: 0,
        pendingTotal: pendingTotalBySetter[setter.id] || 0,
        showRate: 0,
      });
    }
    const s = setterMap.get(setter.id)!;
    if (demo.status === "showed") s.shows++;
    else if (demo.status === "no_show") s.noShows++;
    else if (demo.status === "pending") s.pending++;
    else if (demo.status === "cancelled") s.cancelled++;
  }
  for (const s of setterMap.values()) {
    s.showRate = computeShowRate(s.shows, s.noShows, s.cancelled);
  }

  // Closer stats
  const closerMap = new Map<string, CloserKPI>();
  for (const demo of allDemos.filter((d) => d.status === "showed")) {
    const closer = demo.closer;
    if (!closer) continue;
    if (!closerMap.has(closer.id)) {
      closerMap.set(closer.id, {
        closerId: closer.id,
        closerName: closer.name,
        shows: 0,
        closes: 0,
        held: 0,
        lost: 0,
        closeRate: 0,
        cashCollected: 0,
      });
    }
    const c = closerMap.get(closer.id)!;
    c.shows++;
    if (demo.deal?.status === "closed_won") {
      c.closes++;
      c.cashCollected += demo.deal.payments.reduce((s, p) => s + p.amountCents, 0);
    }
    if (demo.deal?.status === "held") c.held++;
    if (demo.deal?.status === "closed_lost") c.lost++;
  }
  for (const c of closerMap.values()) {
    c.closeRate = c.shows > 0 ? c.closes / c.shows : 0;
  }

  return {
    weekId,
    weekStart: week.weekStart.toISOString(),
    weekEnd: week.weekEnd.toISOString(),
    totalBookings,
    newBookings,
    totalShows,
    totalNoShows,
    totalPending,
    totalCancelled,
    showRate,
    confirmedShowRate,
    totalConfirmed,
    totalCloses,
    totalHeld,
    totalLost,
    closeRate,
    cashCollected: totalCash,
    avgCashPerClose,
    cashPerBooking,
    cashPerShow,
    newRevenue,
    returningRevenue,
    setterStats: Array.from(setterMap.values()),
    closerStats: Array.from(closerMap.values()),
  };
}
