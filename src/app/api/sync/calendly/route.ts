import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

// Polls Calendly API for scheduled events and syncs:
// 1. New events not yet in DB (backup for webhook misses)
// 2. Rescheduled events (time changed via GCal or Calendly)
// 3. Canceled events

const CALENDLY_API = "https://api.calendly.com";

interface CalendlyEvent {
  uri: string;
  name: string;
  status: string; // active | canceled
  start_time: string;
  end_time: string;
  event_memberships: { user: string; user_name: string }[];
  invitees_counter: { total: number; active: number; limit: number };
}

interface CalendlyInvitee {
  uri: string;
  name: string;
  email: string;
  status: string;
  questions_and_answers: { question: string; answer: string }[];
  tracking: { utm_source?: string; utm_campaign?: string };
  rescheduled: boolean;
}

async function calendlyFetch(path: string, token: string) {
  const res = await fetch(`${CALENDLY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// GET handler for Vercel cron
export async function GET() {
  return POST();
}

export async function POST() {
  const token = process.env.CALENDLY_API_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "CALENDLY_API_TOKEN not set" }, { status: 500 });
  }

  const results = { new: 0, updated: 0, canceled: 0, errors: [] as string[] };

  // Get org URI
  const meData = await calendlyFetch("/users/me", token);
  if (!meData?.resource) {
    return NextResponse.json({ error: "Failed to fetch Calendly user" }, { status: 500 });
  }
  const orgUri = meData.resource.current_organization;

  // Fetch events from 4 weeks ago to 2 weeks ahead
  const now = new Date();
  const minTime = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const maxTime = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  let nextPage: string | null = `/scheduled_events?organization=${encodeURIComponent(orgUri)}&min_start_time=${minTime}&max_start_time=${maxTime}&count=100&status=active`;
  const allEvents: CalendlyEvent[] = [];

  // Paginate through all events
  while (nextPage) {
    const data = await calendlyFetch(nextPage, token);
    if (!data) break;
    allEvents.push(...(data.collection || []));
    // Extract next page path from pagination
    const nextPageUrl = data.pagination?.next_page;
    if (nextPageUrl) {
      nextPage = nextPageUrl.replace(CALENDLY_API, "");
    } else {
      nextPage = null;
    }
  }

  // Also fetch canceled events to catch cancellations
  let nextCanceled: string | null = `/scheduled_events?organization=${encodeURIComponent(orgUri)}&min_start_time=${minTime}&max_start_time=${maxTime}&count=100&status=canceled`;
  const canceledEvents: CalendlyEvent[] = [];

  while (nextCanceled) {
    const data = await calendlyFetch(nextCanceled, token);
    if (!data) break;
    canceledEvents.push(...(data.collection || []));
    const nextPageUrl = data.pagination?.next_page;
    if (nextPageUrl) {
      nextCanceled = nextPageUrl.replace(CALENDLY_API, "");
    } else {
      nextCanceled = null;
    }
  }

  // Process active events
  for (const event of allEvents) {
    try {
      const eventUuid = event.uri.split("/scheduled_events/")[1];
      const compositeId = `calendly_${eventUuid}`;
      const eventStart = new Date(event.start_time);

      // Determine closer from event memberships
      let closerName: string | null = null;
      if (event.event_memberships?.length > 0) {
        closerName = event.event_memberships[0].user_name?.split(" ")[0] || null;
      }

      // Check if this event exists in DB
      const existing = await prisma.booking.findUnique({
        where: { calendarEventId: compositeId },
        include: { demo: true },
      });

      if (existing) {
        // Check if time changed (reschedule via GCal)
        const existingTime = new Date(existing.demoDate).getTime();
        const newTime = eventStart.getTime();

        if (Math.abs(existingTime - newTime) > 60000) {
          // Time changed — update the booking
          const { start, end } = getWeekRange(eventStart);
          const week = await prisma.week.upsert({
            where: { weekStart: start },
            create: { weekStart: start, weekEnd: end },
            update: {},
          });

          await prisma.booking.update({
            where: { id: existing.id },
            data: { demoDate: eventStart, weekId: week.id },
          });

          if (existing.demo) {
            await prisma.demo.update({
              where: { id: existing.demo.id },
              data: { weekId: week.id },
            });
          }

          await prisma.auditLog.create({
            data: {
              entityType: "booking",
              entityId: existing.id,
              action: "calendly_sync_rescheduled",
              oldValue: JSON.stringify({ demoDate: existing.demoDate }),
              newValue: JSON.stringify({ demoDate: eventStart }),
              performedBy: "calendly_sync",
            },
          });

          results.updated++;
        }
        continue;
      }

      // New event — fetch invitee details
      const inviteesData = await calendlyFetch(
        `/scheduled_events/${eventUuid}/invitees?count=1`,
        token
      );
      const invitee: CalendlyInvitee | null = inviteesData?.collection?.[0] || null;

      if (!invitee) continue;

      // Resolve setter from tracking UTM or Calendly description
      let setterId: string | null = null;
      const setterName = invitee.tracking?.utm_source || invitee.tracking?.utm_campaign || null;
      if (setterName) {
        const setter = await prisma.teamMember.findFirst({
          where: { name: { equals: setterName, mode: "insensitive" }, role: "setter" },
        });
        setterId = setter?.id || null;
      }

      // Resolve closer
      let closerId: string | null = null;
      if (closerName) {
        const closer = await prisma.teamMember.findFirst({
          where: { name: { contains: closerName, mode: "insensitive" }, role: "closer" },
        });
        closerId = closer?.id || null;
      }

      // Get phone from Q&A
      let phone: string | null = null;
      const phoneQ = invitee.questions_and_answers?.find(
        (q) => q.question.toLowerCase().includes("phone")
      );
      if (phoneQ) phone = phoneQ.answer;

      // Find or create week
      const { start, end } = getWeekRange(eventStart);
      const week = await prisma.week.upsert({
        where: { weekStart: start },
        create: { weekStart: start, weekEnd: end },
        update: {},
      });

      // Create booking + demo
      const booking = await prisma.booking.create({
        data: {
          weekId: week.id,
          prospectName: invitee.name || event.name || "Unknown",
          prospectEmail: invitee.email || null,
          prospectPhone: phone,
          setterId,
          demoDate: eventStart,
          calendarEventId: compositeId,
          source: "calendly_sync",
        },
      });

      await prisma.demo.create({
        data: {
          bookingId: booking.id,
          weekId: week.id,
          closerId,
        },
      });

      results.new++;
    } catch (e) {
      results.errors.push(String(e).slice(0, 100));
    }
  }

  // Process canceled events
  for (const event of canceledEvents) {
    try {
      const eventUuid = event.uri.split("/scheduled_events/")[1];
      const compositeId = `calendly_${eventUuid}`;

      const existing = await prisma.booking.findUnique({
        where: { calendarEventId: compositeId },
        include: { demo: true },
      });

      if (existing && existing.demo && existing.demo.status === "pending") {
        await prisma.demo.update({
          where: { id: existing.demo.id },
          data: {
            status: "cancelled",
            confirmedBy: "calendly_sync",
            confirmedAt: new Date(),
          },
        });
        results.canceled++;
      }
    } catch (e) {
      results.errors.push(String(e).slice(0, 100));
    }
  }

  return NextResponse.json({
    success: true,
    message: `Calendly sync: ${results.new} new, ${results.updated} rescheduled, ${results.canceled} canceled`,
    results,
    eventsChecked: allEvents.length + canceledEvents.length,
  });
}
