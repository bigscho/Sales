import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { formatMention } from "@/lib/setter-game";
import { sendSlackShowRate } from "@/lib/slack";
import { getWeekRange } from "@/lib/utils";

export async function POST() {
  const { start: weekStart } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart } });

  const activeSetters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true },
  });

  const setterStats: Array<{
    setterId: string;
    name: string;
    slackUserId: string | null;
    shows: number;
    noShows: number;
    pending: number;
    showRate: string;
  }> = [];

  let teamShows = 0;
  let teamNoShows = 0;

  for (const setter of activeSetters) {
    let shows = 0;
    let noShows = 0;
    let pending = 0;

    if (week) {
      const demos = await prisma.demo.findMany({
        where: { weekId: week.id, booking: { setterId: setter.id } },
      });
      shows = demos.filter(d => d.status === "showed").length;
      noShows = demos.filter(d => d.status === "no_show").length;
      pending = demos.filter(d => d.status === "pending").length;
    }

    const confirmed = shows + noShows;
    const showRate = confirmed > 0 ? ((shows / confirmed) * 100).toFixed(0) : "—";

    setterStats.push({
      setterId: setter.id,
      name: setter.name,
      slackUserId: setter.slackUserId,
      shows,
      noShows,
      pending,
      showRate,
    });

    teamShows += shows;
    teamNoShows += noShows;
  }

  // Sort by show rate descending (setters with data first)
  setterStats.sort((a, b) => {
    const aRate = a.showRate === "—" ? -1 : parseInt(a.showRate);
    const bRate = b.showRate === "—" ? -1 : parseInt(b.showRate);
    return bRate - aRate;
  });

  const lines = setterStats.map(s => {
    const mention = formatMention({ id: s.setterId, name: s.name, slackUserId: s.slackUserId });
    return `${mention} — ${s.showRate}% (${s.shows} showed, ${s.noShows} no-show, ${s.pending} pending)`;
  });

  const teamConfirmed = teamShows + teamNoShows;
  const teamShowRate = teamConfirmed > 0 ? ((teamShows / teamConfirmed) * 100).toFixed(0) : "—";

  const message = `📊 WEEKLY SHOW RATE REPORT\n\n${lines.join("\n")}\n\nTeam average: ${teamShowRate}% show rate to date`;

  await sendSlackShowRate(message);

  return NextResponse.json({ success: true, setters: setterStats.length, teamShowRate });
}

export async function GET() {
  return POST();
}
