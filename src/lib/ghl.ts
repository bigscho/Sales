import { prisma } from "./db";
import { sendSlackSetter } from "./slack";
import { formatMention } from "./setter-game";
import { refundCredits } from "./credits";

// === GHL API CONFIG ===

const GHL_BASE_URL = "https://services.leadconnectorhq.com";

const GHL_KEYS: Record<string, string | undefined> = {
  "1": process.env.GHL_API_KEY_1,
  "2": process.env.GHL_API_KEY_2,
};

const GHL_LOCATIONS: Record<string, string | undefined> = {
  "1": process.env.GHL_LOCATION_ID_1,
  "2": process.env.GHL_LOCATION_ID_2,
};

const GHL_WORKFLOWS: Record<string, string | undefined> = {
  "1": process.env.GHL_WORKFLOW_ID_1,
  "2": process.env.GHL_WORKFLOW_ID_2,
};

// Default warm-up schedule: days since first send → daily limit
const WARMUP_SCHEDULE = [
  { maxDays: 3, limit: 50 },
  { maxDays: 7, limit: 100 },
  { maxDays: 14, limit: 200 },
  { maxDays: 21, limit: 400 },
  { maxDays: 28, limit: 700 },
  { maxDays: Infinity, limit: 1000 },
];

// Delay between GHL API calls (ms)
const API_DELAY_MS = 150;

// === WARM-UP TRACKING ===

function todayDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function computeDefaultLimit(subAccountId: string): Promise<number> {
  // Find the first send date for this sub-account
  const firstTracker = await prisma.ghlWarmupTracker.findFirst({
    where: { subAccountId, sentCount: { gt: 0 } },
    orderBy: { date: "asc" },
  });

  if (!firstTracker) {
    // Never sent before — use first tier
    return WARMUP_SCHEDULE[0].limit;
  }

  const daysSinceFirst = Math.floor(
    (todayDate().getTime() - firstTracker.date.getTime()) / (1000 * 60 * 60 * 24)
  );

  for (const { maxDays, limit } of WARMUP_SCHEDULE) {
    if (daysSinceFirst <= maxDays) return limit;
  }
  return WARMUP_SCHEDULE[WARMUP_SCHEDULE.length - 1].limit;
}

/**
 * Get or create today's warm-up tracker for a sub-account.
 */
async function getOrCreateTracker(subAccountId: string): Promise<{ sentCount: number; dailyLimit: number }> {
  const date = todayDate();

  const existing = await prisma.ghlWarmupTracker.findUnique({
    where: { subAccountId_date: { subAccountId, date } },
  });

  if (existing) return { sentCount: existing.sentCount, dailyLimit: existing.dailyLimit };

  const dailyLimit = await computeDefaultLimit(subAccountId);
  const tracker = await prisma.ghlWarmupTracker.create({
    data: { subAccountId, date, sentCount: 0, dailyLimit },
  });

  return { sentCount: tracker.sentCount, dailyLimit: tracker.dailyLimit };
}

/**
 * Get available capacity across both sub-accounts.
 */
export async function getAvailableCapacity(): Promise<{
  total: number;
  accounts: Array<{ subAccountId: string; remaining: number; dailyLimit: number; sentCount: number }>;
}> {
  const accounts = [];
  for (const id of ["1", "2"]) {
    const tracker = await getOrCreateTracker(id);
    const remaining = Math.max(0, tracker.dailyLimit - tracker.sentCount);
    accounts.push({ subAccountId: id, remaining, dailyLimit: tracker.dailyLimit, sentCount: tracker.sentCount });
  }
  const total = accounts.reduce((sum, a) => sum + a.remaining, 0);
  return { total, accounts };
}

// === GHL API CLIENT ===

async function ghlFetch(subAccountId: string, path: string, options: RequestInit = {}): Promise<Response> {
  const apiKey = GHL_KEYS[subAccountId];
  if (!apiKey) throw new Error(`No GHL API key for sub-account ${subAccountId}`);

  const res = await fetch(`${GHL_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Version: "2021-07-28",
      ...(options.headers || {}),
    },
  });

  if (res.status === 429) {
    // Rate limited — wait and retry once
    await new Promise(r => setTimeout(r, 2000));
    return ghlFetch(subAccountId, path, options);
  }

  return res;
}

/**
 * Create a contact in a GHL sub-account.
 * Attribution is tracked in our OutboundPush table, not via GHL tags,
 * so contacts stay clean if re-blasted by a different setter later.
 */
export async function createGhlContact(
  subAccountId: string,
  agent: { firstName: string; lastName: string; email?: string | null; phone?: string | null }
): Promise<string> {
  const locationId = GHL_LOCATIONS[subAccountId];
  if (!locationId) throw new Error(`No GHL location ID for sub-account ${subAccountId}`);

  const body: Record<string, unknown> = {
    firstName: agent.firstName,
    lastName: agent.lastName,
    locationId,
  };
  if (agent.phone) body.phone = agent.phone;
  if (agent.email) body.email = agent.email;

  const res = await ghlFetch(subAccountId, "/contacts/", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL createContact failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.contact?.id || data.id;
}

/**
 * Add a contact to a GHL workflow (triggers the SMS sequence).
 */
export async function triggerGhlWorkflow(subAccountId: string, contactId: string): Promise<void> {
  const workflowId = GHL_WORKFLOWS[subAccountId];
  if (!workflowId) throw new Error(`GHL_WORKFLOW_ID_${subAccountId} not configured`);

  const res = await ghlFetch(subAccountId, `/contacts/${contactId}/workflow/${workflowId}`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL triggerWorkflow failed (${res.status}): ${text}`);
  }
}

// === BLAST PROCESSING ===

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a text blast: query matching agents, push to GHL, update records.
 */
export async function processBlast(blastId: string): Promise<void> {
  const blast = await prisma.textBlast.findUnique({
    where: { id: blastId },
    include: { setter: true },
  });
  if (!blast) throw new Error(`Blast ${blastId} not found`);
  if (blast.status === "completed" || blast.status === "failed") return;

  // Mark as processing
  await prisma.textBlast.update({
    where: { id: blastId },
    data: { status: "processing", startedAt: blast.startedAt || new Date() },
  });

  // Get or create campaign for this blast
  let campaign = blast.campaignId
    ? await prisma.outboundCampaign.findUnique({ where: { id: blast.campaignId } })
    : null;

  if (!campaign) {
    campaign = await prisma.outboundCampaign.create({
      data: {
        name: `SMS Blast — ${blast.setter.name} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
        channel: "ghl",
        externalId: GHL_WORKFLOWS["1"] || GHL_WORKFLOWS["2"],
        status: "active",
      },
    });
    await prisma.textBlast.update({
      where: { id: blastId },
      data: { campaignId: campaign.id },
    });
  }

  // Count already-pushed agents for this blast (for resume support)
  const alreadyPushed = await prisma.outboundPush.count({
    where: { blastId },
  });
  const remaining = blast.creditsSpent - alreadyPushed;
  if (remaining <= 0) {
    await prisma.textBlast.update({
      where: { id: blastId },
      data: { status: "completed", completedAt: new Date(), totalPushed: alreadyPushed },
    });
    return;
  }

  // Build agent filter — exclude already-pushed to ANY campaign (dedup)
  const agentFilter: Record<string, unknown> = {
    phone: { not: null },
    outboundPushes: { none: { campaignId: campaign.id } },
  };
  if (blast.filterState) agentFilter.state = { equals: blast.filterState, mode: "insensitive" };
  if (blast.filterCity) agentFilter.city = { contains: blast.filterCity, mode: "insensitive" };
  if (blast.filterMinProd) agentFilter.avgTransactions = { ...((agentFilter.avgTransactions as Record<string, unknown>) || {}), gte: blast.filterMinProd };
  if (blast.filterMaxProd) agentFilter.avgTransactions = { ...((agentFilter.avgTransactions as Record<string, unknown>) || {}), lte: blast.filterMaxProd };

  // Get agents, ordered by best production first
  const agents = await prisma.agent.findMany({
    where: agentFilter,
    orderBy: { avgTransactions: "desc" },
    take: remaining,
  });

  if (agents.length === 0) {
    // No matching agents — complete the blast
    await prisma.textBlast.update({
      where: { id: blastId },
      data: {
        status: alreadyPushed > 0 ? "completed" : "failed",
        completedAt: new Date(),
        totalPushed: alreadyPushed,
        errorMessage: alreadyPushed === 0 ? "No matching agents with phone numbers found" : undefined,
      },
    });
    // Refund if nothing was sent
    if (alreadyPushed === 0) {
      await refundCredits(blast.setterId, blast.creditsSpent, blastId);
    }
    return;
  }

  // Check available capacity
  const capacity = await getAvailableCapacity();
  if (capacity.total <= 0) {
    // No capacity today — leave as processing, will resume tomorrow
    await prisma.textBlast.update({
      where: { id: blastId },
      data: { errorMessage: "Daily warm-up limit reached — will resume tomorrow" },
    });
    return;
  }

  let pushed = 0;
  let failed = 0;

  // Alternate between sub-accounts
  const sortedAccounts = capacity.accounts
    .filter(a => a.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);

  let accountIdx = 0;

  for (const agent of agents) {
    // Check if any capacity remains
    const currentCapacity = await getAvailableCapacity();
    if (currentCapacity.total <= 0) break;

    // Pick sub-account with capacity
    const account = sortedAccounts[accountIdx % sortedAccounts.length];
    const tracker = await getOrCreateTracker(account.subAccountId);
    if (tracker.sentCount >= tracker.dailyLimit) {
      accountIdx++;
      // Try other account
      const otherIdx = (accountIdx) % sortedAccounts.length;
      const otherTracker = await getOrCreateTracker(sortedAccounts[otherIdx].subAccountId);
      if (otherTracker.sentCount >= otherTracker.dailyLimit) break; // Both exhausted
      account.subAccountId = sortedAccounts[otherIdx].subAccountId;
    }

    try {
      // Create contact in GHL
      const contactId = await createGhlContact(account.subAccountId, agent);

      // Trigger SMS workflow
      await triggerGhlWorkflow(account.subAccountId, contactId);

      // Record the push
      await prisma.outboundPush.create({
        data: {
          agentId: agent.id,
          campaignId: campaign.id,
          channel: "ghl",
          blastId,
          pushedBy: blast.setterId,
        },
      });

      // Update agent contact tracking
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          lastContactedAt: new Date(),
          lastContactedChannel: "ghl",
          contactCount: { increment: 1 },
        },
      });

      // Increment warm-up tracker
      await prisma.ghlWarmupTracker.update({
        where: { subAccountId_date: { subAccountId: account.subAccountId, date: todayDate() } },
        data: { sentCount: { increment: 1 } },
      });

      pushed++;
      accountIdx++;
    } catch (err) {
      failed++;
      console.error(`Failed to push agent ${agent.id} to GHL:`, err);
    }

    // Rate limit delay
    await sleep(API_DELAY_MS);
  }

  // Update blast totals
  const totalPushed = alreadyPushed + pushed;
  const totalFailed = blast.totalFailed + failed;
  const allDone = totalPushed + totalFailed >= blast.creditsSpent || agents.length < remaining;

  await prisma.textBlast.update({
    where: { id: blastId },
    data: {
      totalPushed,
      totalFailed,
      status: allDone ? (totalPushed > 0 ? "completed" : "failed") : "processing",
      completedAt: allDone ? new Date() : undefined,
      errorMessage: totalPushed === 0 && failed > 0 ? "All push attempts failed" : undefined,
    },
  });

  // Update campaign total
  await prisma.outboundCampaign.update({
    where: { id: campaign.id },
    data: { totalPushed: { increment: pushed } },
  });

  // Refund if complete failure
  if (allDone && totalPushed === 0) {
    await refundCredits(blast.setterId, blast.creditsSpent, blastId);
  }

  // Slack notification
  if (pushed > 0) {
    const mention = formatMention(blast.setter);
    const balance = await prisma.teamMember.findUnique({ where: { id: blast.setterId }, select: { creditBalance: true } });
    const zoneLabel = [blast.filterState, blast.filterCity].filter(Boolean).join(", ") || "all regions";
    const message = `📲 ${mention} just sent a text blast!\n*${pushed} agents* in ${zoneLabel} contacted via GHL.\nRemaining balance: *${balance?.creditBalance?.toLocaleString() || 0} credits*`;
    await sendSlackSetter(message);
  }
}
