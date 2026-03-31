import { prisma } from "./db";
import { sendSlackSetter } from "./slack";

// === PIGEON TIER DEFINITIONS ===
// GIF URLs use Google Drive thumbnail endpoint
const GIF_BASE = "https://drive.google.com/thumbnail?sz=w400&id=";

export const PIGEON_GIFS = {
  gay_pigeon: `${GIF_BASE}1qyRdod4YbVlp26mDJ8J4UG2Lxxk7rKHa`,
  sad_pigeon: `${GIF_BASE}1R-1-J3cTjt2woHoz5zTMDwFu5Jk90DbL`,
  lesbian_pigeon: `${GIF_BASE}17jGtFiHb2JQtonjRPwGBNlwidFB2mwBW`,
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
  { name: "tuffest_pigeon", label: "TUFFEST PIGEON", min: 12, points: 5, gif: PIGEON_GIFS.tuffest_pigeon },
  { name: "tpd", label: "TPD", min: 9, points: 2, gif: PIGEON_GIFS.tpd },
  { name: "lesbian_pigeon", label: "Lesbian Pigeon", min: 4, points: 1, gif: PIGEON_GIFS.lesbian_pigeon },
  { name: "sad_pigeon", label: "Sad Pigeon", min: 0, points: 0, gif: PIGEON_GIFS.sad_pigeon },
];

export const TIER_CROSSINGS = [4, 9, 12];

// === SLACK USER IDS ===
const SLACK_IDS: Record<string, string> = {
  "setter-ming": "U0A1CD7BU9W",
  "setter-luke": "U0APNBM43S7",
  "setter-logan": "U0APD917S2K",
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

  // Count bookings created today (ET) for this setter
  const count = await prisma.booking.count({
    where: {
      setterId,
      createdAt: { gte: start, lt: end },
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
    text = `${mention} just hit 4 demos booked today.\nLesbian Pigeon unlocked.\nDecent. Keep going.`;
  } else if (newCount === 9) {
    text = `${mention} — 9 demos booked today.\nThe doctor has entered the building.\nDon't stop here.`;
  } else if (newCount === 12) {
    text = `${mention} — 12 DEMOS TODAY.\nTUFFEST PIGEON STATUS.\nThe waiting room is full. The doctor is running back to back.\nEverybody else take notes.`;
  } else {
    text = `${mention} — ${newCount} demos booked today. ${tier.label} status.`;
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
    where: { role: "setter", isActive: true },
  });

  const results = [];
  for (const setter of setters) {
    const count = await prisma.booking.count({
      where: { setterId: setter.id, createdAt: { gte: start, lt: end } },
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
export async function getWeeklyShowStats(): Promise<{ totalShows: number; totalPending: number }> {
  // Get current week boundaries
  const { getWeekRange } = await import("./utils");
  const { start } = getWeekRange(new Date());
  const week = await prisma.week.findFirst({ where: { weekStart: start } });
  if (!week) return { totalShows: 0, totalPending: 0 };

  const demos = await prisma.demo.findMany({ where: { weekId: week.id } });
  const totalShows = demos.filter(d => d.status === "showed").length;
  const totalPending = demos.filter(d => d.status === "pending").length;
  return { totalShows, totalPending };
}

// Send show rate notification to #show-rate-tpds
export async function sendShowNotification(prospectName: string, setterId: string | null, closerName: string | null) {
  const { sendSlackShowRate } = await import("./slack");

  let setterMention = "Unknown setter";
  if (setterId) {
    const setter = await prisma.teamMember.findUnique({ where: { id: setterId } });
    if (setter) setterMention = formatSetterMention(setter);
  }

  const { totalShows } = await getWeeklyShowStats();
  const pipeline = await getPipelineCount();

  const message = `+1 SHOW on the board for ${setterMention}\n\n${prospectName} showed to their demo${closerName ? ` with ${closerName}` : ""}\n\n*TOTAL Shows for the week so far: ${totalShows}*\n*TOTAL Demos pending ahead: ${pipeline}*`;

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
    where: { weekId: week.id, status: "succeeded" },
  });

  const totalNewRevenue = payments
    .filter(p => (p.customerStatusOverride || p.customerStatus) === "new")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const totalReturningRevenue = payments
    .filter(p => (p.customerStatusOverride || p.customerStatus) === "returning")
    .reduce((sum, p) => sum + p.amountCents, 0);

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

  const message = `+1 CLOSE for ${closerMention}\n\n${statusLabel} ${typeLabel}: ${amountStr} from ${customerName || "Unknown"}\n\n*TOTAL closes this week: ${totalCloses}*\n*TOTAL new revenue this week: ${newRevStr}*`;

  await sendSlackCloser(message);
}
