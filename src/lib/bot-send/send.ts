// One send path for every bot. SENDBLUE_LIVE is the master kill switch.
// BOT_SEND_LIVE defaults off, so bots stay dry-run after confirmations go live.
// A caller cannot set either flag. Dry-run still claims, so a retry does not
// send a second copy in that lane.

import { isLive, sendGroupMessage, sendMessage } from "@/lib/sendblue";
import {
  dedupeWindowMs,
  etDayString,
  etDayWindow,
  hourBucket,
  maxSendsPerHour,
} from "@/lib/confirmations/guards";
import { isRecipientOptedOut } from "@/lib/confirmations/opt-out";
import { botSendLive, callerDisabled, callerHourlyCap, recipientDailyCap, type EnvLike } from "./auth";
import {
  internalCallerHourlyCap,
  internalGlobalHourlyCap,
  internalGroupDailyCap,
  isInternalGroupTarget,
  recipientAllowed,
} from "./scope";
import {
  claimBotWithPrisma,
  logBotSkip,
  markBotSend,
  type BotClaimInput,
  type BotClaimReason,
  type BotClaimResult,
} from "./claim";
import type { BotSendRequest } from "./validate";

export type BotOutcomeStatus = "sent" | "dry_run" | "skipped" | "failed";

export interface BotOutcome {
  status: BotOutcomeStatus;
  reason?: BotClaimReason | "opted_out" | "caller_disabled" | "out_of_scope" | "provider";
}

export interface BotDeliverArgs {
  channel: "direct" | "group";
  to: string | null;
  groupId: string | null;
  content: string;
  mediaUrl: string | null;
  dryRun: boolean;
}

export interface BotSendDeps {
  env?: EnvLike;
  now?: Date;
  /** Overrides the SENDBLUE_LIVE read. Production leaves this unset. */
  live?: boolean;
  /** Overrides the BOT_SEND_LIVE read. Production leaves this unset. */
  botLive?: boolean;
  db?: {
    optedOut(phone: string | null, groupId: string | null): Promise<boolean>;
    claim(input: BotClaimInput): Promise<BotClaimResult>;
    mark(
      id: string,
      outcome: { status: "sent" | "failed"; dryRun: boolean; reason?: string; messageHandle?: string; error?: string }
    ): Promise<void>;
    logSkip(input: BotClaimInput, reason: string): Promise<void>;
  };
  deliver?(args: BotDeliverArgs): Promise<{ dryRun: boolean; messageHandle?: string }>;
}

const prismaDb: NonNullable<BotSendDeps["db"]> = {
  optedOut: (phone, groupId) => isRecipientOptedOut(phone, groupId),
  claim: (input) => claimBotWithPrisma(input),
  mark: (id, outcome) => markBotSend(id, outcome),
  logSkip: (input, reason) => logBotSkip(input, reason),
};

export async function deliverBotMessage(args: BotDeliverArgs): Promise<{ dryRun: boolean; messageHandle?: string }> {
  if (args.dryRun || !isLive()) {
    return { dryRun: true, messageHandle: `dry_${args.channel}` };
  }
  if (args.channel === "group") {
    const result = await sendGroupMessage({
      groupId: args.groupId || undefined,
      content: args.content,
      mediaUrl: args.mediaUrl || undefined,
    });
    return { dryRun: result.dryRun, messageHandle: result.messageHandle };
  }
  const result = await sendMessage({
    number: args.to || "",
    content: args.content,
    mediaUrl: args.mediaUrl || undefined,
  });
  return { dryRun: result.dryRun, messageHandle: result.messageHandle };
}

function claimInput(caller: string, req: BotSendRequest, dryRun: boolean, now: Date, env: EnvLike): BotClaimInput {
  const etDay = etDayString(now);
  const window = etDayWindow(etDay);
  const lane = dryRun ? "dry" : "live";
  const hour = hourBucket(now);
  const internal = isInternalGroupTarget(req.groupId, env);
  return {
    caller,
    idempotencyKey: req.idempotencyKey,
    channel: req.channel,
    recipient: req.recipient,
    phone: req.phone,
    groupId: req.groupId,
    bodyHash: req.bodyHash,
    mediaUrl: req.mediaUrl,
    dryRun,
    claimKey: `bot:${caller}:${req.idempotencyKey}:${lane}`,
    bodyDedupeKey: `bot:${req.recipient}:${req.bodyHash}:${etDay}:${lane}`,
    etDay,
    etDayStart: window.start,
    etDayEnd: window.end,
    windowStart: new Date(now.getTime() - dedupeWindowMs(env)),
    // Internal groups use their own buckets so a coaching chat does not eat
    // the prospect hourly cap, and a prospect cap does not silence the coaches.
    hourBucket: internal ? `bot-internal:${hour}` : hour,
    callerBucket: internal ? `bot:${caller}:internal:${hour}` : `bot:${caller}:${hour}`,
    globalLimit: internal ? internalGlobalHourlyCap(env) : maxSendsPerHour(env),
    callerLimit: internal ? internalCallerHourlyCap(env) : callerHourlyCap(env),
    dailyLimit: internal ? internalGroupDailyCap(env) : recipientDailyCap(env),
  };
}

export async function sendBotMessage(caller: string, req: BotSendRequest, deps: BotSendDeps = {}): Promise<BotOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const db = deps.db ?? prismaDb;
  const masterLive = deps.live ?? isLive();
  const botsLive = deps.botLive ?? botSendLive(env);
  const dryRun = !(masterLive && botsLive);
  const input = claimInput(caller, req, dryRun, now, env);
  const deliver = deps.deliver ?? deliverBotMessage;

  const finish = (outcome: BotOutcome): BotOutcome => {
    console.log(
      `bot-send caller=${caller} recipient=${req.recipient} bodyHash=${req.bodyHash} status=${outcome.status}${outcome.reason ? ` reason=${outcome.reason}` : ""}`
    );
    return outcome;
  };

  const skip = async (reason: NonNullable<BotOutcome["reason"]>): Promise<BotOutcome> => {
    try {
      await db.logSkip(input, reason);
    } catch (err) {
      console.error("bot send skip log failed", err);
    }
    return finish({ status: "skipped", reason });
  };

  if (callerDisabled(caller, env)) return skip("caller_disabled");
  if (!recipientAllowed(caller, req, env)) return skip("out_of_scope");
  if (await db.optedOut(req.phone, req.groupId)) return skip("opted_out");

  const claimed = await db.claim(input);
  if (!claimed.ok) return skip(claimed.reason);

  if (await db.optedOut(req.phone, req.groupId)) {
    try {
      await db.mark(claimed.id, { status: "failed", dryRun, reason: "opted_out" });
    } catch (err) {
      console.error(`bot claim ${claimed.id} stayed queued after opt-out`, err);
    }
    return finish({ status: "skipped", reason: "opted_out" });
  }

  // Dry-run never touches the provider. The claim is already held in the dry lane.
  if (dryRun) {
    try {
      await db.mark(claimed.id, { status: "sent", dryRun: true, messageHandle: `dry_${req.bodyHash.slice(0, 12)}` });
    } catch (err) {
      console.error(`bot claim ${claimed.id} stayed queued after dry-run`, err);
    }
    return finish({ status: "dry_run" });
  }

  try {
    const result = await deliver({
      channel: req.channel,
      to: req.to,
      groupId: req.groupId,
      content: req.content,
      mediaUrl: req.mediaUrl,
      dryRun: false,
    });
    if (result.dryRun) {
      try {
        await db.mark(claimed.id, { status: "sent", dryRun: true, messageHandle: result.messageHandle });
      } catch (err) {
        console.error(`bot claim ${claimed.id} stayed queued after a provider dry-run`, err);
      }
      return finish({ status: "dry_run" });
    }
    try {
      await db.mark(claimed.id, { status: "sent", dryRun: false, messageHandle: result.messageHandle });
    } catch (err) {
      console.error(`bot claim ${claimed.id} stayed queued after deliver`, err);
    }
    return finish({ status: "sent" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await db.mark(claimed.id, { status: "failed", dryRun, reason: "provider", error: msg });
    } catch (markErr) {
      console.error(`bot claim ${claimed.id} stayed queued after a failed deliver`, markErr);
    }
    return finish({ status: "failed", reason: "provider" });
  }
}

export interface BotCallerSummary {
  caller: string;
  sent: number;
  dry_run: number;
  skipped: number;
  failed: number;
  queued: number;
}

export function summarizeBotSends(
  rows: Array<{ caller: string; status: string; dryRun: boolean }>
): BotCallerSummary[] {
  const byCaller = new Map<string, BotCallerSummary>();
  for (const row of rows) {
    const cur = byCaller.get(row.caller) ?? {
      caller: row.caller,
      sent: 0,
      dry_run: 0,
      skipped: 0,
      failed: 0,
      queued: 0,
    };
    if (row.status === "sent" && row.dryRun) cur.dry_run += 1;
    else if (row.status === "sent") cur.sent += 1;
    else if (row.status === "skipped") cur.skipped += 1;
    else if (row.status === "failed") cur.failed += 1;
    else if (row.status === "queued") cur.queued += 1;
    byCaller.set(row.caller, cur);
  }
  return [...byCaller.values()].sort((a, b) => a.caller.localeCompare(b.caller));
}
