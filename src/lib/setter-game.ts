import { prisma } from "./db";
import { sendSlackSetter } from "./slack";

// === PIGEON TIER DEFINITIONS ===
// GIF URLs use Google Drive thumbnail endpoint
const GIF_BASE = "https://drive.google.com/thumbnail?sz=w400&id=";

export const PIGEON_GIFS = {
  gay_pigeon: `${GIF_BASE}1qyRdod4YbVlp26mDJ8J4UG2Lxxk7rKHa`,
  sad_pigeon: `${GIF_BASE}1R-1-J3cTjt2woHoz5zTMDwFu5Jk90DbL`,
  common_pigeon: `${GIF_BASE}1H25beYC4R0LG6mh7BEpXBrIyt-He1yNU`,
  tpd: `${GIF_BASE}1UzOg97OFHm1nsfMUKZHj2MA3u2pjji6H`,
  tuffest_pigeon: `${GIF_BASE}1KE3RHV50WRk7u-k0VmW3FVHsDuiZfZ6C`,
  less_than_10: `${GIF_BASE}1v7Dbdq2C5fi0DqgltFmV3t0KFVXNeqzR`,
  more_than_30: `${GIF_BASE}1x0w7JnN4qJMamzcb1dfQZPaasBsU_dIn`,
  booked_30: `${GIF_BASE}1g5TIUZDQEVHcsVDUuKAFngclvgUQdg6E`,
};

export interface PigeonTier {
  name: string;
  label: string;
  min: number;
  points: number;
  gif: string;
}

export const TIERS: PigeonTier[] = [
  { name: "tuffest_pigeon", label: "LEGENDARY — Tuffest Pigeon", min: 12, points: 5, gif: PIGEON_GIFS.tuffest_pigeon },
  { name: "tpd", label: "RARE — Tuff Pigeon Doctor", min: 9, points: 2, gif: PIGEON_GIFS.tpd },
  { name: "common_pigeon", label: "UNCOMMON — Common Pigeon", min: 4, points: 1, gif: PIGEON_GIFS.common_pigeon },
  { name: "sad_pigeon", label: "COMMON — Sad Pigeon", min: 0, points: 0, gif: PIGEON_GIFS.sad_pigeon },
];

export const TIER_CROSSINGS = [4, 9, 12];

// === SLACK USER IDS ===
const SLACK_IDS: Record<string, string> = {
  "setter-ming": "U0A1CD7BU9W",
  "setter-luke": "U0APNBM43S7",
  "setter-jett": "U0B6EQNL6EA",
  "closer-colin": "U09UH7YSPV1",
  "closer-mark": "U0AKMP7A36H",
};

// === HELPERS ===

export function getTierForCount(count: number): PigeonTier {
  for (const tier of TIERS) {
    if (count >= tier.min) return tier;
  }
  return TIERS[TIERS.length - 1]; // sad_pigeon fallback
}

export function formatMention(member: { id: string; name: string; slackUserId?: string | null }): string {
  const slackId = member.slackUserId || SLACK_IDS[member.id];
  if (slackId) return `<@${slackId}>`;
  return `*${member.name}*`;
}

// Alias for backwards compatibility
export const formatSetterMention = formatMention;

export function getETDateBounds(): { start: Date; end: Date } {
  // Get current date in Eastern Time
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = etFormatter.formatToParts(new Date());
  const year = parseInt(parts.find(p => p.type === "year")!.value);
  const month = parseInt(parts.find(p => p.type === "month")!.value) - 1;
  const day = parseInt(parts.find(p => p.type === "day")!.value);

  // Find UTC offset for ET by comparing UTC now vs ET now
  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etString);
  const diffMs = now.getTime() - etDate.getTime();

  const todayStart = new Date(Date.UTC(year, month, day) + diffMs);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  return { start: todayStart, end: todayEnd };
}

export function isWeekday(): boolean {
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  const day = etFormatter.format(new Date());
  return !["Sat", "Sun"].includes(day);
}

// === DATA FUNCTIONS ===

export async function getSetterTodayBookings(setterId: string): Promise<{ count: number; tier: PigeonTier; score: { id: string; tierCrossings: string } }> {
  const { start, end } = getETDateBounds();

  // Count bookings credited today (ET) for this setter
  const count = await prisma.booking.count({
    where: {
      setterId,
      OR: [
        { bookedAt: { gte: start, lt: end } },
        { AND: [{ bookedAt: null }, { createdAt: { gte: start, lt: end } }] },
      ],
    },
  });

  const tier = getTierForCount(count);

  // Upsert daily score
  const dateKey = new Date(start.toISOString().slice(0, 10));
  const score = await prisma.setterDailyScore.upsert({
    where: { setterId_date: { setterId, date: dateKey } },
    create: { setterId, date: dateKey, bookings: count, pigeonTier: tier.name, points: tier.points },
    update: { bookings: count, pigeonTier: tier.name, points: tier.points },
  });

  return { count, tier, score };
}

export async function checkAndFireTierCrossing(setterId: string, newCount: number): Promise<boolean> {
  if (!TIER_CROSSINGS.includes(newCount)) return false;

  const { start } = getETDateBounds();
  const dateKey = new Date(start.toISOString().slice(0, 10));

  const score = await prisma.setterDailyScore.findUnique({
    where: { setterId_date: { setterId, date: dateKey } },
  });

  const firedCrossings = score?.tierCrossings ? score.tierCrossings.split(",").filter(Boolean) : [];
  if (firedCrossings.includes(String(newCount))) return false; // Already fired

  // Mark as fired
  firedCrossings.push(String(newCount));
  await prisma.setterDailyScore.upsert({
    where: { setterId_date: { setterId, date: dateKey } },
    create: { setterId, date: dateKey, bookings: newCount, tierCrossings: firedCrossings.join(",") },
    update: { tierCrossings: firedCrossings.join(","), bookings: newCount },
  });

  // Get the setter for mention formatting
  const setter = await prisma.teamMember.findUnique({ where: { id: setterId } });
  if (!setter) return false;
  const mention = formatSetterMention(setter);

  const tier = getTierForCount(newCount);

  // Build message based on which crossing
  let text: string;
  if (newCount === 4) {
    text = `${mention} just hit 4 demos booked today.\n🟢 UNCOMMON — Common Pigeon unlocked.\nYou're on the board. Keep going.`;
  } else if (newCount === 9) {
    text = `${mention} — 9 demos booked today.\n🔵 RARE — Tuff Pigeon Doctor unlocked.\nThe doctor has entered the building.\nDon't stop here.`;
  } else if (newCount === 12) {
    text = `${mention} — 12 DEMOS TODAY.\n🟡 LEGENDARY — TUFFEST PIGEON UNLOCKED.\nThe waiting room is full. The doctor is running back to back.\nEverybody else take notes.`;
  } else {
    text = `${mention} — ${newCount} demos booked today. ${tier.label} status.`;
  }

  // Award pigeon tier bonus credits
  try {
    const { awardPigeonBonus } = await import("./credits");
    const bonus = await awardPigeonBonus(setterId, tier.name);
    if (bonus !== null) {
      const bonusAmount = { tuffest_pigeon: 100, tpd: 50, common_pigeon: 10 }[tier.name] || 0;
      if (bonusAmount > 0) text += `\n_+${bonusAmount} text blast credits!_`;
    }
  } catch (err) {
    console.error("Failed to award pigeon bonus credits:", err);
  }

  // Send with GIF using Slack Block Kit
  await sendSlackSetter(text, [
    { type: "image", image_url: tier.gif, alt_text: tier.label },
    { type: "section", text: { type: "mrkdwn", text } },
  ]);

  return true;
}

export async function getAllSetterScoresToday(): Promise<Array<{
  setterId: string;
  setterName: string;
  slackUserId: string | null;
  bookings: number;
  tier: PigeonTier;
  points: number;
}>> {
  const { start, end } = getETDateBounds();

  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
  });

  const results = [];
  for (const setter of setters) {
    const count = await prisma.booking.count({
      where: {
        setterId: setter.id,
        OR: [
          { bookedAt: { gte: start, lt: end } },
          { AND: [{ bookedAt: null }, { createdAt: { gte: start, lt: end } }] },
        ],
      },
    });
    const tier = getTierForCount(count);
    results.push({
      setterId: setter.id,
      setterName: setter.name,
      slackUserId: setter.slackUserId,
      bookings: count,
      tier,
      points: tier.points,
    });
  }

  return results;
}

// Get total bookings today — all bookings + setter-only count
export async function getTeamTotalToday(): Promise<{ total: number; setterTotal: number }> {
  const { start, end } = getETDateBounds();
  const setterIds = (await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
    select: { id: true },
  })).map(s => s.id);

  const [total, setterTotal] = await Promise.all([
    prisma.booking.count({
      where: {
        OR: [
          { bookedAt: { gte: start, lt: end } },
          { AND: [{ bookedAt: null }, { createdAt: { gte: start, lt: end } }] },
        ],
      },
    }),
    prisma.booking.count({
      where: {
        setterId: { in: setterIds },
        OR: [
          { bookedAt: { gte: start, lt: end } },
          { AND: [{ bookedAt: null }, { createdAt: { gte: start, lt: end } }] },
        ],
      },
    }),
  ]);
  return { total, setterTotal };
}

export async function getPipelineCount(): Promise<number> {
  const now = new Date();
  return prisma.demo.count({
    where: {
      status: { in: ["pending", "showed"] },
      booking: { demoDate: { gt: now } },
    },
  });
}

// Get weekly show totals for the show rate channel
export async function getWeeklyShowStats(): Promise<{ totalShows: number; totalNoShows: number; totalPending: number; totalCancelled: number }> {
  const { getWeekRange } = await import("./utils");
  const { start } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart: start } });
  if (!week) return { totalShows: 0, totalNoShows: 0, totalPending: 0, totalCancelled: 0 };

  const demos = await prisma.demo.findMany({ where: { weekId: week.id } });
  const totalShows = demos.filter(d => d.status === "showed").length;
  const totalNoShows = demos.filter(d => d.status === "no_show").length;
  const totalPending = demos.filter(d => d.status === "pending").length;
  const totalCancelled = demos.filter(d => d.status === "cancelled").length;
  return { totalShows, totalNoShows, totalPending, totalCancelled };
}

// Get a setter's show stats for the current week
export async function getSetterWeeklyShows(setterId: string): Promise<{ shows: number; pending: number }> {
  const { getWeekRange } = await import("./utils");
  const { start } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart: start } });
  if (!week) return { shows: 0, pending: 0 };

  const demos = await prisma.demo.findMany({
    where: { weekId: week.id, booking: { setterId } },
  });
  const shows = demos.filter(d => d.status === "showed").length;
  const pending = demos.filter(d => d.status === "pending").length;
  return { shows, pending };
}

// Send show rate notification to #show-rate-tpds
export async function sendShowNotification(prospectName: string, setterId: string | null, closerName: string | null, confirmedBy?: string | null) {
  const { sendSlackShowRate } = await import("./slack");

  let setterMention = "Unknown setter";
  let setterShows = 0;
  let setterPending = 0;
  if (setterId) {
    const setter = await prisma.teamMember.findUnique({ where: { id: setterId } });
    if (setter) setterMention = formatSetterMention(setter);
    const stats = await getSetterWeeklyShows(setterId);
    setterShows = stats.shows;
    setterPending = stats.pending;
  }

  const { totalShows, totalPending, totalNoShows, totalCancelled } = await getWeeklyShowStats();

  // Team show rate to date — cancels count against us (they sat on the calendar)
  const { computeShowRate } = await import("./utils");
  const showRate = computeShowRate(totalShows, totalNoShows, totalCancelled);
  const denom = totalShows + totalNoShows + totalCancelled;
  const showRatePct = denom > 0 ? (showRate * 100).toFixed(0) : "—";

  // Number emoji for setter's show count
  const numEmojis = ["0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const showEmoji = setterShows <= 10 ? numEmojis[setterShows] : `*${setterShows}*`;

  // Look up closer by name for proper @mention
  let closerMention = closerName || "Unknown closer";
  if (closerName) {
    const closer = await prisma.teamMember.findFirst({
      where: { name: closerName, role: "closer" },
    });
    if (closer) closerMention = formatMention(closer);
  }

  // Fireflies attribution
  const verifiedNote = confirmedBy === "fireflies_auto" || confirmedBy === "fireflies_webhook"
    ? "\n_Confirmed automatically by Fireflies transcript_"
    : "";

  const message = `${showEmoji}\n${setterMention} is at ${setterShows} shows this week${setterPending > 0 ? ` (${setterPending} still pending)` : ""}\n\n${prospectName} just showed to the demo with ${closerMention}${verifiedNote}\n\n*TOTAL shows this week: ${totalShows}* | *Show rate to date: ${showRatePct}%*${totalPending > 0 ? ` | *${totalPending} pending*` : ""}`;

  await sendSlackShowRate(message);
}

// Get weekly closer stats
export async function getWeeklyCloserStats(): Promise<{
  totalNewRevenue: number;
  totalReturningRevenue: number;
  totalCloses: number;
}> {
  const { getWeekRange } = await import("./utils");
  const { start } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart: start } });
  if (!week) return { totalNewRevenue: 0, totalReturningRevenue: 0, totalCloses: 0 };

  const payments = await prisma.payment.findMany({
    where: { weekId: week.id, status: { in: ["succeeded", "partially_refunded", "refunded", "disputed"] } },
  });

  // Net of refunds — refunded money is not revenue
  const totalNewRevenue = payments
    .filter(p => (p.customerStatusOverride || p.customerStatus) === "new")
    .reduce((sum, p) => sum + p.amountCents - p.refundedCents, 0);
  const totalReturningRevenue = payments
    .filter(p => (p.customerStatusOverride || p.customerStatus) === "returning")
    .reduce((sum, p) => sum + p.amountCents - p.refundedCents, 0);

  const deals = await prisma.deal.findMany({
    where: { weekId: week.id, status: "closed_won" },
  });

  return { totalNewRevenue, totalReturningRevenue, totalCloses: deals.length };
}

// Send close notification to #closer-tpds
export async function sendCloseNotification(
  amountCents: number,
  customerName: string | null,
  closerId: string | null,
  revenueType: string,
  customerStatus: string,
) {
  const { sendSlackCloser } = await import("./slack");

  let closerMention = "Unknown closer";
  if (closerId) {
    const closer = await prisma.teamMember.findUnique({ where: { id: closerId } });
    if (closer) closerMention = formatMention(closer);
  }

  const amountStr = `$${(amountCents / 100).toFixed(2)}`;
  const typeLabel = revenueType === "mrr" ? "MRR" : revenueType === "one_time" ? "One-time" : "Payment";
  const statusLabel = customerStatus === "new" ? "🆕 New" : customerStatus === "returning" ? "🔄 Returning" : "";

  const { totalNewRevenue, totalCloses } = await getWeeklyCloserStats();
  const newRevStr = `$${(totalNewRevenue / 100).toFixed(2)}`;

  // Get show rate context — cancels count against us
  const { totalShows: weekShows, totalNoShows: weekNoShows, totalPending: weekPend, totalCancelled: weekCancelled } = await getWeeklyShowStats();
  const { computeShowRate } = await import("./utils");
  const weekDenom = weekShows + weekNoShows + weekCancelled;
  const weekShowRate = weekDenom > 0 ? (computeShowRate(weekShows, weekNoShows, weekCancelled) * 100).toFixed(0) : "—";

  const message = `+1 CLOSE for ${closerMention}\n\n${statusLabel} ${typeLabel}: ${amountStr} from ${customerName || "Unknown"}\n\n*TOTAL closes this week: ${totalCloses}* | *New revenue: ${newRevStr}*\n*Show rate to date: ${weekShowRate}%* (${weekShows} showed, ${weekNoShows} no-show${weekCancelled > 0 ? `, ${weekCancelled} cancelled` : ""}${weekPend > 0 ? `, ${weekPend} pending` : ""})`;

  await sendSlackCloser(message);
}
