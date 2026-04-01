import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

// Debug endpoint to investigate booking/demo issues
// GET: ?name=andrea  or  ?email=andrea@...  or  ?all_dismissed=true
// POST: { action: "fix_stale_noshows" } — reset future-dated no-shows to pending
export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");
  const email = request.nextUrl.searchParams.get("email");
  const allDismissed = request.nextUrl.searchParams.get("all_dismissed");
  const allNoShows = request.nextUrl.searchParams.get("all_no_shows");
  const calendarEventId = request.nextUrl.searchParams.get("calendar_event_id");

  const results: Record<string, unknown> = {};

  // Search bookings by name
  if (name) {
    const bookings = await prisma.booking.findMany({
      where: { prospectName: { contains: name, mode: "insensitive" } },
      include: { demo: true, week: true, setter: true },
      orderBy: { demoDate: "desc" },
    });
    results.bookings_by_name = bookings.map((b) => ({
      id: b.id,
      prospectName: b.prospectName,
      prospectEmail: b.prospectEmail,
      demoDate: b.demoDate,
      calendarEventId: b.calendarEventId,
      source: b.source,
      weekId: b.weekId,
      weekStart: b.week.weekStart,
      weekEnd: b.week.weekEnd,
      setter: b.setter?.name || null,
      demo: b.demo
        ? {
            id: b.demo.id,
            status: b.demo.status,
            closerId: b.demo.closerId,
            confirmedBy: b.demo.confirmedBy,
            confirmedAt: b.demo.confirmedAt,
            weekId: b.demo.weekId,
          }
        : null,
    }));

    // Check if any of their calendarEventIds are in dismissed events
    const eventIds = bookings
      .map((b) => b.calendarEventId)
      .filter(Boolean) as string[];
    if (eventIds.length > 0) {
      const dismissed = await prisma.dismissedEvent.findMany({
        where: { calendarEventId: { in: eventIds } },
      });
      results.dismissed_matches = dismissed;
    }
  }

  // Search bookings by email
  if (email) {
    const bookings = await prisma.booking.findMany({
      where: { prospectEmail: { contains: email, mode: "insensitive" } },
      include: { demo: true, week: true },
      orderBy: { demoDate: "desc" },
    });
    results.bookings_by_email = bookings.map((b) => ({
      id: b.id,
      prospectName: b.prospectName,
      prospectEmail: b.prospectEmail,
      demoDate: b.demoDate,
      calendarEventId: b.calendarEventId,
      source: b.source,
      weekId: b.weekId,
      weekStart: b.week.weekStart,
      demo: b.demo
        ? { id: b.demo.id, status: b.demo.status, weekId: b.demo.weekId }
        : null,
    }));
  }

  // Show all dismissed events
  if (allDismissed) {
    const dismissed = await prisma.dismissedEvent.findMany({
      orderBy: { dismissedAt: "desc" },
      take: 50,
    });
    results.dismissed_events = dismissed;
  }

  // Show all no-show demos
  if (allNoShows) {
    const noShows = await prisma.demo.findMany({
      where: { status: { in: ["no_show", "rescheduled"] } },
      include: { booking: true, week: true },
      orderBy: { booking: { demoDate: "desc" } },
      take: 50,
    });
    results.no_show_demos = noShows.map((d) => ({
      demoId: d.id,
      status: d.status,
      prospectName: d.booking.prospectName,
      prospectEmail: d.booking.prospectEmail,
      demoDate: d.booking.demoDate,
      calendarEventId: d.booking.calendarEventId,
      weekId: d.weekId,
      weekStart: d.week.weekStart,
    }));
  }

  // Look up specific calendarEventId
  if (calendarEventId) {
    const booking = await prisma.booking.findUnique({
      where: { calendarEventId },
      include: { demo: true, week: true },
    });
    results.booking_by_event_id = booking;

    const dismissed = await prisma.dismissedEvent.findUnique({
      where: { calendarEventId },
    });
    results.dismissed_by_event_id = dismissed;
  }

  // Always include summary stats
  const stats = {
    total_bookings: await prisma.booking.count(),
    total_demos: await prisma.demo.count(),
    total_dismissed: await prisma.dismissedEvent.count(),
    demos_by_status: await prisma.demo.groupBy({
      by: ["status"],
      _count: true,
    }),
  };
  results.stats = stats;

  return NextResponse.json(results, { status: 200 });
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.action === "fix_stale_noshows") {
    // Find all demos with no_show/rescheduled status but a future demoDate
    // These are bookings that were dragged to a new date but status was never reset
    const now = new Date();
    const stale = await prisma.demo.findMany({
      where: {
        status: { in: ["no_show", "rescheduled"] },
        booking: { demoDate: { gt: now } },
      },
      include: { booking: { include: { week: true } } },
    });

    const fixed = [];
    for (const demo of stale) {
      const eventStart = demo.booking.demoDate;
      const { start, end } = getWeekRange(eventStart);

      // Make sure weekId is correct for the new date
      const week = await prisma.week.upsert({
        where: { weekStart: start },
        create: { weekStart: start, weekEnd: end },
        update: {},
      });

      await prisma.booking.update({
        where: { id: demo.bookingId },
        data: { weekId: week.id },
      });

      await prisma.demo.update({
        where: { id: demo.id },
        data: { weekId: week.id, status: "pending", confirmedBy: null, confirmedAt: null },
      });

      fixed.push({
        prospectName: demo.booking.prospectName,
        oldStatus: demo.status,
        demoDate: demo.booking.demoDate,
        weekId: week.id,
      });
    }

    return NextResponse.json({ fixed, count: fixed.length });
  }

  if (body.action === "fix_dismissed_reschedule") {
    // Fix bookings whose GCal event was dismissed but the booking still exists
    // under a different calendarEventId (e.g. Calendly format).
    // Params: email (required), newDate (ISO string), compositeId (the dismissed GCal ID)
    const { email, newDate, compositeId } = body;
    if (!email) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }

    const booking = await prisma.booking.findFirst({
      where: { prospectEmail: { equals: email, mode: "insensitive" } },
      include: { demo: true },
      orderBy: { demoDate: "desc" },
    });
    if (!booking) {
      return NextResponse.json({ error: "No booking found for that email" }, { status: 404 });
    }

    const eventStart = newDate ? new Date(newDate) : booking.demoDate;
    const { start, end } = getWeekRange(eventStart);
    const week = await prisma.week.upsert({
      where: { weekStart: start },
      create: { weekStart: start, weekEnd: end },
      update: {},
    });

    // Remove the dismissed event so GCal sync can process it
    if (compositeId) {
      await prisma.dismissedEvent.deleteMany({
        where: { calendarEventId: compositeId },
      });
    }

    // Update booking date, week, and link composite ID
    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        demoDate: eventStart,
        weekId: week.id,
        ...(compositeId ? { calendarEventId: compositeId } : {}),
      },
    });

    // Reset demo status and move to correct week
    if (booking.demo) {
      await prisma.demo.update({
        where: { id: booking.demo.id },
        data: { weekId: week.id, status: "pending", confirmedBy: null, confirmedAt: null },
      });
    }

    return NextResponse.json({
      fixed: true,
      prospectName: booking.prospectName,
      oldDate: booking.demoDate,
      newDate: eventStart,
      weekId: week.id,
      dismissedRemoved: compositeId || null,
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
