import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Debug endpoint to investigate booking/demo issues
// Usage: GET /api/debug?name=andrea  or  ?email=andrea@...  or  ?all_dismissed=true
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
