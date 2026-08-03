import { NextResponse } from "next/server";
import * as crypto from "crypto";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

// Google Calendar sync via service account
// Reads Calendly-booked events from Colin and Mark's calendars,
// creates/updates bookings + demos, and detects reschedules.

const CALENDARS = [
  { email: "colin@grsfd.co", closerName: "Colin" },
  { email: "mark@grsfd.co", closerName: "Mark" },
];

const SCOPES = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

// --- JWT / Auth helpers ---

function base64url(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildJwt(clientEmail: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const segments = [
    base64url(Buffer.from(JSON.stringify(header))),
    base64url(Buffer.from(JSON.stringify(payload))),
  ];
  const signingInput = segments.join(".");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(privateKey);

  return `${signingInput}.${base64url(signature)}`;
}

async function getAccessToken(clientEmail: string, privateKey: string): Promise<string> {
  const jwt = buildJwt(clientEmail, privateKey);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

// --- Google Calendar types ---

interface GCalAttendee {
  email: string;
  displayName?: string;
  self?: boolean;
  responseStatus?: string;
}

interface GCalEvent {
  id: string;
  summary?: string;
  description?: string;
  status: string; // confirmed | tentative | cancelled
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: GCalAttendee[];
  recurringEventId?: string;
  created?: string;
  updated?: string;
}

// Resolve the actual booking event time from the GCal event metadata.
// Falls back to `updated` then `now` if `created` isn't available.
function getEventBookedAt(event: GCalEvent): Date {
  return new Date(event.created || event.updated || Date.now());
}

// --- Parsing helpers ---

function isCalendlyEvent(event: GCalEvent): boolean {
  const desc = event.description || "";
  const summary = event.summary || "";
  const text = `${desc} ${summary}`;
  return (
    text.includes("Calendly") ||
    text.includes("Grassfed Demo") ||
    text.includes("Booked by")
  );
}

function parseSetterName(description: string): string | null {
  const match = description.match(/Booked by:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

// Pull the Calendly event-type label out of the description (first non-empty line after
// "Event Name"). Returns null if the description doesn't have this marker.
function parseEventTypeName(description: string): string | null {
  const match = description.match(/Event Name\s*\n\s*([^\n]+)/i);
  return match ? match[1].trim() : null;
}

// Mirror of the calendly webhook's event-type filter: only sales-demo event types
// should land in the scoreboard. Onboarding / launch calls / quick calls etc. are out.
function isDemoEventType(eventTypeName: string | null): boolean {
  if (!eventTypeName) return true; // unknown — keep current permissive behavior
  const n = eventTypeName.toLowerCase();
  return (
    n.includes("farm") ||
    n.includes("just") ||
    n.includes("demo") ||
    n.includes("e-mailers") ||
    n.includes("setup")
  );
}

function parsePhone(description: string): string | null {
  const match = description.match(/Phone Number:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

function parseProspectName(summary: string): string {
  // Summaries are typically "Grassfed Demo - John Smith" or "John Smith and Colin Schofield"
  // Strip the closer's full name (first + last) from the summary
  const cleaned = summary
    .replace(/Grassfed Demo\s*[-:]\s*/i, "")
    .replace(/\s+and\s+(Colin|Mark)(\s+\w+)?\s*$/i, "")
    .trim();
  return cleaned || summary || "Unknown";
}

function getProspectEmail(attendees: GCalAttendee[] | undefined, calendarOwner: string): string | null {
  if (!attendees) return null;
  for (const a of attendees) {
    const email = a.email?.toLowerCase();
    if (
      email &&
      !email.endsWith("@grsfd.co") &&
      !email.includes("calendly") &&
      email !== calendarOwner.toLowerCase()
    ) {
      return a.email;
    }
  }
  return null;
}

function getEventStart(event: GCalEvent): Date | null {
  const dt = event.start?.dateTime || event.start?.date;
  return dt ? new Date(dt) : null;
}

// Resolve the setter credited for a rebook event: most-recent setter parsed from the
// description wins; falls back to the previous row's setter. Never clears.
async function resolveRebookSetter(description: string, fallbackSetterId: string | null): Promise<string | null> {
  const incoming = parseSetterName(description);
  if (!incoming) return fallbackSetterId;
  const setter = await prisma.teamMember.findFirst({
    where: { name: { contains: incoming, mode: "insensitive" }, role: "setter" },
  });
  return setter?.id || fallbackSetterId;
}

type OldBookingForSplit = {
  id: string;
  prospectName: string;
  prospectEmail: string | null;
  prospectPhone: string | null;
  setterId: string | null;
  calendarEventId: string | null;
  demo: { id: string; status: string; closerId: string | null } | null;
};

// === IMMUTABLE-HISTORY MODEL ===
// A reschedule/rebook never moves a row to another week. The old row is frozen where
// it sits (supersededAt set; a still-pending demo is closed out as 'rescheduled';
// terminal outcomes showed/no_show/cancelled are untouchable) and a successor row is
// created for the new meeting, linked via rescheduledFromId.
async function supersedeAndCreate(opts: {
  old: OldBookingForSplit;
  newDemoDate: Date;
  newCalendarEventId: string | null;
  bookedAt: Date;
  setterId: string | null;
  transferEventId?: boolean; // same GCal event dragged: successor takes over the event id
}): Promise<string> {
  const { start, end } = getWeekRange(opts.newDemoDate);
  const week = await prisma.week.upsert({
    where: { weekStart: start },
    create: { weekStart: start, weekEnd: end },
    update: {},
  });

  // Freeze old row (suffix its event id first if the successor takes it over)
  await prisma.booking.update({
    where: { id: opts.old.id },
    data: {
      supersededAt: new Date(),
      ...(opts.transferEventId && opts.old.calendarEventId
        ? { calendarEventId: `${opts.old.calendarEventId}_superseded_${opts.old.id}` }
        : {}),
    },
  });
  if (opts.old.demo && opts.old.demo.status === "pending") {
    await prisma.demo.update({
      where: { id: opts.old.demo.id },
      data: { status: "rescheduled", confirmedBy: "reschedule_split", confirmedAt: new Date() },
    });
  }

  const newEventId = opts.transferEventId ? opts.old.calendarEventId : opts.newCalendarEventId;
  const successor = await prisma.booking.create({
    data: {
      weekId: week.id,
      prospectName: opts.old.prospectName,
      prospectEmail: opts.old.prospectEmail,
      prospectPhone: opts.old.prospectPhone,
      setterId: opts.setterId,
      bookedAt: opts.bookedAt,
      demoDate: opts.newDemoDate,
      calendarEventId: newEventId,
      source: "gcal_sync",
      rescheduledFromId: opts.old.id,
    },
  });
  await prisma.demo.create({
    data: {
      bookingId: successor.id,
      weekId: week.id,
      closerId: opts.old.demo?.closerId || null,
    },
  });
  await prisma.auditLog.create({
    data: {
      entityType: "booking",
      entityId: opts.old.id,
      action: "gcal_sync_rescheduled_split",
      oldValue: JSON.stringify({ demoStatus: opts.old.demo?.status, setterId: opts.old.setterId }),
      newValue: JSON.stringify({ successorId: successor.id, demoDate: opts.newDemoDate, setterId: opts.setterId }),
      performedBy: "gcal_sync",
    },
  });
  return successor.id;
}

// --- Main sync logic ---

async function syncCalendar(
  calendarEmail: string,
  closerName: string,
  accessToken: string
): Promise<{ new: number; updated: number; canceled: number; scanned: number; errors: string[] }> {
  const results = { new: 0, updated: 0, canceled: 0, scanned: 0, errors: [] as string[] };

  const now = new Date();
  const timeMin = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
  // +90d window: reschedules to dates beyond 2 weeks out used to fall outside the sync
  // window, leaving the DB with a stale demoDate while GCal had moved on.
  const timeMax = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch events (including cancelled ones via showDeleted)
  const allEvents: GCalEvent[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "250",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarEmail)}/events?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      results.errors.push(`API error for ${calendarEmail}: ${res.status} ${text.slice(0, 200)}`);
      return results;
    }

    const data = await res.json();
    allEvents.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  // Resolve closer from DB
  const closer = await prisma.teamMember.findFirst({
    where: { name: { contains: closerName, mode: "insensitive" }, role: "closer" },
  });
  const closerId = closer?.id || null;

  for (const event of allEvents) {
    try {
      if (!isCalendlyEvent(event)) continue;

      // Skip non-sales-demo event types (onboarding, launch calls, quick calls, etc.).
      // The calendly webhook filters these at line ~114 of webhooks/calendly/route.ts;
      // gcal_sync needs the same filter or non-demo events leak into the scoreboard.
      const eventTypeName = parseEventTypeName(event.description || "");
      if (!isDemoEventType(eventTypeName)) {
        await prisma.auditLog.create({
          data: {
            entityType: "booking",
            entityId: "n/a",
            action: "gcal_sync_non_demo_skipped",
            newValue: JSON.stringify({ eventType: eventTypeName, gcalEventId: event.id, closer: closerName }),
            performedBy: "gcal_sync",
          },
        });
        continue;
      }

      const compositeId = `${event.id}_${closerName}`;
      results.scanned++;

      // Skip dismissed events (manually deleted by user)
      // But if the event has been rescheduled to a future date and an active booking
      // exists for the same prospect email, un-dismiss it and let the sync process it.
      const dismissed = await prisma.dismissedEvent.findUnique({
        where: { calendarEventId: compositeId },
      });
      if (dismissed) {
        const eventStart = getEventStart(event);
        if (eventStart && eventStart.getTime() > Date.now() && event.status !== "cancelled") {
          const prospectEmail = getProspectEmail(event.attendees, calendarEmail);
          if (prospectEmail) {
            const activeBooking = await prisma.booking.findFirst({
              where: {
                prospectEmail: { equals: prospectEmail, mode: "insensitive" },
                supersededAt: null,
                demo: { status: { not: "cancelled" } },
              },
              include: { demo: true },
            });
            if (activeBooking) {
              // Active booking exists — un-dismiss so the event can be processed
              await prisma.dismissedEvent.delete({ where: { id: dismissed.id } });
              // Fall through to normal processing below
            } else {
              continue;
            }
          } else {
            continue;
          }
        } else {
          continue;
        }
      }

      // Handle cancelled events
      if (event.status === "cancelled") {
        const existing = await prisma.booking.findUnique({
          where: { calendarEventId: compositeId },
          include: { demo: true },
        });

        if (existing?.demo && existing.demo.status === "pending") {
          await prisma.demo.update({
            where: { id: existing.demo.id },
            data: {
              status: "cancelled",
              confirmedBy: "gcal_sync",
              confirmedAt: new Date(),
            },
          });
          results.canceled++;
        }
        continue;
      }

      const eventStart = getEventStart(event);
      if (!eventStart) continue;

      const existing = await prisma.booking.findUnique({
        where: { calendarEventId: compositeId },
        include: { demo: true },
      });

      if (existing) {
        // Superseded rows are frozen history — their event id was intentionally left
        // behind (the live successor owns tracking). Never mutate them.
        if (existing.supersededAt) continue;

        // NOTE: do NOT re-attribute setter here. This branch fires on every cron poll for
        // already-known events; re-parsing the description would revert operator backfills.

        // Check for reschedule (time changed by more than 1 minute)
        const existingTime = existing.demoDate.getTime();
        const newTime = eventStart.getTime();

        if (Math.abs(existingTime - newTime) > 60000) {
          const isTerminal = !!existing.demo && ["showed", "no_show", "cancelled"].includes(existing.demo.status);

          if (isTerminal) {
            // The meeting already had an outcome (showed / no_show / cancelled) and the
            // SAME calendar event now points at a new time: someone dragged the invite to
            // schedule a follow-up or re-engage. The outcome is frozen in its week —
            // split off a successor that takes over the event id. Same setter keeps
            // credit (a drag carries no new "Booked by" signal).
            await supersedeAndCreate({
              old: existing,
              newDemoDate: eventStart,
              newCalendarEventId: null,
              bookedAt: getEventBookedAt({ ...event, created: event.updated || event.created }),
              setterId: existing.setterId,
              transferEventId: true,
            });
            results.updated++;
            continue;
          }

          // Still pending — nothing has happened yet, so the row may follow the meeting
          // to its new date/week. DO NOT bump bookedAt: a drag is not a new booking
          // event, and activity credit stays in the week the booking was made.
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
              data: {
                weekId: week.id,
                // stale 'rescheduled' markers on a live row reset to pending
                ...(existing.demo.status !== "pending" ? {
                  status: "pending",
                  confirmedBy: null,
                  confirmedAt: null,
                } : {}),
              },
            });
          }

          await prisma.auditLog.create({
            data: {
              entityType: "booking",
              entityId: existing.id,
              action: "gcal_sync_rescheduled",
              oldValue: JSON.stringify({ demoDate: existing.demoDate }),
              newValue: JSON.stringify({ demoDate: eventStart }),
              performedBy: "gcal_sync",
            },
          });

          results.updated++;
        }
        continue;
      }

      // New event — but first check if it already exists via a different calendarEventId
      // (e.g., Calendly webhook created it with calendly_UUID format)
      const description = event.description || "";
      const summary = event.summary || "";

      const prospectName = parseProspectName(summary);
      const prospectEmail = getProspectEmail(event.attendees, calendarEmail);
      const prospectPhone = parsePhone(description);

      // Dedup: check by email + date window (catches Calendly webhook duplicates).
      // A row in the ±4h window is the SAME meeting arriving via a second channel —
      // just attach the GCal composite id for future tracking. No bookedAt bump, no
      // setter re-parse (operator corrections stay put).
      if (prospectEmail) {
        const windowStart = new Date(eventStart.getTime() - 4 * 60 * 60 * 1000);
        const windowEnd = new Date(eventStart.getTime() + 4 * 60 * 60 * 1000);
        const byEmail = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: prospectEmail, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
            supersededAt: null,
          },
          include: { demo: true },
        });
        if (byEmail) {
          if (byEmail.calendarEventId !== compositeId && !byEmail.calendarEventId?.startsWith(event.id)) {
            await prisma.booking.update({
              where: { id: byEmail.id },
              data: { calendarEventId: compositeId },
            });
          }
          continue;
        }
      }

      // Dedup: check by exact full name + date window — only when the new event has
      // no email AND no phone (otherwise the earlier email/phone path would have caught it).
      if (prospectName && !prospectEmail && !prospectPhone) {
        const windowStart = new Date(eventStart.getTime() - 4 * 60 * 60 * 1000);
        const windowEnd = new Date(eventStart.getTime() + 4 * 60 * 60 * 1000);
        const byName = await prisma.booking.findFirst({
          where: {
            prospectName: { equals: prospectName, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
            supersededAt: null,
          },
        });
        if (byName) {
          if (byName.calendarEventId !== compositeId && !byName.calendarEventId?.startsWith(event.id)) {
            await prisma.booking.update({
              where: { id: byName.id },
              data: { calendarEventId: compositeId },
            });
          }
          continue;
        }
      }

      // A brand-new GCal event for a prospect whose previous demo no-showed or was
      // marked rescheduled = a real rebook event. The old row is frozen where it sits
      // (the no-show stays in its week) and a successor is created for the new meeting.
      // Only email-based matching — the previous first-name fallback collided across
      // unrelated prospects (e.g. "Pat Dreiling" hijacking "Patti Syme").
      if (prospectEmail) {
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
        const pastNoShow = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: prospectEmail, mode: "insensitive" },
            demoDate: { gte: sixtyDaysAgo, lt: eventStart },
            supersededAt: null,
            demo: { status: { in: ["no_show", "rescheduled"] } },
          },
          orderBy: { demoDate: "desc" },
          include: { demo: true },
        });

        if (pastNoShow) {
          await supersedeAndCreate({
            old: pastNoShow,
            newDemoDate: eventStart,
            newCalendarEventId: compositeId,
            // event.created so a historical event discovered late lands on its real
            // booking day, not the day sync first saw it
            bookedAt: getEventBookedAt(event),
            // most-recent setter gets credit for the rebook
            setterId: await resolveRebookSetter(description, pastNoShow.setterId),
          });
          results.updated++;
          continue;
        }
      }

      // Resolve setter
      let setterId: string | null = null;
      const setterName = parseSetterName(description);
      if (setterName) {
        const setter = await prisma.teamMember.findFirst({
          where: { name: { contains: setterName, mode: "insensitive" }, role: "setter" },
        });
        setterId = setter?.id || null;
      }

      // Find or create week
      const { start, end } = getWeekRange(eventStart);
      const week = await prisma.week.upsert({
        where: { weekStart: start },
        create: { weekStart: start, weekEnd: end },
        update: {},
      });

      const booking = await prisma.booking.create({
        data: {
          weekId: week.id,
          prospectName,
          prospectEmail,
          prospectPhone,
          setterId,
          // Use the GCal event's actual creation time so a historical event discovered
          // by sync (e.g. previously hidden by a dedup bug) lands on its real booking
          // day in May, not the day sync first saw it.
          bookedAt: getEventBookedAt(event),
          demoDate: eventStart,
          calendarEventId: compositeId,
          source: "gcal_sync",
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
      results.errors.push(`${closerName}/${event.id}: ${String(e).slice(0, 150)}`);
    }
  }

  return results;
}

// --- Route handlers ---

export async function GET() {
  return POST();
}

export async function POST() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!clientEmail || !privateKeyRaw) {
    return NextResponse.json(
      { error: "GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_KEY not set" },
      { status: 500 }
    );
  }

  // The key may be stored with escaped newlines
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const syncLog = await prisma.syncLog.create({
    data: { source: "gcal", syncType: "calendar_poll", status: "success", startedAt: new Date() },
  });

  const totals = { new: 0, updated: 0, canceled: 0, scanned: 0, errors: [] as string[] };

  try {
    const accessToken = await getAccessToken(clientEmail, privateKey);

    for (const cal of CALENDARS) {
      const result = await syncCalendar(cal.email, cal.closerName, accessToken);
      totals.new += result.new;
      totals.updated += result.updated;
      totals.canceled += result.canceled;
      totals.scanned += result.scanned;
      totals.errors.push(...result.errors);
    }

    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        recordsSynced: totals.new + totals.updated + totals.canceled,
        status: totals.errors.length > 0 ? "error" : "success",
        errorMessage: totals.errors.length > 0 ? totals.errors.join("; ").slice(0, 500) : null,
        completedAt: new Date(),
      },
    });
  } catch (e) {
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "error",
        errorMessage: String(e).slice(0, 500),
        completedAt: new Date(),
      },
    });

    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    message: `GCal sync: ${totals.new} new, ${totals.updated} rescheduled, ${totals.canceled} canceled (${totals.scanned} Calendly events scanned)`,
    totals,
    calendars: CALENDARS.map((c) => c.email),
  });
}
