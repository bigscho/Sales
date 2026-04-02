import { prisma } from "./db";

export interface WeeklyKPIs {
  weekId: string;
  weekStart: string;
  weekEnd: string;
  totalBookings: number;
  newBookings: number; // bookings created in this week (activity metric)
  totalShows: number;
  totalNoShows: number;
  totalPending: number;
  showRate: number;
  confirmedShowRate: number; // shows / (shows + noShows)
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
  bookings: number;
  shows: number;
  noShows: number;
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
  // Excludes bulk-imported historical data (source: "auto") — only real-time activity
  const newBookings = await prisma.booking.count({
    where: {
      createdAt: { gte: week.weekStart, lt: new Date(week.weekEnd.getTime() + 1) },
      source: { not: "auto" },
    },
  });

  const totalShows = allDemos.filter((d) => d.status === "showed").length;
  const totalNoShows = allDemos.filter((d) => d.status === "no_show").length;
  const totalPending = allDemos.filter((d) => d.status === "pending").length;
  const showRate = (totalShows + totalNoShows) > 0 ? totalShows / (totalShows + totalNoShows) : 0;
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

  // Setter stats
  const setterMap = new Map<string, SetterKPI>();
  for (const demo of allDemos) {
    const setter = demo.booking?.setter;
    if (!setter) continue;
    if (!setterMap.has(setter.id)) {
      setterMap.set(setter.id, {
        setterId: setter.id,
        setterName: setter.name,
        bookings: 0,
        shows: 0,
        noShows: 0,
        showRate: 0,
      });
    }
    const s = setterMap.get(setter.id)!;
    s.bookings++;
    if (demo.status === "showed") s.shows++;
    if (demo.status === "no_show") s.noShows++;
  }
  for (const s of setterMap.values()) {
    s.showRate = (s.shows + s.noShows) > 0 ? s.shows / (s.shows + s.noShows) : 0;
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
