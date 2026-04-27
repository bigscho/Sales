import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Diagnostic + backfill endpoint for the rebooking-setter-attribution bug.
//
// Before today, when a prospect rebooked through a different setter's Calendly link,
// the webhook found the existing booking via email/name dedup but never overwrote
// setterId — so credit stayed with the original setter. This endpoint re-fetches
// the latest Calendly event for each booking, parses the "Booked by" string, and
// reports / corrects any mismatches.
//
// GET  ?since=YYYY-MM-DD&limit=N   — dry-run, returns mismatches only
// POST { bookingIds: string[] }    — apply fixes for specific bookings (audit-logged)
// POST { applyAll: true, since, limit } — apply fixes for every detected mismatch

interface CalendlyEventResource {
  description?: string;
  start_time?: string;
}

interface MismatchRow {
  bookingId: string;
  prospectName: string;
  prospectEmail: string | null;
  demoDate: Date;
  calendarEventId: string;
  currentSetterId: string | null;
  currentSetterName: string | null;
  calendlySetterName: string;
  candidateSetterId: string | null;
}

async function fetchCalendlyBookedBy(eventUuid: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.calendly.com/scheduled_events/${eventUuid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const resource: CalendlyEventResource = data.resource || {};
    const desc = resource.description || "";
    const match = desc.match(/Booked\s+[Bb]y:?\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function scanForMismatches(since: Date, limit: number): Promise<MismatchRow[]> {
  const token = process.env.CALENDLY_API_TOKEN;
  if (!token) return [];

  const bookings = await prisma.booking.findMany({
    where: {
      calendarEventId: { startsWith: "calendly_" },
      demoDate: { gte: since },
    },
    include: { setter: true },
    orderBy: { demoDate: "desc" },
    take: limit,
  });

  const mismatches: MismatchRow[] = [];
  for (const b of bookings) {
    if (!b.calendarEventId) continue;
    const uuid = b.calendarEventId.replace(/^calendly_/, "");
    const bookedByName = await fetchCalendlyBookedBy(uuid, token);
    if (!bookedByName) continue;

    const currentName = b.setter?.name || null;
    const sameByName = currentName && currentName.toLowerCase().includes(bookedByName.toLowerCase());
    if (sameByName) continue;

    const candidate = await prisma.teamMember.findFirst({
      where: { name: { contains: bookedByName, mode: "insensitive" }, role: "setter" },
    });

    mismatches.push({
      bookingId: b.id,
      prospectName: b.prospectName,
      prospectEmail: b.prospectEmail,
      demoDate: b.demoDate,
      calendarEventId: b.calendarEventId,
      currentSetterId: b.setterId,
      currentSetterName: currentName,
      calendlySetterName: bookedByName,
      candidateSetterId: candidate?.id || null,
    });
  }

  return mismatches;
}

async function applyFixes(rows: MismatchRow[]): Promise<{ fixed: number; skipped: number }> {
  let fixed = 0;
  let skipped = 0;

  for (const row of rows) {
    let setterId = row.candidateSetterId;
    if (!setterId) {
      const newMember = await prisma.teamMember.create({
        data: { name: row.calendlySetterName, role: "setter", excludeFromLeaderboard: true },
      });
      setterId = newMember.id;
    }
    if (setterId === row.currentSetterId) {
      skipped++;
      continue;
    }
    await prisma.booking.update({
      where: { id: row.bookingId },
      data: { setterId },
    });
    await prisma.auditLog.create({
      data: {
        entityType: "booking",
        entityId: row.bookingId,
        action: "setter_audit_backfill",
        oldValue: JSON.stringify({ setterId: row.currentSetterId, setterName: row.currentSetterName }),
        newValue: JSON.stringify({ setterId, setterName: row.calendlySetterName }),
        performedBy: "setter_audit",
      },
    });
    fixed++;
  }

  return { fixed, skipped };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sinceParam = searchParams.get("since");
  const limit = parseInt(searchParams.get("limit") || "100", 10);
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const mismatches = await scanForMismatches(since, limit);
  return NextResponse.json({
    scannedSince: since.toISOString(),
    limit,
    mismatchCount: mismatches.length,
    mismatches,
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { bookingIds, applyAll, since: sinceParam, limit } = body;

  const sinceDate = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const limitNum = typeof limit === "number" ? limit : 100;

  if (applyAll) {
    const mismatches = await scanForMismatches(sinceDate, limitNum);
    const result = await applyFixes(mismatches);
    return NextResponse.json({ ...result, scanned: mismatches.length });
  }

  if (Array.isArray(bookingIds) && bookingIds.length > 0) {
    const all = await scanForMismatches(sinceDate, Math.max(limitNum, bookingIds.length * 2));
    const filtered = all.filter((r) => bookingIds.includes(r.bookingId));
    const result = await applyFixes(filtered);
    return NextResponse.json({ ...result, requested: bookingIds.length, matched: filtered.length });
  }

  return NextResponse.json(
    { error: "Provide { bookingIds: [...] } or { applyAll: true }" },
    { status: 400 }
  );
}
