import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

// Calendly sends: invitee.created, invitee.canceled
// Payload has invitee name, email, event URI, tracking (UTM), cancel/reschedule URLs
// We need to GET the event URI to get the scheduled time + event type details

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const event = body.event; // "invitee.created" or "invitee.canceled"
    const payload = body.payload;

    if (!payload) {
      return NextResponse.json({ error: "No payload" }, { status: 400 });
    }

    const inviteeEmail = payload.email;
    const inviteeName = payload.name;
    const inviteeUri = payload.uri; // unique invitee URI
    const eventUri = payload.event; // scheduled_event URI
    const tracking = payload.tracking || {};
    const rescheduled = payload.rescheduled || false;

    // Extract event UUID from URI for use as calendarEventId
    // URI format: https://api.calendly.com/scheduled_events/XXXXX/invitees/YYYYY
    const eventUuid = eventUri?.split("/scheduled_events/")[1]?.split("/")[0] || "";
    const compositeId = `calendly_${eventUuid}`;

    // Try to get event details from Calendly API for the scheduled time
    let demoDate: Date | null = null;
    let closerName: string | null = null;
    let phone: string | null = null;

    const calendlyToken = process.env.CALENDLY_API_TOKEN;
    if (calendlyToken && eventUri) {
      try {
        // Fetch the scheduled event for start time + event memberships (closer)
        const eventRes = await fetch(eventUri, {
          headers: { Authorization: `Bearer ${calendlyToken}` },
        });
        if (eventRes.ok) {
          const eventData = await eventRes.json();
          const resource = eventData.resource;
          demoDate = resource.start_time ? new Date(resource.start_time) : null;

          // Event memberships contain the calendar owner (closer)
          const memberships = resource.event_memberships || [];
          if (memberships.length > 0) {
            closerName = memberships[0].user_name?.split(" ")[0] || null;
          }
        }

        // Fetch invitee details for phone number (from questions_and_answers)
        if (inviteeUri) {
          const inviteeRes = await fetch(inviteeUri, {
            headers: { Authorization: `Bearer ${calendlyToken}` },
          });
          if (inviteeRes.ok) {
            const inviteeData = await inviteeRes.json();
            const qna = inviteeData.resource?.questions_and_answers || [];
            const phoneAnswer = qna.find((q: { question: string }) =>
              q.question.toLowerCase().includes("phone")
            );
            if (phoneAnswer) {
              phone = phoneAnswer.answer;
            }
          }
        }
      } catch {
        // API call failed, continue with what we have
      }
    }

    // === HANDLE invitee.canceled ===
    if (event === "invitee.canceled") {
      const existing = await prisma.booking.findUnique({
        where: { calendarEventId: compositeId },
      });
      if (existing) {
        if (rescheduled) {
          // Rescheduled — mark as rescheduled, the new invitee.created will create the new one
          await prisma.demo.updateMany({
            where: { bookingId: existing.id },
            data: { status: "rescheduled", confirmedBy: "calendly_webhook", confirmedAt: new Date() },
          });
        } else {
          // Pure cancellation
          await prisma.demo.updateMany({
            where: { bookingId: existing.id },
            data: { status: "cancelled", confirmedBy: "calendly_webhook", confirmedAt: new Date() },
          });
        }
      }
      return NextResponse.json({ received: true, action: rescheduled ? "rescheduled" : "canceled" });
    }

    // === HANDLE invitee.created ===
    if (event === "invitee.created") {
      // Check if already exists
      const existing = await prisma.booking.findUnique({
        where: { calendarEventId: compositeId },
      });
      if (existing) {
        return NextResponse.json({ received: true, action: "duplicate_skipped" });
      }

      // Use demoDate from API, or fallback to now (will be updated on next sync)
      const effectiveDate = demoDate || new Date();

      // Find or create the week
      const { start, end } = getWeekRange(effectiveDate);
      const week = await prisma.week.upsert({
        where: { weekStart: start },
        create: { weekStart: start, weekEnd: end },
        update: {},
      });

      // Resolve setter from UTM tracking or "Booked by" convention
      // Calendly UTM: utm_source can carry setter name
      // Or check tracking.utm_campaign, utm_content, etc.
      const setterName = tracking.utm_source || tracking.utm_campaign || null;
      let setterId: string | null = null;
      if (setterName) {
        const setter = await prisma.teamMember.findFirst({
          where: { name: { equals: setterName, mode: "insensitive" }, role: "setter" },
        });
        setterId = setter?.id || null;
      }

      // Resolve closer from event membership or calendar owner
      let closerId: string | null = null;
      if (closerName) {
        const closer = await prisma.teamMember.findFirst({
          where: { name: { contains: closerName, mode: "insensitive" }, role: "closer" },
        });
        closerId = closer?.id || null;
      }

      // Create booking
      const booking = await prisma.booking.create({
        data: {
          weekId: week.id,
          prospectName: inviteeName || "Unknown",
          prospectEmail: inviteeEmail || null,
          prospectPhone: phone,
          setterId,
          demoDate: effectiveDate,
          calendarEventId: compositeId,
          source: "calendly_webhook",
        },
      });

      // Create demo
      await prisma.demo.create({
        data: {
          bookingId: booking.id,
          weekId: week.id,
          closerId,
        },
      });

      // Audit log
      await prisma.auditLog.create({
        data: {
          entityType: "booking",
          entityId: booking.id,
          action: "calendly_webhook_created",
          newValue: JSON.stringify({ name: inviteeName, email: inviteeEmail, date: effectiveDate }),
          performedBy: "calendly_webhook",
        },
      });

      return NextResponse.json({
        received: true,
        action: "created",
        booking: { id: booking.id, prospect: inviteeName, date: effectiveDate },
      });
    }

    return NextResponse.json({ received: true, action: "unhandled_event" });
  } catch (error) {
    console.error("Calendly webhook error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET handler for health check
export async function GET() {
  return NextResponse.json({ status: "ok", webhook: "calendly" });
}
