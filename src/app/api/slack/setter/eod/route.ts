import { NextResponse } from "next/server";
import { getAllSetterScoresToday, formatSetterMention, formatMention, getPipelineCount, isWeekday, PIGEON_GIFS, getSetterWeeklyShows, getTierForCount, getWeeklyShowStats } from "@/lib/setter-game";
import { sendSlackSetter } from "@/lib/slack";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

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

    // Personal show rate for this setter
    const setterShowStats = await getSetterWeeklyShows(setter.setterId);
    const { start: weekStart } = getWeekRange(new Date());
    const setterWeek = await prisma.week.findFirst({ where: { weekStart } });
    let setterNoShows = 0;
    if (setterWeek) {
      const setterDemos = await prisma.demo.findMany({
        where: { weekId: setterWeek.id, booking: { setterId: setter.setterId } },
      });
      setterNoShows = setterDemos.filter(d => d.status === "no_show").length;
    }
    const setterConfirmed = setterShowStats.shows + setterNoShows;
    const setterShowRate = setterConfirmed > 0 ? ((setterShowStats.shows / setterConfirmed) * 100).toFixed(0) : "—";

    const showRateLine = `\nYour demos showed at ${setterShowRate}% this week (${setterShowStats.shows} showed, ${setterShowStats.pending} pending)`;
    message += showRateLine;

    const blocks: unknown[] = [
      { type: "image", image_url: gif, alt_text: "pigeon" },
      { type: "section", text: { type: "mrkdwn", text: message } },
    ];

    await sendSlackSetter(message, blocks);
  }

  // Team show rate summary
  const { totalShows: wkShows, totalNoShows: wkNoShows, totalPending: wkPending } = await getWeeklyShowStats();
  const wkConfirmed = wkShows + wkNoShows;
  const wkShowRate = wkConfirmed > 0 ? ((wkShows / wkConfirmed) * 100).toFixed(0) : "—";

  await sendSlackSetter(`*Show rate to date: ${wkShowRate}%* (${wkShows} showed, ${wkNoShows} no-show${wkPending > 0 ? `, ${wkPending} pending` : ""})`);

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

  // Friday weekly leaderboard
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
  });
  const todayDay = dayFormatter.format(new Date());

  if (todayDay === "Friday") {
    const { start: lbWeekStart } = getWeekRange(new Date());

    // Get weekly bookings per setter
    const activeSetters = await prisma.teamMember.findMany({
      where: { role: "setter", isActive: true },
    });

    const weeklyResults: Array<{ setterId: string; name: string; slackUserId: string | null; bookings: number; tierLabel: string }> = [];
    let teamTotal = 0;

    for (const s of activeSetters) {
      const bookings = await prisma.booking.count({
        where: {
          setterId: s.id,
          createdAt: { gte: lbWeekStart },
        },
      });
      const tier = getTierForCount(bookings);
      weeklyResults.push({
        setterId: s.id,
        name: s.name,
        slackUserId: s.slackUserId,
        bookings,
        tierLabel: tier.label.split(" — ")[0], // e.g. "RARE", "UNCOMMON", etc.
      });
      teamTotal += bookings;
    }

    // Sort descending by bookings
    weeklyResults.sort((a, b) => b.bookings - a.bookings);

    const medals = ["🥇", "🥈", "🥉"];
    const leaderLines = weeklyResults.map((r, i) => {
      const medal = i < 3 ? medals[i] : `${i + 1}.`;
      const mention = formatMention({ id: r.setterId, name: r.name, slackUserId: r.slackUserId });
      return `${medal} ${mention} — ${r.bookings} bookings (${r.tierLabel})`;
    });

    // Team show rate
    const { totalShows: lbShows, totalNoShows: lbNoShows } = await getWeeklyShowStats();
    const lbConfirmed = lbShows + lbNoShows;
    const lbShowRate = lbConfirmed > 0 ? ((lbShows / lbConfirmed) * 100).toFixed(0) : "—";

    const leaderboardMessage = `🏆 WEEKLY LEADERBOARD 🏆\n\n${leaderLines.join("\n")}\n\nTeam total: ${teamTotal} bookings | Show rate: ${lbShowRate}%`;

    await sendSlackSetter(leaderboardMessage);
  }

  return NextResponse.json({ success: true, scores: scores.length, pipeline: pipelineCount });
}

export async function GET() {
  return POST();
}
