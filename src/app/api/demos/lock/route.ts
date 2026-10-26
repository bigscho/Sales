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

  // Official day cash = UPFRONT cash on the day's closed deals only (see
  // src/lib/cash.ts) — renewals/reorders/unlinked payments are Stripe's story.
  const { dealUpfrontCents } = await import("@/lib/cash");
  const cashCents = dayDemos.reduce((sum, d) => {
    if (d.deal?.status === "closed_won") {
      return sum + dealUpfrontCents(d.deal.payments);
    }
    return sum;
  }, 0);
  const unlinkedCash = 0;

  const dayLock = await prisma.dayLock.upsert({
    where: { weekId_date: { weekId, date: lockDate } },
    create: {
      weekId,
      date: lockDate,
      dayOfWeek,
      demoCount,
      showCount,
      noShowCount,
      cancelledCount,
      cashCents: cashCents + unlinkedCash,
    },
    update: {
      demoCount,
      showCount,
      noShowCount,
      cancelledCount,
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
      newValue: JSON.stringify({ date: lockDate, demoCount, showCount, noShowCount, cancelledCount, cashCents: cashCents + unlinkedCash }),
      performedBy: "admin",
    },
  });

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
