import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

// Calendly sends: invitee.created, invitee.canceled
// GCal sync may have already created the booking with a different calendarEventId format.
// We check both by calendly ID and by email+date to avoid duplicates.

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
    const inviteeUri = payload.uri;
    const eventUri = payload.event;
    const tracking = payload.tracking || {};
    const rescheduled = payload.rescheduled || false;

    const eventUuid = eventUri?.split("/scheduled_events/")[1]?.split("/")[0] || "";
    const calendlyId = `calendly_${eventUuid}`;

    // Fetch event details from Calendly API
    let demoDate: Date | null = null;
    let closerName: string | null = null;
    let phone: string | null = null;
    let setterFromDescription: string | null = null;

    const calendlyToken = process.env.CALENDLY_API_TOKEN;
    if (calendlyToken && eventUri) {
      try {
        const eventRes = await fetch(eventUri, {
          headers: { Authorization: `Bearer ${calendlyToken}` },
        });
        if (eventRes.ok) {
          const eventData = await eventRes.json();
          const resource = eventData.resource;
          demoDate = resource.start_time ? new Date(resource.start_time) : null;

          const memberships = resource.event_memberships || [];
          if (memberships.length > 0) {
            closerName = memberships[0].user_name?.split(" ")[0] || null;
          }
        }

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
            if (phoneAnswer) phone = phoneAnswer.answer;

            // Check for "Booked by" in text fields
            const bookedByQ = qna.find((q: { question: string }) =>
              q.question.toLowerCase().includes("booked by")
            );
            if (bookedByQ) setterFromDescription = bookedByQ.answer;
          }
        }
      } catch {
        // API call failed, continue with what we have
      }
    }

    // Helper: find existing booking by calendly ID OR by email+date match
    async function findExistingBooking() {
      // First try calendly ID
      const byCalendlyId = await prisma.booking.findUnique({
        where: { calendarEventId: calendlyId },
        include: { demo: true },
      });
      if (byCalendlyId) return byCalendlyId;

      // Try GCal-format ID (eventId_CloserName)
      if (closerName) {
        // Google Calendar event IDs won't match Calendly UUIDs, but if GCal sync
        // already created this booking, we can find it by email + date window
      }

      // Find by email + date (within 2 hour window to account for timezone shifts)
      if (inviteeEmail && demoDate) {
        const windowStart = new Date(demoDate.getTime() - 2 * 60 * 60 * 1000);
        const windowEnd = new Date(demoDate.getTime() + 2 * 60 * 60 * 1000);
        const byEmailDate = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: inviteeEmail, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
          },
          include: { demo: true },
        });
        if (byEmailDate) return byEmailDate;
      }

      // Find by name + date (fallback if no email match)
      if (inviteeName && demoDate) {
        const windowStart = new Date(demoDate.getTime() - 2 * 60 * 60 * 1000);
        const windowEnd = new Date(demoDate.getTime() + 2 * 60 * 60 * 1000);
        const byNameDate = await prisma.booking.findFirst({
          where: {
            prospectName: { equals: inviteeName, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
          },
          include: { demo: true },
        });
        if (byNameDate) return byNameDate;
      }

      return null;
    }

    // === HANDLE invitee.canceled ===
    if (event === "invitee.canceled") {
      const existing = await findExistingBooking();
      if (existing && existing.demo) {
        if (rescheduled) {
          await prisma.demo.updateMany({
            where: { bookingId: existing.id },
            data: { status: "rescheduled", confirmedBy: "calendly_webhook", confirmedAt: new Date() },
          });
        } else {
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
      // Skip if this event was manually dismissed/deleted
      const dismissed = await prisma.dismissedEvent.findUnique({
        where: { calendarEventId: calendlyId },
      });
      if (dismissed) {
        return NextResponse.json({ received: true, action: "dismissed_skipped" });
      }

      const existing = await findExistingBooking();
      if (existing) {
        // Already exists (created by GCal sync or previous webhook) — update if needed
        const updates: Record<string, unknown> = {};
        if (inviteeEmail && !existing.prospectEmail) updates.prospectEmail = inviteeEmail;
        if (phone && !existing.prospectPhone) updates.prospectPhone = phone;
        if (demoDate && Math.abs(new Date(existing.demoDate).getTime() - demoDate.getTime()) > 60000) {
          updates.demoDate = demoDate;
        }
        if (Object.keys(updates).length > 0) {
          await prisma.booking.update({ where: { id: existing.id }, data: updates });
        }
        return NextResponse.json({ received: true, action: "duplicate_updated", bookingId: existing.id });
      }

      const effectiveDate = demoDate || new Date();

      const { start, end } = getWeekRange(effectiveDate);
      const week = await prisma.week.upsert({
        where: { weekStart: start },
        create: { weekStart: start, weekEnd: end },
        update: {},
      });

      // Resolve setter
      const setterName = setterFromDescription || tracking.utm_source || tracking.utm_campaign || null;
      let setterId: string | null = null;
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

      const booking = await prisma.booking.create({
        data: {
          weekId: week.id,
          prospectName: inviteeName || "Unknown",
          prospectEmail: inviteeEmail || null,
          prospectPhone: phone,
          setterId,
          demoDate: effectiveDate,
          calendarEventId: calendlyId,
          source: "calendly_webhook",
        },
      });

      await prisma.demo.create({
        data: {
          bookingId: booking.id,
          weekId: week.id,
          closerId,
        },
      });

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

export async function GET() {
  return NextResponse.json({ status: "ok", webhook: "calendly" });
}
