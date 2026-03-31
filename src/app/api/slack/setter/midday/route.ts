import { NextResponse } from "next/server";
import { getAllSetterScoresToday, formatSetterMention, isWeekday, PIGEON_GIFS } from "@/lib/setter-game";
import { sendSlackSetter } from "@/lib/slack";

export async function POST() {
  if (!isWeekday()) {
    return NextResponse.json({ skipped: true, reason: "weekend" });
  }

  const scores = await getAllSetterScoresToday();

  const blocks: unknown[] = [];

  for (const setter of scores) {
    const mention = formatSetterMention({
      id: setter.setterId,
      name: setter.setterName,
      slackUserId: setter.slackUserId,
    });
    const count = setter.bookings;
    let message: string;
    let gif: string;

    if (count >= 12) {
      message = `${mention} — ${count} demos booked and it's only noon.\n🟡 LEGENDARY — Tuffest Pigeon before lunch.\nWhatever you're doing, don't stop.`;
      gif = PIGEON_GIFS.tuffest_pigeon;
    } else if (count >= 9) {
      message = `${mention} — ${count} demos booked before noon.\n🔵 RARE — TPD status at noon.\nClose out the day strong.`;
      gif = PIGEON_GIFS.tpd;
    } else if (count >= 4) {
      message = `${mention} — ${count} demos booked.\n🟢 UNCOMMON — Common Pigeon status at noon.\nOn pace. Not elite yet.`;
      gif = PIGEON_GIFS.common_pigeon;
    } else {
      message = `${mention} — ${count} demos booked.\nStill a Gay Pigeon.\nYou have an afternoon. Use it.`;
      gif = PIGEON_GIFS.gay_pigeon;
    }

    blocks.push({ type: "image", image_url: gif, alt_text: "pigeon" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: message } });
  }

  const fallback = scores
    .map((s) => `${s.setterName}: ${s.bookings} demos`)
    .join(", ");

  await sendSlackSetter(`Midday check-in: ${fallback}`, blocks);

  return NextResponse.json({ success: true, scores: scores.length });
}

export async function GET() {
  return POST();
}
