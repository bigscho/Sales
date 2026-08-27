import { prisma } from "./db";
import { newBookingActivityWhere } from "./booking-activity";
import { sendSlackSetter } from "./slack";
import { formatMention } from "./setter-game";
import { computeShowRate } from "./utils";

// === CONFIGURABLE FORMULA CONSTANTS ===
// Tune these once GHL per-SMS cost is known

const CREDITS_PER_BOOKING = 30;

const SHOW_RATE_MULTIPLIERS = [
  { min: 0.70, multiplier: 2.0 },
  { min: 0.60, multiplier: 1.5 },
  { min: 0.50, multiplier: 1.2 },
  { min: 0.40, multiplier: 1.0 },
  { min: 0.00, multiplier: 0.7 },
];

const PIGEON_BONUS: Record<string, number> = {
  tuffest_pigeon: 100,
  tpd: 50,
  common_pigeon: 10,
  sad_pigeon: 0,
};

const VERIFICATION_BONUS = 50;

const STREAK_BONUSES = [
  { minWeeks: 4, bonus: 400 },
  { minWeeks: 2, bonus: 200 },
];

// === HELPERS ===

function getShowRateMultiplier(showRate: number): number {
  for (const { min, multiplier } of SHOW_RATE_MULTIPLIERS) {
    if (showRate >= min) return multiplier;
  }
  return 0.7;
}

/**
 * Atomically create a credit transaction and update the cached balance.
 * Returns the new balance.
 */
async function createCreditTx(params: {
  setterId: string;
  amount: number;
  type: string;
  description: string;
  weekId?: string;
  blastId?: string;
}): Promise<number> {
  const { setterId, amount, type, description, weekId, blastId } = params;

  const result = await prisma.$transaction(async (tx) => {
    // Update cached balance atomically
    const member = await tx.teamMember.update({
      where: { id: setterId },
      data: { creditBalance: { increment: amount } },
    });

    // Create ledger entry with the new running balance
    await tx.creditTransaction.create({
      data: {
        setterId,
        amount,
        balance: member.creditBalance,
        type,
        description,
        weekId: weekId || null,
        blastId: blastId || null,
      },
    });

    return member.creditBalance;
  });

  return result;
}

// === PUBLIC API ===

/**
 * Compute weekly credits for a setter (does not write to DB).
 */
export async function computeWeeklyCredits(setterId: string, weekId: string): Promise<{
  bookings: number;
  shows: number;
  noShows: number;
  cancelled: number;
  showRate: number;
  base: number;
  multiplier: number;
  weeklyCredits: number;
  pigeonBonus: number;
  streakBonus: number;
  total: number;
}> {
  // Get the week's date range
  const week = await prisma.week.findUnique({ where: { id: weekId } });
  if (!week) return { bookings: 0, shows: 0, noShows: 0, cancelled: 0, showRate: 0, base: 0, multiplier: 0, weeklyCredits: 0, pigeonBonus: 0, streakBonus: 0, total: 0 };

  // Count bookings credited during this week attributed to this setter
  const bookings = await prisma.booking.count({
    where: {
      setterId,
      ...newBookingActivityWhere({ gte: week.weekStart, lte: week.weekEnd }),
    },
  });

  // Get show stats for this setter's demos this week
  const demos = await prisma.demo.findMany({
    where: { weekId, booking: { setterId } },
  });
  const shows = demos.filter(d => d.status === "showed").length;
  const noShows = demos.filter(d => d.status === "no_show").length;
  const cancelled = demos.filter(d => d.status === "cancelled").length;
  const showRate = computeShowRate(shows, noShows, cancelled);

  // Base credits from bookings
  const base = bookings * CREDITS_PER_BOOKING;
  const multiplier = getShowRateMultiplier(showRate);
  const weeklyCredits = Math.floor(base * multiplier);

  // Pigeon bonus: sum of daily tier bonuses for this week
  const dailyScores = await prisma.setterDailyScore.findMany({
    where: {
      setterId,
      date: { gte: week.weekStart, lte: week.weekEnd },
    },
  });
  const pigeonBonus = dailyScores.reduce((sum, s) => sum + (PIGEON_BONUS[s.pigeonTier] || 0), 0);

  // Streak bonus
  const member = await prisma.teamMember.findUnique({ where: { id: setterId } });
  let streakBonus = 0;
  if (member) {
    for (const { minWeeks, bonus } of STREAK_BONUSES) {
      if (member.consecutive15PlusWeeks >= minWeeks) {
        streakBonus = bonus;
        break;
      }
    }
  }

  const total = weeklyCredits + pigeonBonus + streakBonus;

  return { bookings, shows, noShows, cancelled, showRate, base, multiplier, weeklyCredits, pigeonBonus, streakBonus, total };
}

/**
 * Award weekly credits to all active setters for a given week.
 * Idempotent: skips setters who already have a weekly_award for this weekId.
 */
export async function awardWeeklyCredits(weekId: string): Promise<{
  awards: Array<{ setterId: string; setterName: string; total: number; breakdown: string }>;
}> {
  const week = await prisma.week.findUnique({ where: { id: weekId } });
  if (!week) return { awards: [] };

  const setters = await prisma.teamMember.findMany({
    where: { role: "setter", isActive: true, excludeFromLeaderboard: { not: true } },
  });

  const awards: Array<{ setterId: string; setterName: string; total: number; breakdown: string }> = [];

  for (const setter of setters) {
    // Idempotency check
    const existing = await prisma.creditTransaction.findFirst({
      where: { setterId: setter.id, weekId, type: "weekly_award" },
    });
    if (existing) continue;

    const calc = await computeWeeklyCredits(setter.id, weekId);
    if (calc.total <= 0) continue;

    const showRatePct = (calc.showRate * 100).toFixed(0);
    const description = `Week of ${week.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${calc.bookings} bookings, ${showRatePct}% show rate`;
    const breakdown = `${calc.weeklyCredits} base (${calc.bookings}×${CREDITS_PER_BOOKING}×${calc.multiplier}x)${calc.pigeonBonus > 0 ? ` + ${calc.pigeonBonus} pigeon bonus` : ""}${calc.streakBonus > 0 ? ` + ${calc.streakBonus} streak bonus` : ""}`;

    await createCreditTx({
      setterId: setter.id,
      amount: calc.total,
      type: "weekly_award",
      description,
      weekId,
    });

    awards.push({ setterId: setter.id, setterName: setter.name, total: calc.total, breakdown });
  }

  // Slack notification
  if (awards.length > 0) {
    const lines = await Promise.all(awards.map(async (a) => {
      const setter = await prisma.teamMember.findUnique({ where: { id: a.setterId } });
      const mention = setter ? formatMention(setter) : a.setterName;
      return `${mention} — *${a.total.toLocaleString()} credits* (${a.breakdown})`;
    }));

    // Get updated balances
    const balances = await Promise.all(awards.map(async (a) => {
      const m = await prisma.teamMember.findUnique({ where: { id: a.setterId } });
      return `${a.setterName} ${m?.creditBalance?.toLocaleString() || 0}`;
    }));

    const message = `📲 *Weekly text blast credits are in!*\n\n${lines.join("\n")}\n\n_Balances: ${balances.join(" | ")}_`;
    await sendSlackSetter(message);
  }

  return { awards };
}

/**
 * Award verification bonus. Idempotent per setter + week.
 */
export async function awardVerificationBonus(setterId: string, weekId: string): Promise<number | null> {
  if (VERIFICATION_BONUS <= 0) return null;

  // Idempotency check
  const existing = await prisma.creditTransaction.findFirst({
    where: { setterId, weekId, type: "verification_bonus" },
  });
  if (existing) return null;

  const week = await prisma.week.findUnique({ where: { id: weekId } });
  const dateLabel = week ? week.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : weekId;

  const newBalance = await createCreditTx({
    setterId,
    amount: VERIFICATION_BONUS,
    type: "verification_bonus",
    description: `Verification completed for week of ${dateLabel}`,
    weekId,
  });

  return newBalance;
}

/**
 * Award pigeon tier bonus (called from tier crossing).
 */
export async function awardPigeonBonus(setterId: string, tierName: string): Promise<number | null> {
  const bonus = PIGEON_BONUS[tierName] || 0;
  if (bonus <= 0) return null;

  const tierLabels: Record<string, string> = {
    tuffest_pigeon: "Tuffest Pigeon",
    tpd: "Tuff Pigeon Doctor",
    common_pigeon: "Common Pigeon",
  };

  const newBalance = await createCreditTx({
    setterId,
    amount: bonus,
    type: "pigeon_bonus",
    description: `${tierLabels[tierName] || tierName} tier reached — +${bonus} credits`,
  });

  return newBalance;
}

/**
 * Spend credits for a text blast. Validates balance.
 * Returns new balance or throws if insufficient.
 */
export async function spendCredits(setterId: string, amount: number, blastId: string): Promise<number> {
  if (amount <= 0) throw new Error("Amount must be positive");

  // Atomic check-and-deduct using raw SQL to prevent race conditions
  const result = await prisma.$transaction(async (tx) => {
    const member = await tx.teamMember.findUnique({ where: { id: setterId } });
    if (!member || member.creditBalance < amount) {
      throw new Error(`Insufficient credits: have ${member?.creditBalance || 0}, need ${amount}`);
    }

    const updated = await tx.teamMember.update({
      where: { id: setterId },
      data: { creditBalance: { decrement: amount } },
    });

    await tx.creditTransaction.create({
      data: {
        setterId,
        amount: -amount,
        balance: updated.creditBalance,
        type: "blast_spend",
        description: `Text blast: ${amount} credits spent`,
        blastId,
      },
    });

    return updated.creditBalance;
  });

  return result;
}

/**
 * Refund credits for a failed blast.
 */
export async function refundCredits(setterId: string, amount: number, blastId: string): Promise<number> {
  const newBalance = await createCreditTx({
    setterId,
    amount,
    type: "refund",
    description: `Blast refund: ${amount} credits returned`,
    blastId,
  });
  return newBalance;
}

/**
 * Get a setter's cached credit balance.
 */
export async function getBalance(setterId: string): Promise<number> {
  const member = await prisma.teamMember.findUnique({
    where: { id: setterId },
    select: { creditBalance: true },
  });
  return member?.creditBalance || 0;
}

/**
 * Get paginated credit history for a setter.
 */
export async function getCreditHistory(setterId: string, page: number = 1, limit: number = 20): Promise<{
  transactions: Array<{
    id: string;
    amount: number;
    balance: number;
    type: string;
    description: string;
    createdAt: Date;
  }>;
  total: number;
}> {
  const [transactions, total] = await Promise.all([
    prisma.creditTransaction.findMany({
      where: { setterId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.creditTransaction.count({ where: { setterId } }),
  ]);

  return { transactions, total };
}
