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
    let inviteeName = payload.name;
    const inviteeUri = payload.uri;
    const eventUri = payload.event;
    const tracking = payload.tracking || {};
    const rescheduled = payload.rescheduled || false;

    // Clean prospect name — Calendly sometimes includes closer name
    // "c c Schofield" or "Nick Mercado and Colin Schofield" → strip it
    if (inviteeName) {
      // Remove "and [Closer Name]" pattern
      inviteeName = inviteeName.replace(/\s+and\s+.*$/i, "").trim();
      // Dynamic: pull closer last names from DB + known spelling variants
      const closers = await prisma.teamMember.findMany({ where: { role: "closer" } });
      const closerLastNames = closers.flatMap(c => c.name.split(/\s+/).slice(1));
      const variants = ["Wittlesey", "Whittelsey", "Schofield"];
      for (const v of variants) {
        if (!closerLastNames.includes(v)) closerLastNames.push(v);
      }
      for (const ln of closerLastNames) {
        if (inviteeName.endsWith(` ${ln}`)) {
          inviteeName = inviteeName.slice(0, -(ln.length + 1)).trim();
        }
      }
    }

    const eventUuid = eventUri?.split("/scheduled_events/")[1]?.split("/")[0] || "";
    const calendlyId = `calendly_${eventUuid}`;

    // Fetch event details from Calendly API
    let demoDate: Date | null = null;
    let closerName: string | null = null;
    let phone: string | null = null;
    let setterFromDescription: string | null = null;
    let eventTypeName: string | null = null;

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
          eventTypeName = resource.name || null;

          const memberships = resource.event_memberships || [];
          if (memberships.length > 0) {
            closerName = memberships[0].user_name?.split(" ")[0] || null;
          }

          // Parse "Booked by" from Calendly event description (if present)
          const eventDescription = resource.description || "";
          const bookedByMatch = eventDescription.match(/Booked\s+[Bb]y:?\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)/i);
          if (bookedByMatch) {
            setterFromDescription = bookedByMatch[1].trim();
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

            // Also check Q&A for "Booked by" as a custom question
            if (!setterFromDescription) {
              const bookedByQ = qna.find((q: { question: string }) =>
                q.question.toLowerCase().includes("booked")
              );
              if (bookedByQ) setterFromDescription = bookedByQ.answer?.trim() || null;
            }

            // Check tracking/UTM for setter name as last resort
            const tracking2 = inviteeData.resource?.tracking || {};
            if (!setterFromDescription) {
              setterFromDescription = tracking2.utm_source || tracking2.utm_campaign || null;
            }
          }
        }
      } catch {
        // API call failed, continue with what we have
      }
    }

    // Filter: only process demo event types (skip launch calls, quick calls, etc.)
    // Known demo types: "Grassfed Demo" (Mark), "Grassfed E-Mailers Setup" (Colin)
    if (eventTypeName && event === "invitee.created") {
      const nameLower = eventTypeName.toLowerCase();
      const isDemoEvent = nameLower.includes("demo") || nameLower.includes("e-mailers") || nameLower.includes("setup");
      if (!isDemoEvent) {
        return NextResponse.json({ received: true, action: "non_demo_skipped", eventType: eventTypeName });
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

      // Find by email + date (within 4 hour window to account for timezone shifts)
      if (inviteeEmail && demoDate) {
        const windowStart = new Date(demoDate.getTime() - 4 * 60 * 60 * 1000);
        const windowEnd = new Date(demoDate.getTime() + 4 * 60 * 60 * 1000);
        const byEmailDate = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: inviteeEmail, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
          },
          include: { demo: true },
        });
        if (byEmailDate) return byEmailDate;
      }

      // Find by email alone (same week) — catches cases where time offset is large
      if (inviteeEmail) {
        const byEmail = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: inviteeEmail, mode: "insensitive" },
          },
          orderBy: { demoDate: "desc" },
          include: { demo: true },
        });
        if (byEmail && demoDate) {
          // Only match if within same week (7 days)
          const diff = Math.abs(new Date(byEmail.demoDate).getTime() - demoDate.getTime());
          if (diff < 7 * 24 * 60 * 60 * 1000) return byEmail;
        }
      }

      // Find by name + date (fallback if no email match)
      if (inviteeName && demoDate) {
        const windowStart = new Date(demoDate.getTime() - 4 * 60 * 60 * 1000);
        const windowEnd = new Date(demoDate.getTime() + 4 * 60 * 60 * 1000);
        // Use first name only for matching to handle "Nick Mercado" vs "Nick Mercado Schofield"
        const firstName = inviteeName.split(/\s+/)[0];
        if (firstName && firstName.length > 2) {
          const byNameDate = await prisma.booking.findFirst({
            where: {
              prospectName: { startsWith: firstName, mode: "insensitive" },
              demoDate: { gte: windowStart, lte: windowEnd },
            },
            include: { demo: true },
          });
          if (byNameDate) return byNameDate;
        }
      }

      return null;
    }

    // === HANDLE invitee.canceled ===
    if (event === "invitee.canceled") {
      const existing = await findExistingBooking();
      if (existing && existing.demo) {
        if (rescheduled) {
          // Don't mark as rescheduled yet — the invitee.created webhook will fire
          // next with the new time and update the booking's demoDate in place.
          // Just log that we received the cancellation.
          await prisma.auditLog.create({
            data: {
              entityType: "demo",
              entityId: existing.demo.id,
              action: "calendly_reschedule_pending",
              oldValue: JSON.stringify({ demoDate: existing.demoDate }),
              performedBy: "calendly_webhook",
            },
          });
        } else {
          // Only cancel demos that are still pending — never overwrite showed/no_show/rescheduled
          await prisma.demo.updateMany({
            where: { bookingId: existing.id, status: "pending" },
            data: { status: "cancelled", confirmedBy: "calendly_webhook", confirmedAt: new Date() },
          });
        }
      }
      return NextResponse.json({ received: true, action: rescheduled ? "reschedule_pending" : "canceled" });
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
        // Already exists — update date, enrich missing fields, handle reschedules
        const bookingUpdates: Record<string, unknown> = {};
        if (inviteeEmail && !existing.prospectEmail) bookingUpdates.prospectEmail = inviteeEmail;
        if (phone && !existing.prospectPhone) bookingUpdates.prospectPhone = phone;

        const isReschedule = demoDate && Math.abs(new Date(existing.demoDate).getTime() - demoDate.getTime()) > 60000;
        if (isReschedule && demoDate) {
          // Demo was rescheduled — move to new date and week
          bookingUpdates.demoDate = demoDate;
          const { start, end } = getWeekRange(demoDate);
          const newWeek = await prisma.week.upsert({
            where: { weekStart: start },
            create: { weekStart: start, weekEnd: end },
            update: {},
          });
          bookingUpdates.weekId = newWeek.id;

          // Update demo's weekId and reset status to pending on any reschedule
          // (no-show, rescheduled, cancelled → pending; showed stays showed)
          if (existing.demo) {
            await prisma.demo.update({
              where: { id: existing.demo.id },
              data: {
                weekId: newWeek.id,
                status: existing.demo.status !== "showed" ? "pending" : existing.demo.status,
                confirmedBy: existing.demo.status !== "showed" ? null : existing.demo.confirmedBy,
                confirmedAt: existing.demo.status !== "showed" ? null : existing.demo.confirmedAt,
              },
            });
          }

          await prisma.auditLog.create({
            data: {
              entityType: "booking",
              entityId: existing.id,
              action: "calendly_rescheduled",
              oldValue: JSON.stringify({ demoDate: existing.demoDate }),
              newValue: JSON.stringify({ demoDate }),
              performedBy: "calendly_webhook",
            },
          });
        }

        if (Object.keys(bookingUpdates).length > 0) {
          await prisma.booking.update({ where: { id: existing.id }, data: bookingUpdates });
        }
        return NextResponse.json({ received: true, action: isReschedule ? "rescheduled_moved" : "duplicate_updated", bookingId: existing.id });
      }

      const effectiveDate = demoDate || new Date();

      const { start, end } = getWeekRange(effectiveDate);
      const week = await prisma.week.upsert({
        where: { weekStart: start },
        create: { weekStart: start, weekEnd: end },
        update: {},
      });

      // Resolve setter — use contains matching to handle whitespace/special chars in Q&A answers
      const setterName = setterFromDescription || tracking.utm_source || tracking.utm_campaign || null;
      let setterId: string | null = null;
      if (setterName) {
        const setter = await prisma.teamMember.findFirst({
          where: { name: { contains: setterName, mode: "insensitive" }, role: "setter" },
        });
        setterId = setter?.id || null;

        // Auto-create non-setter bookers (CEO, guests) as excluded from leaderboard
        if (!setterId) {
          const newMember = await prisma.teamMember.create({
            data: { name: setterName, role: "setter", excludeFromLeaderboard: true },
          });
          setterId = newMember.id;
        }
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

      // Blast attribution — check if prospect was SMS-blasted in last 14 days
      try {
        const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const matchConditions = [];
        if (phone) matchConditions.push({ phone, lastContactedChannel: "ghl", lastContactedAt: { gte: fourteenDaysAgo } });
        if (inviteeEmail) matchConditions.push({ email: inviteeEmail.toLowerCase(), lastContactedChannel: "ghl", lastContactedAt: { gte: fourteenDaysAgo } });

        if (matchConditions.length > 0) {
          const blastMatch = await prisma.agent.findFirst({ where: { OR: matchConditions } });
          if (blastMatch) {
            await prisma.booking.update({ where: { id: booking.id }, data: { blastSourced: true } });
          }
        }
      } catch (err) {
        console.error("Blast attribution check failed:", err);
      }

      // Setter pigeon game — real-time booking notification
      if (setterId) {
        try {
          const { getSetterTodayBookings, checkAndFireTierCrossing, isWeekday, formatSetterMention, getTeamTotalToday } = await import("@/lib/setter-game");
          const { sendSlackSetter } = await import("@/lib/slack");

          if (isWeekday()) {
            const setter = await prisma.teamMember.findUnique({ where: { id: setterId } });
            if (setter) {
              const { count } = await getSetterTodayBookings(setterId);
              const mention = formatSetterMention(setter);

              // Number emoji for the count (1-10, then just the number)
              const numEmojis = ["0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
              const countEmoji = count <= 10 ? numEmojis[count] : `*${count}*`;

              // Check if this booking crossed a tier threshold (fires GIF message)
              const tierCrossed = await checkAndFireTierCrossing(setterId, count);

              // If no tier was crossed, send a simple count update
              if (!tierCrossed) {
                await sendSlackSetter(`${countEmoji}\n${mention} is at ${count} today`);
              }

              // Always send team total (all bookings, including excluded/CEO)
              const { total, setterTotal } = await getTeamTotalToday();
              const setterNote = total > setterTotal ? ` (${setterTotal} by setters)` : "";
              await sendSlackSetter(`*TOTAL booked today so far: ${total}${setterNote}*`);
            }
          }
        } catch { /* setter game not configured */ }
      }

      try {
        const { sendSlackTeam } = await import("@/lib/slack");
        const dateStr = effectiveDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        const setterLabel = setterName ? ` (booked by ${setterName})` : "";
        await sendSlackTeam(`🗓 New demo booked: ${inviteeName} with ${closerName || "TBD"} on ${dateStr}${setterLabel}`);
      } catch { /* Slack not configured */ }

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
