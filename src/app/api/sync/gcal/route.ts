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

function parsePhone(description: string): string | null {
  const match = description.match(/Phone Number:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

function parseProspectName(summary: string): string {
  // Summaries are typically "Grassfed Demo - John Smith" or "John Smith and Colin"
  // Try to extract the prospect name (non-closer part)
  const cleaned = summary
    .replace(/Grassfed Demo\s*[-:]\s*/i, "")
    .replace(/\s+and\s+(Colin|Mark)\b/i, "")
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

// --- Main sync logic ---

async function syncCalendar(
  calendarEmail: string,
  closerName: string,
  accessToken: string
): Promise<{ new: number; updated: number; canceled: number; errors: string[] }> {
  const results = { new: 0, updated: 0, canceled: 0, errors: [] as string[] };

  const now = new Date();
  const timeMin = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

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

      const compositeId = `${event.id}_${closerName}`;

      // Skip dismissed events (manually deleted by user)
      const dismissed = await prisma.dismissedEvent.findUnique({
        where: { calendarEventId: compositeId },
      });
      if (dismissed) continue;

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
            data: { demoDate: eventStart, weekId: week.id },
          });

          if (existing.demo) {
            await prisma.demo.update({
              where: { id: existing.demo.id },
              data: {
                weekId: week.id,
                // Reset rescheduled status back to pending
                ...(existing.demo.status === "rescheduled" ? {
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

      // Dedup: check by email + date window (catches Calendly webhook duplicates)
      if (prospectEmail) {
        const windowStart = new Date(eventStart.getTime() - 4 * 60 * 60 * 1000);
        const windowEnd = new Date(eventStart.getTime() + 4 * 60 * 60 * 1000);
        const byEmail = await prisma.booking.findFirst({
          where: {
            prospectEmail: { equals: prospectEmail, mode: "insensitive" },
            demoDate: { gte: windowStart, lte: windowEnd },
          },
        });
        if (byEmail) continue; // Already exists from Calendly webhook
      }

      // Dedup: check by first name + date window
      if (prospectName) {
        const firstName = prospectName.split(/\s+/)[0];
        if (firstName && firstName.length > 2) {
          const windowStart = new Date(eventStart.getTime() - 4 * 60 * 60 * 1000);
          const windowEnd = new Date(eventStart.getTime() + 4 * 60 * 60 * 1000);
          const byName = await prisma.booking.findFirst({
            where: {
              prospectName: { startsWith: firstName, mode: "insensitive" },
              demoDate: { gte: windowStart, lte: windowEnd },
            },
          });
          if (byName) continue; // Already exists
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

  const totals = { new: 0, updated: 0, canceled: 0, errors: [] as string[] };

  try {
    const accessToken = await getAccessToken(clientEmail, privateKey);

    for (const cal of CALENDARS) {
      const result = await syncCalendar(cal.email, cal.closerName, accessToken);
      totals.new += result.new;
      totals.updated += result.updated;
      totals.canceled += result.canceled;
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
    message: `GCal sync: ${totals.new} new, ${totals.updated} rescheduled, ${totals.canceled} canceled`,
    totals,
    calendars: CALENDARS.map((c) => c.email),
  });
}
