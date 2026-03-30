import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  const demos = await prisma.demo.findMany({
    where: { weekId },
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
  const { demoId, status, closerId, notes } = body;

  // Check if demo's day is locked
  const existingDemo = await prisma.demo.findUnique({
    where: { id: demoId },
    include: { booking: true },
  });
  if (existingDemo && status) {
    const demoDate = new Date(existingDemo.booking.demoDate);
    const dayStart = new Date(Date.UTC(demoDate.getUTCFullYear(), demoDate.getUTCMonth(), demoDate.getUTCDate()));
    const lock = await prisma.dayLock.findUnique({
      where: { weekId_date: { weekId: existingDemo.weekId, date: dayStart } },
    });
    if (lock) {
      return NextResponse.json({ error: "Cannot update: day is locked" }, { status: 403 });
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
      performedBy: "admin",
    },
  });

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

  // Delete demo then booking
  await prisma.demo.delete({ where: { id: demoId } });
  await prisma.booking.delete({ where: { id: demo.bookingId } });

  // Audit log
  await prisma.auditLog.create({
    data: {
      entityType: "demo",
      entityId: demoId,
      action: "deleted",
      oldValue: JSON.stringify({ prospect: demo.booking.prospectName, status: demo.status }),
      performedBy: "admin",
    },
  });

  return NextResponse.json({ success: true });
}
