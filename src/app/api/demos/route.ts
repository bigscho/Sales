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

    // Fire setter game notifications for reassignment
    if (setterId && setterId !== oldSetterId) {
      try {
        const { getSetterTodayBookings, getTeamTotalToday, formatSetterMention, isWeekday } = await import("@/lib/setter-game");
        const { sendSlackSetter } = await import("@/lib/slack");

        const setter = await prisma.teamMember.findUnique({ where: { id: setterId } });
        if (setter) {
          const mention = formatSetterMention(setter);
          const prospectName = existingDemo.booking.prospectName;

          if (isWeekday()) {
            const { count } = await getSetterTodayBookings(setterId);
            const { total, setterTotal } = await getTeamTotalToday();
            const setterNote = total > setterTotal ? ` (${setterTotal} by setters)` : "";
            await sendSlackSetter(`📝 Booking credited: ${prospectName} → ${mention} (now at ${count} today)\n\n*TOTAL booked today: ${total}${setterNote}*`);
          } else {
            await sendSlackSetter(`📝 Booking credited: ${prospectName} → ${mention}`);
          }
        }
      } catch { /* setter notification failed */ }
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
    updateData.confirmedBy = "admin";
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

  // Show rate notification — fires when a demo is newly marked as showed
  if (status === "showed" && oldDemo?.status !== "showed") {
    try {
      const { sendShowNotification } = await import("@/lib/setter-game");
      await sendShowNotification(
        demo.booking.prospectName,
        demo.booking.setter?.id || null,
        demo.closer?.name || null,
        "admin",
      );
    } catch { /* show rate notification failed */ }
  }

  // Show rate CORRECTION — fires when a demo is changed AWAY from showed
  if (oldDemo?.status === "showed" && status && status !== "showed") {
    try {
      const { getWeeklyShowStats, formatMention } = await import("@/lib/setter-game");
      const { sendSlackShowRate } = await import("@/lib/slack");
      const { totalShows } = await getWeeklyShowStats();

      let setterMention = "";
      if (demo.booking.setter) {
        setterMention = ` (${formatMention(demo.booking.setter)}'s booking)`;
      }

      await sendSlackShowRate(`⚠️ Correction: ${demo.booking.prospectName} moved from showed → ${status}${setterMention}\n\n*Updated shows for the week: ${totalShows}*`);
    } catch { /* correction failed */ }
  }

  return NextResponse.json({ demo });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  if (action === "bulk_confirm") {
    const { demoIds, status } = body;
    await prisma.demo.updateMany({
      where: { id: { in: demoIds } },
      data: {
        status,
        confirmedBy: "admin",
        confirmedAt: new Date(),
      },
    });
    return NextResponse.json({ success: true });
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

  // Unlink any successor booking that points at this one in a reschedule chain
  await prisma.booking.updateMany({
    where: { rescheduledFromId: demo.bookingId },
    data: { rescheduledFromId: null },
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

  // Setter channel correction — booking was deleted
  if (demo.booking.setterId) {
    try {
      const { getSetterTodayBookings, getTeamTotalToday, formatMention, isWeekday } = await import("@/lib/setter-game");
      const { sendSlackSetter } = await import("@/lib/slack");

      if (isWeekday()) {
        const setter = await prisma.teamMember.findUnique({ where: { id: demo.booking.setterId } });
        if (setter) {
          const { count } = await getSetterTodayBookings(demo.booking.setterId);
          const mention = formatMention(setter);
          const { total, setterTotal } = await getTeamTotalToday();
          const setterNote = total > setterTotal ? ` (${setterTotal} by setters)` : "";
          await sendSlackSetter(`⚠️ Booking removed for ${demo.booking.prospectName}\n${mention} is now at ${count} today\n\n*TOTAL booked today: ${total}${setterNote}*`);
        }
      }
    } catch { /* setter correction failed */ }
  }

  // Show rate correction — if deleted demo was showed
  if (demo.status === "showed") {
    try {
      const { getWeeklyShowStats } = await import("@/lib/setter-game");
      const { sendSlackShowRate } = await import("@/lib/slack");
      const { totalShows } = await getWeeklyShowStats();
      await sendSlackShowRate(`⚠️ Correction: ${demo.booking.prospectName} demo removed (was showed)\n\n*Updated shows for the week: ${totalShows}*`);
    } catch { /* correction failed */ }
  }

  return NextResponse.json({ success: true });
}
