import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentETDay, shiftETDay, syncTrellusDay, TrellusSyncResult } from "@/lib/trellus";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Trellus dialer sync — cron hits this hourly through the dialing day (plus a
// post-close final pass) with no params, recomputing today's SetterDialDay
// rows. Manual/backfill use: ?date=YYYY-MM-DD (ET day) and ?days=N syncs N
// days starting at `date` going BACKWARD (date, date-1, ...), paced for the
// Trellus rate limit. Max 7 days per request — loop requests for bigger
// backfills.
export async function GET(request: NextRequest) {
  const apiKey = process.env.TRELLUS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "TRELLUS_API_KEY not set" }, { status: 500 });
  }

  const dateParam = request.nextUrl.searchParams.get("date");
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const days = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get("days") || "1"), 1), 7);
  const firstDay = dateParam || currentETDay();

  const log = await prisma.syncLog.create({
    data: { source: "trellus", syncType: days > 1 ? "backfill" : "dial_day", status: "running" },
  });

  const results: TrellusSyncResult[] = [];
  try {
    for (let i = 0; i < days; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000));
      results.push(await syncTrellusDay(apiKey, shiftETDay(firstDay, -i)));
    }
    const unmapped = results.reduce(
      (acc, r) => Object.assign(acc, r.unmappedResourceIds),
      {} as Record<string, number>,
    );
    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "success",
        recordsSynced: results.reduce((n, r) => n + Object.keys(r.setters).length, 0),
        completedAt: new Date(),
        // Surface unmapped Trellus seats so a new setter's unmapped dials are
        // visible in the log instead of silently dropped.
        errorMessage: Object.keys(unmapped).length
          ? `unmapped resource_ids: ${JSON.stringify(unmapped)}`
          : null,
      },
    });
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", errorMessage: message, completedAt: new Date() },
    });
    return NextResponse.json({ ok: false, error: message, results }, { status: 500 });
  }
}
