import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  const dayLocks = await prisma.dayLock.findMany({
    where: { weekId },
    orderBy: { date: "asc" },
  });

  return NextResponse.json({ dayLocks });
}

export async function POST(request: NextRequest) {
  // Locking a payroll day is admin-only — locks freeze the official daily stats
  const session = await getSession();
  if (session && !session.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json();
  const { weekId, date } = body;

  if (!weekId || !date) {
    return NextResponse.json({ error: "weekId and date required" }, { status: 400 });
  }

  const lockDate = new Date(date);
  lockDate.setUTCHours(0, 0, 0, 0);
  const dayOfWeek = lockDate.getUTCDay();

  // Check for pending demos on this day
  const nextDay = new Date(lockDate);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const pendingDemos = await prisma.demo.count({
    where: {
      weekId,
      status: "pending",
      booking: {
        demoDate: { gte: lockDate, lt: nextDay },
      },
    },
  });

  if (pendingDemos > 0) {
    return NextResponse.json(
      { error: `Cannot lock day: ${pendingDemos} demo(s) still pending review` },
      { status: 400 }
    );
  }

  // Compute stats for the day
  const dayDemos = await prisma.demo.findMany({
    where: {
      weekId,
      booking: {
        demoDate: { gte: lockDate, lt: nextDay },
      },
    },
    include: {
      deal: { include: { payments: true } },
    },
  });

  const demoCount = dayDemos.length;
  const showCount = dayDemos.filter((d) => d.status === "showed").length;
  const noShowCount = dayDemos.filter((d) => d.status === "no_show").length;
  const cancelledCount = dayDemos.filter((d) => d.status === "cancelled").length;

  // Cash from deals closed on demos from this day — net of refunds
  const netCents = (p: { amountCents: number; refundedCents: number; status: string }) =>
    p.status === "failed" ? 0 : p.amountCents - p.refundedCents;
  const cashCents = dayDemos.reduce((sum, d) => {
    if (d.deal?.status === "closed_won") {
      return sum + d.deal.payments.reduce((s, p) => s + netCents(p), 0);
    }
    return sum;
  }, 0);

  // Also count unlinked payments from this calendar day
  const dayPayments = await prisma.payment.findMany({
    where: {
      dealId: null,
      paidAt: { gte: lockDate, lt: nextDay },
    },
  });
  const unlinkedCash = dayPayments.reduce((s, p) => s + netCents(p), 0);

  const dayLock = await prisma.dayLock.upsert({
    where: { weekId_date: { weekId, date: lockDate } },
    create: {
      weekId,
      date: lockDate,
      dayOfWeek,
      demoCount,
      showCount,
      noShowCount,
      cashCents: cashCents + unlinkedCash,
    },
    update: {
      demoCount,
      showCount,
      noShowCount,
      cashCents: cashCents + unlinkedCash,
    },
  });

  // Check if all 7 days are now locked → auto-confirm week
  const allLocks = await prisma.dayLock.count({ where: { weekId } });
  let weekConfirmed = false;

  if (allLocks >= 7) {
    await prisma.week.update({
      where: { id: weekId },
      data: {
        status: "confirmed",
        confirmedBy: "auto_daylock",
        confirmedAt: new Date(),
      },
    });
    weekConfirmed = true;
  }

  await prisma.auditLog.create({
    data: {
      entityType: "day_lock",
      entityId: dayLock.id,
      action: "lock_day",
      newValue: JSON.stringify({ date: lockDate, demoCount, showCount, noShowCount, cashCents: cashCents + unlinkedCash }),
      performedBy: "admin",
    },
  });

  // No-show Slack blast to #noshow-tpds
  if (noShowCount > 0) {
    try {
      const { sendSlackNoShow } = await import("@/lib/slack");
      const { formatMention } = await import("@/lib/setter-game");

      const noShowDemos = await prisma.demo.findMany({
        where: {
          weekId,
          status: "no_show",
          booking: { demoDate: { gte: lockDate, lt: nextDay } },
        },
        include: { booking: { include: { setter: true } }, closer: true },
      });

      const dayLabel = lockDate.toLocaleDateString("en-US", {
        weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
      });

      const lines = [`🚫 *No-Shows for ${dayLabel} (${noShowCount} total):*`, ""];
      for (const ns of noShowDemos) {
        const setterTag = ns.booking.setter ? formatMention(ns.booking.setter) : "Unknown setter";
        const closerTag = ns.closer ? ns.closer.name : "TBD";
        const time = new Date(ns.booking.demoDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
        lines.push(`• ${ns.booking.prospectName} (${time}) — set by ${setterTag}, closer: ${closerTag}`);
      }

      await sendSlackNoShow(lines.join("\n"));
    } catch { /* no-show notification failed */ }
  }

  // Official daily stats to #sales-team on day lock
  try {
    const { sendSlackTeam } = await import("@/lib/slack");
    const { formatCents } = await import("@/lib/utils");

    const dayLabel = lockDate.toLocaleDateString("en-US", {
      weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
    });
    const { computeShowRate } = await import("@/lib/utils");
    const srDenom = showCount + noShowCount + cancelledCount;
    const showRateVal = srDenom > 0
      ? (computeShowRate(showCount, noShowCount, cancelledCount) * 100).toFixed(1)
      : "0.0";

    await sendSlackTeam(
      `📊 *OFFICIAL Daily Recap — ${dayLabel}* 🔒\n\n` +
      `Demos: *${demoCount}* | Shows: *${showCount}* | No-shows: *${noShowCount}*${cancelledCount > 0 ? ` | Cancelled: *${cancelledCount}*` : ""}\n` +
      `Show rate: *${showRateVal}%*\n` +
      `Cash collected: *${formatCents(cashCents + unlinkedCash)}*`
    );
  } catch { /* official stats failed */ }

  return NextResponse.json({ dayLock, weekConfirmed });
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (session && !session.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json();
  const { weekId, date } = body;

  const lockDate = new Date(date);
  lockDate.setUTCHours(0, 0, 0, 0);

  try {
    await prisma.dayLock.delete({
      where: { weekId_date: { weekId, date: lockDate } },
    });

    // Revert week status if it was auto-confirmed
    const week = await prisma.week.findUnique({ where: { id: weekId } });
    if (week?.confirmedBy === "auto_daylock") {
      await prisma.week.update({
        where: { id: weekId },
        data: { status: "draft", confirmedBy: null, confirmedAt: null },
      });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Lock not found" }, { status: 404 });
  }
}
