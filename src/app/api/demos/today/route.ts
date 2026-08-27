import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { newBookingActivityWhere } from "@/lib/booking-activity";

export const dynamic = "force-dynamic";

// Returns all bookings created today (ET), regardless of which week the demo is in
export async function GET() {
  // Get today's boundaries in ET
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = etFormatter.formatToParts(new Date());
  const year = parseInt(parts.find(p => p.type === "year")!.value);
  const month = parseInt(parts.find(p => p.type === "month")!.value) - 1;
  const day = parseInt(parts.find(p => p.type === "day")!.value);

  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etString);
  const diffMs = now.getTime() - etDate.getTime();

  const todayStart = new Date(Date.UTC(year, month, day) + diffMs);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  // Match the scoreboard's activity definition exactly (shared helper): bookings
  // credited today by bookedAt, chain roots only — a rebook of an older no-show is
  // not a new booking today, so it does not appear here.
  const demos = await prisma.demo.findMany({
    where: {
      booking: newBookingActivityWhere({ gte: todayStart, lt: todayEnd }),
    },
    include: {
      booking: { include: { setter: true } },
      closer: true,
      deal: true,
    },
    orderBy: { booking: { createdAt: "desc" } },
  });

  return NextResponse.json({ demos, count: demos.length });
}
