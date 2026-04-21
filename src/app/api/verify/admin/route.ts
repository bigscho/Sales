import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackVerify } from "@/lib/slack";
import { computeShowRate } from "@/lib/utils";

// GET: Load full verification overview for a week (CEO view)
export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  const week = await prisma.week.findUnique({ where: { id: weekId } });
  if (!week) {
    return NextResponse.json({ error: "Week not found" }, { status: 404 });
  }

  // Get active setters (real setters only)
  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
    orderBy: { name: "asc" },
  });

  // Get all demos for this week with setter info
  const allDemos = await prisma.demo.findMany({
    where: { weekId },
    include: {
      booking: { select: { setterId: true, prospectName: true, prospectEmail: true, demoDate: true, source: true } },
      closer: { select: { name: true } },
    },
    orderBy: { booking: { demoDate: "asc" } },
  });

  // Get all verifications for this week
  const verifications = await prisma.setterVerification.findMany({
    where: { weekId },
    include: {
      flags: {
        include: {
          demo: { select: { id: true, status: true, booking: { select: { prospectName: true, demoDate: true } } } },
        },
      },
    },
  });

  // Get day locks
  const dayLocks = await prisma.dayLock.findMany({
    where: { weekId },
    select: { date: true },
  });
  const lockedDates = dayLocks.map(l => l.date.toISOString().slice(0, 10));

  // Get pending demo count (blocks lock week)
  const pendingDemos = allDemos.filter(d => d.status === "pending");

  // Build per-setter summary
  const setterSummaries = setters.map(setter => {
    const setterDemos = allDemos.filter(d => d.booking.setterId === setter.id);
    const shows = setterDemos.filter(d => d.status === "showed").length;
    const noShows = setterDemos.filter(d => d.status === "no_show").length;
    const pending = setterDemos.filter(d => d.status === "pending").length;
    const cancelled = setterDemos.filter(d => d.status === "cancelled").length;
    const showRate = computeShowRate(shows, noShows, cancelled);

    const verification = verifications.find(v => v.setterId === setter.id);
    const openFlags = verification?.flags.filter(f => f.ceoAction === "pending") || [];

    return {
      id: setter.id,
      name: setter.name,
      slackUserId: setter.slackUserId,
      totalDemos: setterDemos.length,
      shows,
      noShows,
      pending,
      cancelled,
      showRate,
      verification: verification ? {
        status: verification.status,
        confirmedAt: verification.confirmedAt,
      } : null,
      openFlags: openFlags.map(f => ({
        id: f.id,
        flagType: f.flagType,
        note: f.note,
        demoId: f.demoId,
        demoName: f.demo?.booking.prospectName || null,
        demoDate: f.demo?.booking.demoDate || null,
        demoStatus: f.demo?.status || null,
        missingProspectName: f.missingProspectName,
        missingProspectEmail: f.missingProspectEmail,
        missingDemoDate: f.missingDemoDate,
        ceoAction: f.ceoAction,
      })),
    };
  });

  // Unattributed demos
  const unattributed = allDemos.filter(d => !d.booking.setterId);

  return NextResponse.json({
    week: {
      id: week.id,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      status: week.status,
      confirmedBy: week.confirmedBy,
    },
    setters: setterSummaries,
    unattributedCount: unattributed.length,
    lockedDates,
    pendingDemoCount: pendingDemos.length,
    totalFlags: verifications.reduce((sum, v) => sum + v.flags.filter(f => f.ceoAction === "pending").length, 0),
  });
}

// POST: CEO actions — resolve flags, lock week
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  // === Resolve a flag ===
  if (action === "resolve_flag") {
    const { flagId, ceoAction, ceoNote } = body as {
      flagId: string;
      ceoAction: "approved" | "rejected";
      ceoNote?: string;
    };

    const flag = await prisma.setterFlag.update({
      where: { id: flagId },
      data: { ceoAction, ceoNote: ceoNote || null, resolvedAt: new Date() },
      include: { verification: { include: { setter: true } } },
    });

    return NextResponse.json({ success: true, flag });
  }

  // === Add a missing demo (from a setter's flag request) ===
  if (action === "add_missing_demo") {
    const { flagId, weekId, setterId, prospectName, prospectEmail, demoDate, closerId } = body;

    const effectiveDate = demoDate ? new Date(demoDate) : new Date();

    const booking = await prisma.booking.create({
      data: {
        weekId,
        prospectName,
        prospectEmail: prospectEmail || null,
        setterId,
        demoDate: effectiveDate,
        source: "manual",
      },
    });

    await prisma.demo.create({
      data: {
        bookingId: booking.id,
        weekId,
        closerId: closerId || null,
      },
    });

    // Mark the flag as approved
    if (flagId) {
      await prisma.setterFlag.update({
        where: { id: flagId },
        data: { ceoAction: "approved", ceoNote: "Demo added", resolvedAt: new Date() },
      });
    }

    return NextResponse.json({ success: true, bookingId: booking.id });
  }

  // === Lock Week ===
  if (action === "lock_week") {
    const { weekId } = body;

    // Check for pending demos
    const pendingCount = await prisma.demo.count({
      where: { weekId, status: "pending" },
    });
    if (pendingCount > 0) {
      return NextResponse.json(
        { error: `Cannot lock week: ${pendingCount} demo(s) still pending. Confirm or mark all demos first.` },
        { status: 400 }
      );
    }

    // Check for unresolved flags
    const unresolvedFlags = await prisma.setterFlag.count({
      where: { verification: { weekId }, ceoAction: "pending" },
    });
    if (unresolvedFlags > 0) {
      return NextResponse.json(
        { error: `Cannot lock week: ${unresolvedFlags} flag(s) unresolved. Resolve all flags first.` },
        { status: 400 }
      );
    }

    const week = await prisma.week.findUnique({ where: { id: weekId } });
    if (!week) {
      return NextResponse.json({ error: "Week not found" }, { status: 404 });
    }

    // Lock all unlocked days in the week
    const weekStart = new Date(week.weekStart);
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(weekStart);
      dayDate.setUTCDate(dayDate.getUTCDate() + i);
      dayDate.setUTCHours(0, 0, 0, 0);

      const nextDay = new Date(dayDate);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);

      // Check if already locked
      const existing = await prisma.dayLock.findUnique({
        where: { weekId_date: { weekId, date: dayDate } },
      });
      if (existing) continue;

      // Compute stats for this day
      const dayDemos = await prisma.demo.findMany({
        where: {
          weekId,
          booking: { demoDate: { gte: dayDate, lt: nextDay } },
        },
        include: { deal: { include: { payments: true } } },
      });

      const demoCount = dayDemos.length;
      if (demoCount === 0) continue; // Skip empty days

      const showCount = dayDemos.filter(d => d.status === "showed").length;
      const noShowCount = dayDemos.filter(d => d.status === "no_show").length;
      const cashCents = dayDemos.reduce((sum, d) => {
        if (d.deal?.status === "closed_won") {
          return sum + d.deal.payments.reduce((s, p) => s + p.amountCents, 0);
        }
        return sum;
      }, 0);

      await prisma.dayLock.create({
        data: {
          weekId,
          date: dayDate,
          dayOfWeek: dayDate.getUTCDay(),
          demoCount,
          showCount,
          noShowCount,
          cashCents,
          lockedBy: "ceo_verify",
        },
      });
    }

    // Mark all unconfirmed setters as CEO-confirmed
    const setters = await prisma.teamMember.findMany({
      where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
    });
    for (const setter of setters) {
      await prisma.setterVerification.upsert({
        where: { setterId_weekId: { setterId: setter.id, weekId } },
        create: { setterId: setter.id, weekId, status: "confirmed", confirmedAt: new Date() },
        update: {}, // Don't overwrite existing confirmations
      });
    }

    // Confirm the week
    await prisma.week.update({
      where: { id: weekId },
      data: { status: "confirmed", confirmedBy: "ceo_verify", confirmedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        entityType: "week",
        entityId: weekId,
        action: "week_locked_via_verify",
        newValue: JSON.stringify({ lockedBy: "ceo_verify" }),
        performedBy: "ceo",
      },
    });

    // Slack notification
    const weekLabel = weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    await sendSlackVerify(`🔒 *Week of ${weekLabel} locked by CEO.* Numbers are final.`);

    return NextResponse.json({ success: true, weekStatus: "confirmed" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
