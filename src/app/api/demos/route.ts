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

  const updateData: Record<string, unknown> = {};
  if (status) {
    updateData.status = status;
    updateData.confirmedBy = "admin";
    updateData.confirmedAt = new Date();
  }
  if (closerId !== undefined) updateData.closerId = closerId;
  if (notes !== undefined) updateData.notes = notes;

  const oldDemo = await prisma.demo.findUnique({ where: { id: demoId } });

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
