import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

export async function POST() {
  const results: Record<string, { status: string; records?: number; error?: string }> = {};

  // Ensure current week + last 3 weeks exist
  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    const { start, end } = getWeekRange(d);
    await prisma.week.upsert({
      where: { weekStart: start },
      create: { weekStart: start, weekEnd: end },
      update: {},
    });
  }

  // Sync Stripe
  try {
    const stripeResult = await syncStripe();
    results.stripe = { status: "success", records: stripeResult };
  } catch (error) {
    results.stripe = { status: "error", error: String(error) };
  }

  // Sync Google Calendar
  try {
    const calResult = await syncGoogleCalendar();
    results.gcal = { status: "success", records: calResult };
  } catch (error) {
    results.gcal = { status: "error", error: String(error) };
  }

  // Log sync
  for (const [source, result] of Object.entries(results)) {
    await prisma.syncLog.create({
      data: {
        source,
        syncType: "full",
        status: result.status,
        recordsSynced: result.records || 0,
        errorMessage: result.error,
        completedAt: new Date(),
      },
    });
  }

  return NextResponse.json({ results });
}

async function syncStripe(): Promise<number> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return 0;

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(key);

  const now = new Date();
  const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

  let count = 0;
  const paymentIntents = await stripe.paymentIntents.list({
    created: { gte: Math.floor(fourWeeksAgo.getTime() / 1000) },
    limit: 100,
  });

  for (const pi of paymentIntents.data) {
    if (pi.status !== "succeeded") continue;

    const existing = await prisma.payment.findUnique({
      where: { stripePaymentIntentId: pi.id },
    });
    if (existing) continue;

    let customerName: string | undefined;
    let customerEmail: string | undefined;
    if (pi.customer) {
      try {
        const customer = await stripe.customers.retrieve(pi.customer as string);
        if (!("deleted" in customer && customer.deleted)) {
          customerName = customer.name || undefined;
          customerEmail = customer.email || undefined;
        }
      } catch {
        // Customer lookup failed
      }
    }

    await prisma.payment.create({
      data: {
        stripePaymentIntentId: pi.id,
        amountCents: pi.amount,
        currency: pi.currency,
        status: pi.status,
        paidAt: new Date(pi.created * 1000),
        customerName,
        customerEmail,
      },
    });
    count++;
  }

  return count;
}

async function syncGoogleCalendar(): Promise<number> {
  const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "colin@grsfd.co";
  if (!apiKey) return 0;

  const now = new Date();
  const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("timeMin", fourWeeksAgo.toISOString());
  url.searchParams.set("timeMax", now.toISOString());
  url.searchParams.set("maxResults", "100");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const res = await fetch(url.toString());
  if (!res.ok) return 0;

  const data = await res.json();
  const events = data.items || [];

  let count = 0;
  for (const event of events) {
    const desc = event.description || "";
    if (!desc.includes("Calendly") && !desc.includes("Booked by")) continue;

    const parsed = parseCalendlyEvent(event);
    if (!parsed) continue;

    // Check if already synced
    const existing = await prisma.booking.findUnique({
      where: { calendarEventId: event.id },
    });
    if (existing) continue;

    // Find the week
    const { start } = getWeekRange(new Date(parsed.demoDate));
    const week = await prisma.week.findFirst({ where: { weekStart: start } });
    if (!week) continue;

    // Find setter
    let setterId: string | null = null;
    if (parsed.setterName) {
      const setter = await prisma.teamMember.findFirst({
        where: { name: { equals: parsed.setterName, mode: "insensitive" }, role: "setter" },
      });
      setterId = setter?.id || null;
    }

    // Find closer
    let closerId: string | null = null;
    if (parsed.closerName) {
      const closer = await prisma.teamMember.findFirst({
        where: { name: { contains: parsed.closerName, mode: "insensitive" }, role: "closer" },
      });
      closerId = closer?.id || null;
    }

    const booking = await prisma.booking.create({
      data: {
        weekId: week.id,
        prospectName: parsed.prospectName,
        prospectPhone: parsed.phone,
        setterId,
        demoDate: new Date(parsed.demoDate),
        calendarEventId: event.id,
        source: "auto",
      },
    });

    await prisma.demo.create({
      data: {
        bookingId: booking.id,
        weekId: week.id,
        closerId,
      },
    });

    count++;
  }

  return count;
}

interface ParsedEvent {
  prospectName: string;
  closerName: string | null;
  setterName: string | null;
  phone: string | null;
  demoDate: string;
}

function parseCalendlyEvent(event: { summary?: string; description?: string; start?: { dateTime?: string } }): ParsedEvent | null {
  const summary = event.summary || "";
  const desc = event.description || "";
  const startTime = event.start?.dateTime;

  if (!startTime) return null;

  // Parse prospect name from summary: "Prospect Name and Colin Schofield"
  let prospectName = summary;
  let closerName: string | null = null;
  const andMatch = summary.match(/^(.+?)\s+and\s+(.+)$/i);
  if (andMatch) {
    prospectName = andMatch[1].trim();
    closerName = andMatch[2].trim().split(" ")[0]; // First name of closer
  }

  // Parse setter from description: "Booked by: Ming"
  let setterName: string | null = null;
  const bookedByMatch = desc.match(/Booked\s+by:\s*(\w+)/i);
  if (bookedByMatch) {
    setterName = bookedByMatch[1];
  }

  // Parse phone from description: "Phone Number: +1 269-720-8938"
  let phone: string | null = null;
  const phoneMatch = desc.match(/Phone\s*Number:\s*([+\d\s\-()]+)/i);
  if (phoneMatch) {
    phone = phoneMatch[1].trim();
  }

  return { prospectName, closerName, setterName, phone, demoDate: startTime };
}
