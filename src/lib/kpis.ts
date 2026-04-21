import { prisma } from "./db";

export interface WeeklyKPIs {
  weekId: string;
  weekStart: string;
  weekEnd: string;
  totalBookings: number;
  totalShows: number;
  totalNoShows: number;
  totalPending: number;
  totalCancelled: number;
  totalRescheduled: number;
  showRate: number; // shows / totalBookings (cancels count against us; rescheduled don't)
  totalCloses: number;
  totalHeld: number;
  totalLost: number;
  closeRate: number; // closes / shows
  cashCollected: number; // cents
  avgCashPerClose: number; // cents
  cashPerBooking: number; // cents
  cashPerShow: number; // cents
  setterStats: SetterKPI[];
  closerStats: CloserKPI[];
}

export interface SetterKPI {
  setterId: string;
  setterName: string;
  bookings: number;
  shows: number;
  noShows: number;
  cancelled: number;
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

  // Rescheduled demos moved to a new date and are not on the calendar for this week — exclude from denominator.
  // Cancels stay in the denominator: they sat on the calendar and we failed to get them to show.
  const countedDemos = allDemos.filter((d) => d.status !== "rescheduled");
  const totalBookings = countedDemos.length;
  const totalShows = countedDemos.filter((d) => d.status === "showed").length;
  const totalNoShows = countedDemos.filter((d) => d.status === "no_show").length;
  const totalPending = countedDemos.filter((d) => d.status === "pending").length;
  const totalCancelled = countedDemos.filter((d) => d.status === "cancelled").length;
  const totalRescheduled = allDemos.filter((d) => d.status === "rescheduled").length;
  const showRate = totalBookings > 0 ? totalShows / totalBookings : 0;

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

  const avgCashPerClose = totalCloses > 0 ? Math.round(cashCollected / totalCloses) : 0;
  const cashPerBooking = totalBookings > 0 ? Math.round(cashCollected / totalBookings) : 0;
  const cashPerShow = totalShows > 0 ? Math.round(cashCollected / totalShows) : 0;

  // Setter stats — cancels count in the denominator, rescheduled do not.
  const setterMap = new Map<string, SetterKPI>();
  for (const demo of countedDemos) {
    const setter = demo.booking?.setter;
    if (!setter) continue;
    if (!setterMap.has(setter.id)) {
      setterMap.set(setter.id, {
        setterId: setter.id,
        setterName: setter.name,
        bookings: 0,
        shows: 0,
        noShows: 0,
        cancelled: 0,
        showRate: 0,
      });
    }
    const s = setterMap.get(setter.id)!;
    s.bookings++;
    if (demo.status === "showed") s.shows++;
    if (demo.status === "no_show") s.noShows++;
    if (demo.status === "cancelled") s.cancelled++;
  }
  for (const s of setterMap.values()) {
    s.showRate = s.bookings > 0 ? s.shows / s.bookings : 0;
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
    totalShows,
    totalNoShows,
    totalPending,
    totalCancelled,
    totalRescheduled,
    showRate,
    totalCloses,
    totalHeld,
    totalLost,
    closeRate,
    cashCollected,
    avgCashPerClose,
    cashPerBooking,
    cashPerShow,
    setterStats: Array.from(setterMap.values()),
    closerStats: Array.from(closerMap.values()),
  };
}
