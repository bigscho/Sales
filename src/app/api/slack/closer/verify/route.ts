import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sendSlackCloser, sendSlackCEO } from "@/lib/slack";
import { formatMention, isWeekday, getETDateBounds } from "@/lib/setter-game";
import { getWeekRange, computeShowRate } from "@/lib/utils";

const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.NEXTAUTH_URL || "https://sales-puce-six.vercel.app";

export async function POST() {
  if (!isWeekday()) {
    return NextResponse.json({ skipped: true, reason: "weekend" });
  }

  const { start: weekStart } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart } });
  if (!week) {
    return NextResponse.json({ skipped: true, reason: "no_week" });
  }

  // Get today's date bounds in ET
  const { start: todayStart, end: todayEnd } = getETDateBounds();

  // Get active closers
  const closers = await prisma.teamMember.findMany({
    where: { role: "closer", isActive: true },
  });

  const closerSummaries: string[] = [];

  for (const closer of closers) {
    const mention = formatMention(closer);

    // Today's demos assigned to this closer
    const todayDemos = await prisma.demo.findMany({
      where: {
        weekId: week.id,
        closerId: closer.id,
        booking: { demoDate: { gte: todayStart, lt: todayEnd } },
      },
      include: { booking: { include: { setter: true } } },
    });

    // WTD demos for this closer
    const wtdDemos = await prisma.demo.findMany({
      where: { weekId: week.id, closerId: closer.id },
      include: { booking: true },
    });

    const todayPending = todayDemos.filter(d => d.status === "pending");
    const todayShowed = todayDemos.filter(d => d.status === "showed").length;
    const todayNoShow = todayDemos.filter(d => d.status === "no_show").length;

    const wtdShowed = wtdDemos.filter(d => d.status === "showed").length;
    const wtdNoShow = wtdDemos.filter(d => d.status === "no_show").length;
    const wtdCancelled = wtdDemos.filter(d => d.status === "cancelled").length;
    const wtdDenom = wtdShowed + wtdNoShow + wtdCancelled;
    const wtdShowRate = wtdDenom > 0 ? (computeShowRate(wtdShowed, wtdNoShow, wtdCancelled) * 100).toFixed(0) : "--";
    const wtdPending = wtdDemos.filter(d => d.status === "pending").length;

    const demosLink = `${BASE_URL}/demos?weekId=${week.id}`;

    // Build pending list for today
    const pendingList = todayPending.map(d => {
      const name = d.booking.prospectName || "Unknown";
      const setter = d.booking.setter?.name || "?";
      const time = new Date(d.booking.demoDate).toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      });
      return `   • ${name} (${time}, set by ${setter})`;
    }).join("\n");

    const lines = [
      `${mention}`,
      `*Today:* ${todayDemos.length} demos — ${todayShowed} showed, ${todayNoShow} no-show, ${todayPending.length} pending`,
    ];

    if (todayPending.length > 0) {
      lines.push(`*Needs your confirmation:*`);
      lines.push(pendingList);
    }

    lines.push(`*Week-to-date:* ${wtdShowRate}% show rate (${wtdShowed}/${wtdDenom})${wtdCancelled > 0 ? ` | ${wtdCancelled} cancelled` : ""}${wtdPending > 0 ? ` | ${wtdPending} still pending` : ""}`);
    lines.push(`<${demosLink}|Open Demos Page to Verify>`);

    await sendSlackCloser(lines.join("\n"));

    closerSummaries.push(`${closer.name}: today ${todayShowed}/${todayDemos.length} showed, ${todayPending.length} pending | WTD ${wtdShowRate}% (${wtdShowed}/${wtdDenom})`);
  }

  // CEO summary
  const ceoMessage = [
    `*Closer Verification Push (8 PM)*`,
    ...closerSummaries,
  ].join("\n");

  await sendSlackCEO(ceoMessage);

  return NextResponse.json({ success: true, closers: closers.length });
}

export async function GET() {
  return POST();
}
