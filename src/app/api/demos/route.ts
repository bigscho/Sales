import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  const setterId = request.nextUrl.searchParams.get("setter");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  const demos = await prisma.demo.findMany({
    where: {
      weekId,
      ...(setterId ? { booking: { setterId } } : {}),
    },
    include: {
      booking: { include: { setter: true } },
      closer: true,
      deal: true,
    },
    orderBy: { booking: { demoDate: "asc" } },
  });

  return NextResponse.json({ demos });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { demoId, status, closerId, setterId, notes, leadSource } = body;
  const session = await getSession();
  const performedBy = session?.name || "admin";

  const existingDemo = await prisma.demo.findUnique({
    where: { id: demoId },
    include: { booking: { include: { setter: true } }, deal: true },
  });

  // Closer self-claim (EOD "make sure you got credit for what you ran"): a
  // non-admin closer may reassign a demo ONLY to themselves, and ONLY when
  // Fireflies detected them as the presenter — evidence-gated so no one can pull
  // a teammate's demo (and its commission). Admins reassign freely.
  if (closerId !== undefined && session?.role === "closer" && !session?.isAdmin) {
    if (closerId !== session.memberId) {
      return NextResponse.json({ error: "You can only claim a demo to yourself." }, { status: 403 });
    }
    if (existingDemo?.detectedCloserId !== session.memberId) {
      return NextResponse.json({ error: "You can only claim demos the transcript shows you ran." }, { status: 403 });
    }
  }

  // Demo outcomes are set by whoever ran or supervised the demo — admin or a
  // closer. Setters and reps read this API for the page but never write status.
  if (status && !(session?.isAdmin || session?.role === "closer")) {
    return NextResponse.json({ error: "Only admins and closers can set demo status." }, { status: 403 });
  }

  // A demo can't have showed or no-showed before it happens — outcome stamps
  // ahead of the meeting time are rejected (15-min grace for early joins).
  // Cancellations/reschedules are legitimately recorded ahead of time.
  if (existingDemo && (status === "showed" || status === "no_show")) {
    const startMs = new Date(existingDemo.booking.demoDate).getTime();
    if (Date.now() < startMs - 15 * 60 * 1000) {
      return NextResponse.json(
        { error: "This demo hasn't started yet — outcomes can only be set once the meeting time arrives." },
        { status: 400 }
      );
    }
  }

  // Check if demo's day is locked
  if (existingDemo && (status || setterId !== undefined || closerId !== undefined)) {
    const demoDate = new Date(existingDemo.booking.demoDate);
    const dayStart = new Date(Date.UTC(demoDate.getUTCFullYear(), demoDate.getUTCMonth(), demoDate.getUTCDate()));
    const lock = await prisma.dayLock.findUnique({
      where: { weekId_date: { weekId: existingDemo.weekId, date: dayStart } },
    });
    if (lock) {
      return NextResponse.json({ error: "Cannot update: day is locked" }, { status: 403 });
    }
  }

  // Handle setter reassignment (setterId lives on booking, not demo)
  if (setterId !== undefined && existingDemo) {
    const oldSetterId = existingDemo.booking.setterId;
    await prisma.booking.update({
      where: { id: existingDemo.booking.id },
      data: { setterId: setterId || null },
    });

    await prisma.auditLog.create({
      data: {
        entityType: "booking",
        entityId: existingDemo.booking.id,
        action: "setter_reassigned",
        oldValue: JSON.stringify({ setterId: oldSetterId }),
        newValue: JSON.stringify({ setterId }),
        performedBy,
      },
    });

    // Refresh the new setter's daily score. Weekday-only, same gate as before.
    if (setterId && setterId !== oldSetterId) {
      try {
        const { getSetterTodayBookings, isWeekday } = await import("@/lib/setter-game");
        if (isWeekday()) {
          await getSetterTodayBookings(setterId);
        }
      } catch (err) {
        console.error("setter score update failed:", err);
      }
    }
  }

  // Handle fed/self-sourced correction (leadSource lives on booking; a linked
  // deal carries a copy that must stay in sync — commission reads the deal)
  if (leadSource !== undefined && existingDemo && ["fed", "self_sourced"].includes(leadSource)) {
    const oldLeadSource = existingDemo.booking.leadSource;
    if (leadSource !== oldLeadSource) {
      await prisma.booking.update({
        where: { id: existingDemo.booking.id },
        data: { leadSource },
      });
      await prisma.deal.updateMany({
        where: { demoId },
        data: { leadSource },
      });
      await prisma.auditLog.create({
        data: {
          entityType: "booking",
          entityId: existingDemo.booking.id,
          action: "lead_source_update",
          oldValue: JSON.stringify({ leadSource: oldLeadSource }),
          newValue: JSON.stringify({ leadSource }),
          performedBy,
        },
      });
    }
  }

  const updateData: Record<string, unknown> = {};
  if (status) {
    updateData.status = status;
    updateData.confirmedBy = performedBy;
    updateData.confirmedAt = new Date();
  }
  if (closerId !== undefined) updateData.closerId = closerId;
  if (notes !== undefined) updateData.notes = notes;

  const oldDemo = existingDemo;

  const demo = await prisma.demo.update({
    where: { id: demoId },
    data: updateData,
    include: {
      booking: { include: { setter: true } },
      closer: true,
    },
  });

  // Audit log
  await prisma.auditLog.create({
    data: {
      entityType: "demo",
      entityId: demoId,
      action: "status_update",
      oldValue: JSON.stringify({ status: oldDemo?.status }),
      newValue: JSON.stringify({ status: demo.status }),
      performedBy,
    },
  });

  // Closer reassignment cascades to the linked deal so commission (payroll reads
  // deal.closerId on demand) and the close follow the presenter — "moves both"
  // (Colin, 2026-08-17). Day-lock above already protects confirmed/paid weeks.
  // This is the reconcile path when two closers cover each other's double-bookings.
  if (closerId !== undefined && closerId !== existingDemo?.closerId) {
    await prisma.auditLog.create({
      data: {
        entityType: "demo",
        entityId: demoId,
        action: "closer_reassigned",
        oldValue: JSON.stringify({ closerId: existingDemo?.closerId ?? null }),
        newValue: JSON.stringify({ closerId: closerId ?? null }),
        performedBy,
      },
    });
    if (existingDemo?.deal) {
      await prisma.deal.update({
        where: { id: existingDemo.deal.id },
        data: { closerId: closerId ?? null },
      });
      await prisma.auditLog.create({
        data: {
          entityType: "deal",
          entityId: existingDemo.deal.id,
          action: "closer_reassigned",
          oldValue: JSON.stringify({ closerId: existingDemo.deal.closerId }),
          newValue: JSON.stringify({ closerId: closerId ?? null }),
          performedBy,
        },
      });
    }
  }

  return NextResponse.json({ demo });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  if (action === "bulk_confirm") {
    const session = await getSession();
    if (!session?.isAdmin) {
      return NextResponse.json({ error: "Bulk status updates are admin-only." }, { status: 403 });
    }
    const { demoIds, status } = body;
    if (!Array.isArray(demoIds) || demoIds.length === 0 || !["showed", "no_show", "cancelled"].includes(status)) {
      return NextResponse.json({ error: "Invalid bulk update." }, { status: 400 });
    }

    const targets = await prisma.demo.findMany({
      where: { id: { in: demoIds } },
      select: { id: true, status: true, weekId: true, booking: { select: { demoDate: true } } },
    });

    // Same rules as single-row updates: outcomes can't be stamped ahead of the
    // meeting time (15-min grace; cancellations may be recorded early), and
    // locked days are frozen.
    const locks = await prisma.dayLock.findMany({
      where: { weekId: { in: [...new Set(targets.map((d) => d.weekId))] } },
      select: { weekId: true, date: true },
    });
    const lockedDays = new Set(locks.map((l) => `${l.weekId}:${l.date.toISOString().slice(0, 10)}`));
    const now = Date.now();
    const graceMs = 15 * 60 * 1000;

    let skippedFuture = 0;
    let skippedLocked = 0;
    const eligible: typeof targets = [];
    for (const d of targets) {
      if (status !== "cancelled" && new Date(d.booking.demoDate).getTime() - graceMs > now) {
        skippedFuture++;
        continue;
      }
      if (lockedDays.has(`${d.weekId}:${new Date(d.booking.demoDate).toISOString().slice(0, 10)}`)) {
        skippedLocked++;
        continue;
      }
      eligible.push(d);
    }

    if (eligible.length > 0) {
      await prisma.demo.updateMany({
        where: { id: { in: eligible.map((d) => d.id) } },
        data: {
          status,
          confirmedBy: session.name,
          confirmedAt: new Date(),
        },
      });
      await prisma.auditLog.createMany({
        data: eligible.map((d) => ({
          entityType: "demo",
          entityId: d.id,
          action: "status_update",
          oldValue: JSON.stringify({ status: d.status }),
          newValue: JSON.stringify({ status }),
          performedBy: session.name,
        })),
      });
    }

    return NextResponse.json({ success: true, updated: eligible.length, skippedFuture, skippedLocked });
  }

  if (action === "create") {
    const { weekId, prospectName, prospectEmail, setterId, demoDate, closerId } = body;

    const booking = await prisma.booking.create({
      data: {
        weekId,
        prospectName,
        prospectEmail,
        setterId,
        bookedAt: new Date(),
        demoDate: new Date(demoDate),
        source: "manual",
      },
    });

    const demo = await prisma.demo.create({
      data: {
        bookingId: booking.id,
        weekId,
        closerId,
      },
      include: {
        booking: { include: { setter: true } },
        closer: true,
      },
    });

    return NextResponse.json({ demo });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function DELETE(request: NextRequest) {
  // Deleting demos is an admin-only operation — company records are the
  // authoritative comp source (contract §4.11), so closers can't remove rows.
  const session = await getSession();
  if (session && !session.isAdmin) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { demoId } = await request.json();
  if (!demoId) {
    return NextResponse.json({ error: "demoId required" }, { status: 400 });
  }

  const demo = await prisma.demo.findUnique({
    where: { id: demoId },
    include: { booking: true },
  });
  if (!demo) {
    return NextResponse.json({ error: "Demo not found" }, { status: 404 });
  }

  // Check if day is locked
  const demoDate = new Date(demo.booking.demoDate);
  const dayStart = new Date(Date.UTC(demoDate.getUTCFullYear(), demoDate.getUTCMonth(), demoDate.getUTCDate()));
  const lock = await prisma.dayLock.findUnique({
    where: { weekId_date: { weekId: demo.weekId, date: dayStart } },
  });
  if (lock) {
    return NextResponse.json({ error: "Cannot delete: day is locked" }, { status: 403 });
  }

  // Unlink any deal referencing this demo
  await prisma.deal.updateMany({ where: { demoId }, data: { demoId: null } });

  // Add to dismissed events so syncs don't re-create it
  if (demo.booking.calendarEventId) {
    await prisma.dismissedEvent.upsert({
      where: { calendarEventId: demo.booking.calendarEventId },
      create: { calendarEventId: demo.booking.calendarEventId, reason: "deleted" },
      update: { reason: "deleted", dismissedAt: new Date() },
    });
  }

  // Unlink any successor booking that points at this one in a reschedule chain.
  // It becomes a standalone booking, so it now counts as its own booking event.
  await prisma.booking.updateMany({
    where: { rescheduledFromId: demo.bookingId },
    data: { rescheduledFromId: null, isBookingEvent: true },
  });

  // Delete demo then booking
  await prisma.demo.delete({ where: { id: demoId } });
  await prisma.booking.delete({ where: { id: demo.bookingId } });

  // Audit log — full snapshot of both rows so a fat-fingered delete is recoverable
  // and historical investigations can still see what was removed.
  await prisma.auditLog.create({
    data: {
      entityType: "demo",
      entityId: demoId,
      action: "deleted",
      oldValue: JSON.stringify({ booking: demo.booking, demo: { ...demo, booking: undefined } }),
      performedBy: "admin",
    },
  });

  // Refresh the setter's daily score after the booking is gone. Weekday-only, same gate as before.
  if (demo.booking.setterId) {
    try {
      const { getSetterTodayBookings, isWeekday } = await import("@/lib/setter-game");
      if (isWeekday()) {
        await getSetterTodayBookings(demo.booking.setterId);
      }
    } catch (err) {
      console.error("setter score update failed:", err);
    }
  }

  return NextResponse.json({ success: true });
}
