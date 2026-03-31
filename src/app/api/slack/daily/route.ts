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
  const showRate = total > 0 ? ((showed / total) * 100).toFixed(1) : "0.0";

  // Cash collected today
  const todayPayments = await prisma.payment.findMany({
    where: {
      paidAt: { gte: todayStart, lte: todayEnd },
      status: "succeeded",
    },
  });
  const cashCents = todayPayments.reduce((sum, p) => sum + p.amountCents, 0);

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

  const lines = [
    `📊 *Daily Recap — ${dayLabel}*`,
    "",
    `Today's demos: *${total}* booked, *${showed}* showed, *${noShow}* no-show, *${pending}* pending`,
    `Show rate: *${showRate}%*`,
    `Cash collected today: *${formatCents(cashCents)}*`,
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
