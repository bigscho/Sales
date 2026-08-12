import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";
import { matchCloserByName, LEAD_SOURCE_FED, LEAD_SOURCE_SELF } from "@/lib/lead-source";

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
      const variants = ["Wittlesey", "Whittelsey", "Schofield", "Farrell"];
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
    let listingAddress: string | null = null; // "Listing address / zip codes" custom Q&A
    let prospectTimezone: string | null = null; // IANA tz from invitee

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

            // "Listing address / zip codes" — drives the show-rate T-1 confirmation text
            const listingQ = qna.find((q: { question: string }) => {
              const ql = q.question.toLowerCase();
              return ql.includes("listing") || ql.includes("address") || ql.includes("zip");
            });
            if (listingQ?.answer?.trim()) listingAddress = listingQ.answer.trim();

            // Invitee timezone — used for prospect-local send timing
            prospectTimezone = inviteeData.resource?.timezone || null;

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

    // Filter: only process demo event types (skip onboarding, launch calls, quick calls, etc.)
    // Current demo event type names contain "farm", "just-listed", "just-closed", "just listed", "just closed", "demo", or "e-mailers"
    if (eventTypeName && event === "invitee.created") {
      const nameLower = eventTypeName.toLowerCase();
      const isDemoEvent =
        nameLower.includes("farm") ||
        nameLower.includes("just") ||
        nameLower.includes("demo") ||
        nameLower.includes("e-mailers") ||
        nameLower.includes("setup");
      if (!isDemoEvent) {
        await prisma.auditLog.create({
          data: {
            entityType: "booking",
            entityId: "n/a",
            action: "calendly_non_demo_skipped",
            newValue: JSON.stringify({ eventType: eventTypeName, inviteeName, inviteeEmail }),
            performedBy: "calendly_webhook",
          },
        });
        return NextResponse.json({ received: true, action: "non_demo_skipped", eventType: eventTypeName });
      }
    }

    // Helper: find existing LIVE booking by calendly ID OR by email+date match.
    // Superseded rows (closed out by a later reschedule) are frozen history and
    // must never be matched/mutated — always resolve to the live successor instead.
    async function findExistingBooking() {
      // First try calendly ID
      const byCalendlyId = await prisma.booking.findUnique({
        where: { calendarEventId: calendlyId },
        include: { demo: true },
      });
      if (byCalendlyId && !byCalendlyId.supersededAt) return byCalendlyId;

      // Find by email + date (within 4 hour window to account for timezone shifts)
      if (inviteeEmail && demoDate) {
        const windowStart = new Date(demoDate.getTime() - 4 * 60 * 60 * 1000);
        const windowEnd = new Date(demoDate.getTime() + 4 * 60 * 60 * 1000);
        const byEmailDate = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: inviteeEmail, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
            supersededAt: null,
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
            supersededAt: null,
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
              supersededAt: null,
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
      // If this cancel is for an event whose row was already superseded by a
      // reschedule, it's history — do NOT let the email fallback matchers cancel
      // the live successor's pending demo.
      const exactRow = await prisma.booking.findUnique({ where: { calendarEventId: calendlyId } });
      if (exactRow?.supersededAt) {
        return NextResponse.json({ received: true, action: "canceled_superseded_ignored" });
      }
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
        // === IMMUTABLE-HISTORY MODEL ===
        // A row never leaves its week. Two cases:
        //  1) Same meeting arriving again (duplicate delivery / cross-channel echo):
        //     enrich missing contact fields only. NO bookedAt bump — bumping here used
        //     to silently migrate activity credit out of the original week.
        //  2) Real reschedule/rebook (time changed): freeze the old row where it sits
        //     (its week keeps the booking + outcome forever) and create a successor
        //     row in the new week, credited to the most-recent setter.
        const enrich: Record<string, unknown> = {};
        if (inviteeEmail && !existing.prospectEmail) enrich.prospectEmail = inviteeEmail;
        if (phone && !existing.prospectPhone) enrich.prospectPhone = phone;
        if (listingAddress && !existing.listingAddress) enrich.listingAddress = listingAddress;
        if (prospectTimezone && !existing.prospectTimezone) enrich.prospectTimezone = prospectTimezone;

        const isReschedule = !!demoDate && Math.abs(new Date(existing.demoDate).getTime() - demoDate.getTime()) > 60000;

        if (!isReschedule) {
          // Fill setter only if the row has none (never overwrite operator corrections
          // on a mere duplicate delivery).
          const dupSetterName = setterFromDescription || tracking.utm_source || tracking.utm_campaign || null;
          if (!existing.setterId && dupSetterName) {
            const setterMatch = await prisma.teamMember.findFirst({
              where: { name: { contains: dupSetterName, mode: "insensitive" }, role: "setter" },
            });
            if (setterMatch) enrich.setterId = setterMatch.id;
          }
          if (Object.keys(enrich).length > 0) {
            await prisma.booking.update({ where: { id: existing.id }, data: enrich });
          }
          return NextResponse.json({ received: true, action: "duplicate_enriched", bookingId: existing.id });
        }

        // Replay guard: if this exact Calendly event already produced a row (live or
        // superseded), this webhook is a redelivery — never spawn another successor.
        const replay = await prisma.booking.findUnique({ where: { calendarEventId: calendlyId } });
        if (replay) {
          return NextResponse.json({ received: true, action: "replay_ignored", bookingId: replay.id });
        }

        // Most-recent setter gets credit for the rebook (falls back to previous setter)
        const incomingSetterName = setterFromDescription || tracking.utm_source || tracking.utm_campaign || null;
        let successorSetterId: string | null = existing.setterId;
        if (incomingSetterName) {
          // A closer's name in "Booked by": on their own booking they're not a
          // setter (keep previous setter); rebooking onto ANOTHER closer's
          // calendar counts as setter work. Never create a junk setter row.
          const closerBookedBy = await matchCloserByName(incomingSetterName);
          if (closerBookedBy) {
            if (existing.demo?.closerId && closerBookedBy.id !== existing.demo.closerId) {
              successorSetterId = closerBookedBy.id;
            }
          } else {
            const setterMatch = await prisma.teamMember.findFirst({
              where: { name: { contains: incomingSetterName, mode: "insensitive" }, role: "setter" },
            });
            if (setterMatch) {
              successorSetterId = setterMatch.id;
            } else {
              const newMember = await prisma.teamMember.create({
                data: { name: incomingSetterName, role: "setter", excludeFromLeaderboard: true },
              });
              successorSetterId = newMember.id;
            }
          }
        }

        const { start, end } = getWeekRange(demoDate!);
        const newWeek = await prisma.week.upsert({
          where: { weekStart: start },
          create: { weekStart: start, weekEnd: end },
          update: {},
        });

        // Freeze the old row. Terminal outcomes (showed / no_show / cancelled) are
        // untouchable; a still-pending demo is closed out as 'rescheduled' (excluded
        // from show rate — the meeting moved before it could happen).
        await prisma.booking.update({
          where: { id: existing.id },
          data: { supersededAt: new Date(), ...enrich },
        });
        if (existing.demo && existing.demo.status === "pending") {
          await prisma.demo.update({
            where: { id: existing.demo.id },
            data: { status: "rescheduled", confirmedBy: "reschedule_split", confirmedAt: new Date() },
          });
        }

        const successor = await prisma.booking.create({
          data: {
            weekId: newWeek.id,
            prospectName: existing.prospectName,
            prospectEmail: inviteeEmail || existing.prospectEmail,
            prospectPhone: phone || existing.prospectPhone,
            listingAddress: listingAddress || existing.listingAddress,
            prospectTimezone: prospectTimezone || existing.prospectTimezone,
            setterId: successorSetterId,
            bookedAt: new Date(),
            demoDate: demoDate!,
            calendarEventId: calendlyId,
            source: "calendly_webhook",
            // Lead source is fixed at the ORIGINAL booking (§4.6) — a reschedule
            // never changes fed vs self-sourced, no matter who handled it.
            leadSource: existing.leadSource,
            rescheduledFromId: existing.id,
          },
        });
        await prisma.demo.create({
          data: {
            bookingId: successor.id,
            weekId: newWeek.id,
            closerId: existing.demo?.closerId || null,
          },
        });

        await prisma.auditLog.create({
          data: {
            entityType: "booking",
            entityId: existing.id,
            action: "calendly_rescheduled_split",
            oldValue: JSON.stringify({ demoDate: existing.demoDate, demoStatus: existing.demo?.status, setterId: existing.setterId }),
            newValue: JSON.stringify({ successorId: successor.id, demoDate, setterId: successorSetterId }),
            performedBy: "calendly_webhook",
          },
        });

        try {
          const { sendSlackTeam } = await import("@/lib/slack");
          const dateStr = demoDate!.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
          await sendSlackTeam(`🔁 Rescheduled: ${existing.prospectName} moved to ${dateStr}${incomingSetterName ? ` (reset by ${incomingSetterName})` : ""}`);
        } catch (err) { console.error("reschedule Slack post failed:", err); }

        return NextResponse.json({ received: true, action: "rescheduled_split", bookingId: successor.id });
      }

      const effectiveDate = demoDate || new Date();

      const { start, end } = getWeekRange(effectiveDate);
      const week = await prisma.week.upsert({
        where: { weekStart: start },
        create: { weekStart: start, weekEnd: end },
        update: {},
      });

      // Resolve closer (Calendly event host) — needed before setter resolution so
      // a "Booked by: <closer>" on their own calendar can be tagged self-sourced
      let closerId: string | null = null;
      if (closerName) {
        const closer = await prisma.teamMember.findFirst({
          where: { name: { contains: closerName, mode: "insensitive" }, role: "closer" },
        });
        closerId = closer?.id || null;
      }

      // Resolve setter — use contains matching to handle whitespace/special chars in Q&A answers
      const setterName = setterFromDescription || tracking.utm_source || tracking.utm_campaign || null;
      let setterId: string | null = null;
      let leadSource = LEAD_SOURCE_FED;
      if (setterName) {
        // "Booked by" naming a closer = the closer booked it themselves. On their
        // own calendar that's a self-sourced deal (contract §4.6). On ANOTHER
        // closer's calendar they were acting as a setter — credit them as such
        // (closers double as setters). Either way, no junk setter row.
        const closerBookedBy = await matchCloserByName(setterName);
        if (closerBookedBy) {
          if (closerId && closerBookedBy.id === closerId) {
            leadSource = LEAD_SOURCE_SELF;
          } else if (closerId) {
            setterId = closerBookedBy.id;
          }
        } else {
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
      }

      const booking = await prisma.booking.create({
        data: {
          weekId: week.id,
          prospectName: inviteeName || "Unknown",
          prospectEmail: inviteeEmail || null,
          prospectPhone: phone,
          listingAddress,
          prospectTimezone,
          setterId,
          bookedAt: new Date(),
          demoDate: effectiveDate,
          calendarEventId: calendlyId,
          source: "calendly_webhook",
          leadSource,
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
          newValue: JSON.stringify({ name: inviteeName, email: inviteeEmail, date: effectiveDate, leadSource }),
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
        } catch (err) { console.error("setter game / setter Slack post failed:", err); }
      }

      try {
        const { sendSlackTeam } = await import("@/lib/slack");
        const dateStr = effectiveDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        const setterLabel = setterName ? ` (booked by ${setterName})` : "";
        await sendSlackTeam(`🗓 New demo booked: ${inviteeName} with ${closerName || "TBD"} on ${dateStr}${setterLabel}`);
      } catch (err) { console.error("team Slack post failed:", err); }

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
