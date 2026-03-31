import { NextResponse } from "next/server";
import { getAllSetterScoresToday, formatSetterMention, getPipelineCount, isWeekday, PIGEON_GIFS } from "@/lib/setter-game";
import { sendSlackSetter } from "@/lib/slack";

export async function POST() {
  if (!isWeekday()) {
    return NextResponse.json({ skipped: true, reason: "weekend" });
  }

  const scores = await getAllSetterScoresToday();

  // Individual setter EOD messages
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
      message = `${mention} — final count: ${count} demos booked.\n🟡 LEGENDARY — TUFFEST PIGEON OF THE DAY.\nThat's the ceiling. The doctor is taking notes.`;
      gif = PIGEON_GIFS.tuffest_pigeon;
    } else if (count >= 9) {
      message = `${mention} — final count: ${count} demos booked.\n🔵 RARE — Tuff Pigeon Doctor. The doctor worked today.`;
      gif = PIGEON_GIFS.tpd;
    } else if (count >= 4) {
      message = `${mention} — final count: ${count} demos booked.\n🟢 UNCOMMON — Common Pigeon.\nShowed up. Not elite.`;
      gif = PIGEON_GIFS.common_pigeon;
    } else {
      message = `${mention} — final count: ${count} demos booked.\n⚪ COMMON — Sad Pigeon.\nTomorrow the Gay Pigeon drops at 9AM and none of this counts anymore.\nCome back ready.`;
      gif = PIGEON_GIFS.sad_pigeon;
    }

    const blocks: unknown[] = [
      { type: "image", image_url: gif, alt_text: "pigeon" },
      { type: "section", text: { type: "mrkdwn", text: message } },
    ];

    await sendSlackSetter(message, blocks);
  }

  // Team pipeline post
  const pipelineCount = await getPipelineCount();
  let pipelineMessage: string;
  const pipelineBlocks: unknown[] = [];

  if (pipelineCount < 10) {
    pipelineMessage = `PIPELINE: ${pipelineCount} demos ahead.\nThat is not enough.\nThe waiting room is empty.`;
    pipelineBlocks.push({ type: "image", image_url: PIGEON_GIFS.less_than_10, alt_text: "pigeon" });
  } else if (pipelineCount < 30) {
    pipelineMessage = `PIPELINE: ${pipelineCount} demos ahead.\nFunctional. Target is 30+.`;
  } else {
    pipelineMessage = `PIPELINE: ${pipelineCount} DEMOS AHEAD.\nThe waiting room is stacked. Keep it there.`;
    pipelineBlocks.push({ type: "image", image_url: PIGEON_GIFS.more_than_30, alt_text: "pigeon" });
  }

  pipelineBlocks.push({ type: "section", text: { type: "mrkdwn", text: pipelineMessage } });

  await sendSlackSetter(pipelineMessage, pipelineBlocks);

  return NextResponse.json({ success: true, scores: scores.length, pipeline: pipelineCount });
}

export async function GET() {
  return POST();
}
