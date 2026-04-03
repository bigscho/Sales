import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { awardWeeklyCredits } from "@/lib/credits";

// POST /api/credits/award — weekly cron to award credits
// Called automatically (system route) or manually by admin
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let weekId = searchParams.get("weekId");

  // If no weekId provided, find the most recently completed week
  if (!weekId) {
    const now = new Date();
    const recentWeek = await prisma.week.findFirst({
      where: { weekEnd: { lt: now } },
      orderBy: { weekEnd: "desc" },
    });
    if (!recentWeek) {
      return NextResponse.json({ error: "No completed week found" }, { status: 404 });
    }
    weekId = recentWeek.id;
  }

  const result = await awardWeeklyCredits(weekId);

  return NextResponse.json({
    weekId,
    awardsCount: result.awards.length,
    awards: result.awards,
  });
}
