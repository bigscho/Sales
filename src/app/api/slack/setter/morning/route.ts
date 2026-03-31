import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { formatSetterMention, isWeekday, PIGEON_GIFS } from "@/lib/setter-game";
import { sendSlackSetter } from "@/lib/slack";

export async function POST() {
  if (!isWeekday()) {
    return NextResponse.json({ skipped: true, reason: "weekend" });
  }

  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true },
  });

  const mentions = setters.map((s) => formatSetterMention(s)).join(" ");
  const text = `You all ^ rn ${mentions}`;

  await sendSlackSetter(text, [
    { type: "image", image_url: PIGEON_GIFS.gay_pigeon, alt_text: "Gay Pigeon" },
    { type: "section", text: { type: "mrkdwn", text } },
  ]);

  return NextResponse.json({ success: true, setterCount: setters.length });
}

export async function GET() {
  return POST();
}
