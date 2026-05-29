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

// Mirrors the calendly webhook's rebook re-attribution: when a prospect rebooks
// via a different setter's link, the most-recent setter gets credit. Only overwrites
// when a new setter name is actually parsed from the description — never clears.
async function reattributeSetter(
  bookingId: string,
  currentSetterId: string | null,
  description: string,
): Promise<void> {
  const incoming = parseSetterName(description);
  if (!incoming) return;
  const setter = await prisma.teamMember.findFirst({
    where: { name: { contains: incoming, mode: "insensitive" }, role: "setter" },
  });
  const newSetterId = setter?.id || null;
  if (!newSetterId || newSetterId === currentSetterId) return;
  await prisma.booking.update({
    where: { id: bookingId },
    data: { setterId: newSetterId, bookedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      entityType: "booking",
      entityId: bookingId,
      action: "gcal_sync_setter_reassigned",
      oldValue: JSON.stringify({ setterId: currentSetterId }),
      newValue: JSON.stringify({ setterId: newSetterId, setterName: incoming }),
      performedBy: "gcal_sync",
    },
  });
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
        // Re-attribute setter if the new event description names a different one.
        // (Same rule as the calendly webhook — most-recent setter gets credit on rebook.)
        await reattributeSetter(existing.id, existing.setterId, event.description || "");

        // Check for reschedule (time changed by more than 1 minute)
        const existingTime = existing.demoDate.getTime();
        const newTime = eventStart.getTime();

        if (Math.abs(existingTime - newTime) > 60000) {
          const { start, end } = getWeekRange(eventStart);
          const week = await prisma.week.upsert({
            where: { weekStart: start },
            create: { weekStart: start, weekEnd: end },
            update: {},
          });

          await prisma.booking.update({
            where: { id: existing.id },
            data: { demoDate: eventStart, weekId: week.id, bookedAt: new Date() },
          });

          if (existing.demo) {
            await prisma.demo.update({
              where: { id: existing.demo.id },
              data: {
                weekId: week.id,
                // Reset any non-showed status back to pending on reschedule
                // (no-show, rescheduled, cancelled → pending; showed stays showed)
                ...(existing.demo.status !== "showed" ? {
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
        } else if (
          existing.demo &&
          ["no_show", "rescheduled"].includes(existing.demo.status) &&
          eventStart.getTime() > Date.now()
        ) {
          // Date already matches (previous sync moved it) but status was never reset.
          // A future-dated demo cannot be a no-show — reset it to pending.
          await prisma.demo.update({
            where: { id: existing.demo.id },
            data: { status: "pending", confirmedBy: null, confirmedAt: null },
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

      // Dedup: check by email + date window (catches Calendly webhook duplicates)
      if (prospectEmail) {
        const windowStart = new Date(eventStart.getTime() - 4 * 60 * 60 * 1000);
        const windowEnd = new Date(eventStart.getTime() + 4 * 60 * 60 * 1000);
        const byEmail = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: prospectEmail, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
          },
          include: { demo: true },
        });
        if (byEmail) {
          // Link the GCal composite ID + bump bookedAt: a new GCal eventId matching
          // an existing prospect's email is a fresh rebook. Activity counter reads bookedAt.
          if (byEmail.calendarEventId !== compositeId) {
            await prisma.booking.update({
              where: { id: byEmail.id },
              data: { calendarEventId: compositeId, bookedAt: new Date() },
            });
          }
          // Re-attribute setter on rebook (same rule as the calendly webhook).
          await reattributeSetter(byEmail.id, byEmail.setterId, description);
          // Reset stale no_show/rescheduled status on future-dated demos
          if (
            byEmail.demo &&
            ["no_show", "rescheduled"].includes(byEmail.demo.status) &&
            eventStart.getTime() > Date.now()
          ) {
            await prisma.demo.update({
              where: { id: byEmail.demo.id },
              data: { status: "pending", confirmedBy: null, confirmedAt: null },
            });
            results.updated++;
          }
          continue;
        }
      }

      // Dedup: check by exact full name + date window — only when the new event has
      // no email AND no phone (otherwise the earlier email/phone path would have caught it).
      // Name-only matching is dangerous because two different prospects can share a name
      // within the window. Require an exact full-name match AND that neither side has a
      // conflicting email — if both records have emails and they differ, treat as distinct.
      if (prospectName && !prospectEmail && !prospectPhone) {
        const windowStart = new Date(eventStart.getTime() - 4 * 60 * 60 * 1000);
        const windowEnd = new Date(eventStart.getTime() + 4 * 60 * 60 * 1000);
        const byName = await prisma.booking.findFirst({
          where: {
            prospectName: { equals: prospectName, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
          },
          include: { demo: true },
        });
        if (byName) {
          if (byName.calendarEventId !== compositeId) {
            await prisma.booking.update({
              where: { id: byName.id },
              data: { calendarEventId: compositeId, bookedAt: new Date() },
            });
          }
          await reattributeSetter(byName.id, byName.setterId, description);
          if (
            byName.demo &&
            ["no_show", "rescheduled"].includes(byName.demo.status) &&
            eventStart.getTime() > Date.now()
          ) {
            await prisma.demo.update({
              where: { id: byName.demo.id },
              data: { status: "pending", confirmedBy: null, confirmedAt: null },
            });
            results.updated++;
          }
          continue;
        }
      }

      // Detect reschedule of a past no-show/rescheduled booking whose calendarEventId
      // was in Calendly format (calendly_UUID) and couldn't be matched above.
      // Only email-based matching — the previous first-name fallback collided across
      // unrelated prospects (e.g. "Pat Dreiling" hijacking "Patti Syme") and silently
      // rewrote demoDate + calendarEventId on the original row.
      if (prospectEmail) {
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
        const pastNoShow = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: prospectEmail, mode: "insensitive" },
            demoDate: { gte: sixtyDaysAgo, lt: eventStart },
            demo: { status: { in: ["no_show", "rescheduled"] } },
          },
          orderBy: { demoDate: "desc" },
          include: { demo: true },
        });

        if (pastNoShow) {
          const { start, end } = getWeekRange(eventStart);
          const reschedWeek = await prisma.week.upsert({
            where: { weekStart: start },
            create: { weekStart: start, weekEnd: end },
            update: {},
          });
          await prisma.booking.update({
            where: { id: pastNoShow.id },
            data: { demoDate: eventStart, weekId: reschedWeek.id, calendarEventId: compositeId, bookedAt: new Date() },
          });
          if (pastNoShow.demo) {
            await prisma.demo.update({
              where: { id: pastNoShow.demo.id },
              data: { weekId: reschedWeek.id, status: "pending", confirmedBy: null, confirmedAt: null },
            });
          }
          await prisma.auditLog.create({
            data: {
              entityType: "booking",
              entityId: pastNoShow.id,
              action: "gcal_sync_rescheduled",
              oldValue: JSON.stringify({ demoDate: pastNoShow.demoDate }),
              newValue: JSON.stringify({ demoDate: eventStart }),
              performedBy: "gcal_sync",
            },
          });
          await reattributeSetter(pastNoShow.id, pastNoShow.setterId, description);
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
          bookedAt: new Date(),
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
