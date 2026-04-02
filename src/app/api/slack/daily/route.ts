import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackTeam } from "@/lib/slack";
import { formatCents } from "@/lib/utils";

export async function POST() {
  const now = new Date();

  // Today and tomorrow as UTC date boundaries
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const tomorrowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const tomorrowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 23, 59, 59, 999));

  // Demos for today (via booking.demoDate)
  const todayDemos = await prisma.demo.findMany({
    where: {
      booking: {
        demoDate: { gte: todayStart, lte: todayEnd },
      },
    },
  });

  const total = todayDemos.length;
  const showed = todayDemos.filter((d) => d.status === "showed").length;
  const noShow = todayDemos.filter((d) => d.status === "no_show").length;
  const pending = todayDemos.filter((d) => d.status === "pending").length;
  const confirmed = showed + noShow;
  const showRate = confirmed > 0 ? ((showed / confirmed) * 100).toFixed(1) : "0.0";

  // Cash collected today
  const todayPayments = await prisma.payment.findMany({
    where: {
      paidAt: { gte: todayStart, lte: todayEnd },
      status: "succeeded",
    },
  });
  const cashCents = todayPayments.reduce((sum, p) => sum + p.amountCents, 0);

  const newRevenueCents = todayPayments
    .filter((p) => (p.customerStatusOverride || p.customerStatus) === "new")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const returningRevenueCents = todayPayments
    .filter((p) => (p.customerStatusOverride || p.customerStatus) === "returning")
    .reduce((sum, p) => sum + p.amountCents, 0);

  // Tomorrow's demos count
  const tomorrowCount = await prisma.booking.count({
    where: {
      demoDate: { gte: tomorrowStart, lte: tomorrowEnd },
    },
  });

  const dayLabel = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  const dayName = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });

  const lines = [
    `📊 *UNOFFICIAL ${dayName} Stats (awaiting official admin confirmation):*`,
    "",
    `Today's demos: *${total}* booked, *${showed}* showed, *${noShow}* no-show, *${pending}* pending`,
    `Show rate: *${showRate}%*${pending > 0 ? ` (${pending} demos still pending)` : ""}`,
    `Cash collected today: *${formatCents(cashCents)}*`,
    `💵 New Revenue: *${formatCents(newRevenueCents)}* | Returning: *${formatCents(returningRevenueCents)}*`,
    `Tomorrow's preview: *${tomorrowCount}* demos scheduled`,
  ];

  if (pending > 0) {
    lines.push("");
    lines.push(`⚠️ *${pending}* demos still need confirmation`);
  }

  const message = lines.join("\n");
  await sendSlackTeam(message);

  return NextResponse.json({ success: true });
}

export async function GET() {
  return POST();
}
