import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

// Diagnostic endpoint: look up a booking by name or email
// GET /api/admin/lookup?name=andrea
// GET /api/admin/lookup?email=andrea@regencypropertiesnc.com
// GET /api/admin/lookup?name=andrea&fix=true             → resets cancelled/no_show → pending
// GET /api/admin/lookup?name=andrea&fix=true&date=2026-04-02T20:00:00.000Z → also moves demoDate

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name");
  const email = searchParams.get("email");
  const fix = searchParams.get("fix") === "true";
  const dateParam = searchParams.get("date"); // ISO date string to move the booking to

  if (!name && !email) {
    return NextResponse.json({ error: "Provide ?name= or ?email=" }, { status: 400 });
  }

  const bookings = await prisma.booking.findMany({
    where: {
      ...(email
        ? { prospectEmail: { equals: email, mode: "insensitive" } }
        : { prospectName: { contains: name!, mode: "insensitive" } }),
    },
    include: {
      demo: true,
      week: true,
    },
    orderBy: { demoDate: "desc" },
    take: 10,
  });

  if (bookings.length === 0) {
    return NextResponse.json({ found: 0, bookings: [] });
  }

  if (fix) {
    const targetDate = dateParam ? new Date(dateParam) : null;
    const fixResults: string[] = [];

    for (const booking of bookings) {
      const status = booking.demo?.status;
      // Fix cancelled or no_show demos (not showed — that's intentional)
      if (status === "cancelled" || status === "no_show") {
        const effectiveDate = targetDate ?? booking.demoDate;
        const { start, end } = getWeekRange(effectiveDate);
        const week = await prisma.week.upsert({
          where: { weekStart: start },
          create: { weekStart: start, weekEnd: end },
          update: {},
        });
        await prisma.booking.update({
          where: { id: booking.id },
          data: { demoDate: effectiveDate, weekId: week.id },
        });
        await prisma.demo.update({
          where: { id: booking.demo!.id },
          data: { weekId: week.id, status: "pending", confirmedBy: null, confirmedAt: null },
        });
        await prisma.auditLog.create({
          data: {
            entityType: "booking",
            entityId: booking.id,
            action: "admin_lookup_fix",
            oldValue: JSON.stringify({ status, demoDate: booking.demoDate }),
            newValue: JSON.stringify({ status: "pending", demoDate: effectiveDate, weekId: week.id }),
            performedBy: "admin_lookup",
          },
        });
        fixResults.push(
          `Fixed ${booking.prospectName}: ${status} → pending${targetDate ? `, moved to ${effectiveDate.toISOString()}` : ""}`
        );
      }
    }

    // Re-fetch after fix
    const updated = await prisma.booking.findMany({
      where: { id: { in: bookings.map((b) => b.id) } },
      include: { demo: true, week: true },
      orderBy: { demoDate: "desc" },
    });

    return NextResponse.json({
      fixed: fixResults,
      bookings: updated.map((b) => ({
        id: b.id,
        prospectName: b.prospectName,
        prospectEmail: b.prospectEmail,
        demoDate: b.demoDate,
        calendarEventId: b.calendarEventId,
        source: b.source,
        weekStart: b.week?.weekStart,
        demo: b.demo ? { status: b.demo.status, confirmedBy: b.demo.confirmedBy, confirmedAt: b.demo.confirmedAt } : null,
      })),
    });
  }

  return NextResponse.json({
    found: bookings.length,
    bookings: bookings.map((b) => ({
      id: b.id,
      prospectName: b.prospectName,
      prospectEmail: b.prospectEmail,
      demoDate: b.demoDate,
      calendarEventId: b.calendarEventId,
      source: b.source,
      weekStart: b.week?.weekStart,
      demo: b.demo ? { status: b.demo.status, confirmedBy: b.demo.confirmedBy, confirmedAt: b.demo.confirmedAt } : null,
    })),
  });
}
