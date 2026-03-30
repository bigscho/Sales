import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

export async function GET() {
  // Ensure current week + 2 future weeks exist
  for (let i = -2; i <= 0; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i * 7);
    const { start, end } = getWeekRange(d);
    await prisma.week.upsert({
      where: { weekStart: start },
      create: { weekStart: start, weekEnd: end },
      update: {},
    });
  }

  const weeks = await prisma.week.findMany({
    orderBy: { weekStart: "desc" },
    take: 20,
  });

  return NextResponse.json({ weeks });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { weekId, action } = body;

  if (action === "confirm") {
    const week = await prisma.week.update({
      where: { id: weekId },
      data: {
        status: "confirmed",
        confirmedBy: "admin",
        confirmedAt: new Date(),
      },
    });
    return NextResponse.json({ week });
  }

  if (action === "create") {
    const { weekStart } = body;
    const start = new Date(weekStart);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    const week = await prisma.week.upsert({
      where: { weekStart: start },
      create: { weekStart: start, weekEnd: end },
      update: {},
    });
    return NextResponse.json({ week });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
