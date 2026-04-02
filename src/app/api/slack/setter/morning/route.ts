import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { formatSetterMention, isWeekday, PIGEON_GIFS } from "@/lib/setter-game";
import { sendSlackSetter, sendSlackVerify } from "@/lib/slack";
import { getWeekRange } from "@/lib/utils";

export async function POST() {
  if (!isWeekday()) {
    return NextResponse.json({ skipped: true, reason: "weekend" });
  }

  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
  });

  const mentions = setters.map((s) => formatSetterMention(s)).join(" ");
  const text = `${mentions}\n\nAll of your Gay Pigeon statuses have been renewed. You've booked 0 today.\nIt's up to you to ascend. Nobody cares what you did yesterday.`;

  await sendSlackSetter(text, [
    { type: "image", image_url: PIGEON_GIFS.gay_pigeon, alt_text: "Gay Pigeon" },
    { type: "section", text: { type: "mrkdwn", text } },
  ]);

  // Check who hasn't confirmed their demos yet this week
  const { start: weekStart } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart } });
  if (week) {
    const verifications = await prisma.setterVerification.findMany({
      where: { weekId: week.id },
      select: { setterId: true, status: true },
    });
    const confirmedSetterIds = new Set(verifications.map(v => v.setterId));
    const unconfirmed = setters.filter(s => !confirmedSetterIds.has(s.id));

    if (unconfirmed.length > 0) {
      const unconfirmedMentions = unconfirmed.map(s => formatSetterMention(s)).join(", ");
      await sendSlackVerify(`*Not yet confirmed this week:* ${unconfirmedMentions}\nReview and confirm your demos before end of week.`);
    }
  }

  return NextResponse.json({ success: true, setterCount: setters.length });
}

export async function GET() {
  return POST();
}
