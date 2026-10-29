// Shared send path for both touchpoints — every send (manual, batch, cron,
// dry-run) goes through here so the ConfirmationSend log is the single source
// of truth for dedup, variants, and the automation-readiness metrics.
//
// Order: quiet hours and opt-out (no claim), then an atomic claim, then the
// provider. SENDBLUE_LIVE remains the master kill switch: when it is not
// exactly "true", this logs a dry-run line and does not call Sendblue.
import { prisma } from "@/lib/db";
import { sendGroupMessage, isLive, type SendGroupOptions, type SendResult } from "@/lib/sendblue";
import type { WorklistRow, Touchpoint } from "./worklist";
import { checkSendWindow } from "./send-window";
import { internalGroupConfigFromEnv, pinnedInternalGroupIds } from "./internal-group";
import {
  bodyDedupeKeyFor,
  bodyHash,
  claimKeyFor,
  dayOfGroupDayKeyFor,
  dedupeWindowMs,
  etDayString,
  etDayWindow,
  hourBucket,
  maxSendsPerHour,
} from "./guards";
import { claimWithPrisma, logUnclaimed, markClaim, type ClaimInput, type ClaimResult, type ClaimRow } from "./claim";
import { isRecipientOptedOut } from "./opt-out";

/** Pinned id or SendblueGroup.internal — any configured coaching chat. */
async function targetIsInternalGroup(groupId: string): Promise<boolean> {
  const ids = pinnedInternalGroupIds(internalGroupConfigFromEnv().groups);
  if (ids.includes(groupId)) return true;
  const row = await prisma.sendblueGroup.findUnique({
    where: { groupId },
    select: { internal: true },
  });
  return row?.internal === true;
}

export interface SendOutcome {
  bookingId: string;
  status: "sent" | "failed" | "skipped" | "deferred";
  dryRun: boolean;
  error?: string;
  retryAt?: string; // deferred: next in-window hour (ISO)
}

export interface DeliverArgs {
  groupId: string;
  touchpoint: string;
  body: string;
  dryRun: boolean;
  mediaUrl?: string | null;
  pauseMs?: number;
}

export interface DeliverIo {
  sendGroup?: (opts: SendGroupOptions) => Promise<SendResult>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Overrides SENDBLUE_LIVE for tests. Production leaves this unset. */
  live?: boolean;
}

export interface SendDeps {
  /** Overrides the SENDBLUE_LIVE read. Production leaves this unset. */
  live?: boolean;
  rateLimit?: number;
  now?: Date;
  pauseMs?: number;
  db?: {
    optedOut(phone: string | null, groupId: string | null): Promise<boolean>;
    isInternalGroup(groupId: string): Promise<boolean>;
    claim(input: ClaimInput): Promise<ClaimResult>;
    mark(id: string, outcome: { status: "sent" | "failed"; dryRun: boolean; messageHandle?: string; error?: string }): Promise<void>;
    logUnclaimed(row: ClaimRow & { error: string }): Promise<void>;
  };
  deliver?: (args: DeliverArgs) => Promise<{ dryRun: boolean; messageHandle?: string }>;
  io?: DeliverIo;
}

const prismaDb: NonNullable<SendDeps["db"]> = {
  optedOut: (phone, groupId) => isRecipientOptedOut(phone, groupId),
  isInternalGroup: (groupId) => targetIsInternalGroup(groupId),
  claim: (input) => claimWithPrisma(input),
  mark: (id, outcome) => markClaim(id, outcome),
  logUnclaimed: (row) => logUnclaimed(row),
};

/**
 * Dry-run logs group id, touchpoint, and body hash, and does not call Sendblue.
 * The live branch also re-checks the kill switch so a stale `dryRun: false`
 * cannot text while SENDBLUE_LIVE is off.
 */
export async function deliverConfirmationMessage(
  args: DeliverArgs,
  io: DeliverIo = {}
): Promise<{ dryRun: boolean; messageHandle?: string }> {
  const log = io.log ?? ((line: string) => console.log(line));
  const hash = bodyHash(args.body);
  const live = io.live ?? isLive();
  if (args.dryRun || !live) {
    log(`confirmation dry-run groupId=${args.groupId} touchpoint=${args.touchpoint} bodyHash=${hash}`);
    return { dryRun: true, messageHandle: `dry_${hash.slice(0, 12)}` };
  }

  const sendGroup = io.sendGroup ?? sendGroupMessage;
  const sleep = io.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (args.touchpoint === "day_of" && args.mediaUrl) {
    await sendGroup({ groupId: args.groupId, content: "", mediaUrl: args.mediaUrl, live: true });
    await sleep(args.pauseMs ?? 4000);
  }
  const result = await sendGroup({ groupId: args.groupId, content: args.body, live: true });
  return { dryRun: false, messageHandle: result.messageHandle };
}

function baseRow(
  row: WorklistRow,
  touchpoint: Touchpoint,
  body: string,
  edited: boolean,
  dryRun: boolean,
  opts: { approvedBy?: string; autoSent?: boolean; reconnectId?: string | null }
): Omit<ClaimRow, "claimKey" | "dayOfGroupDayKey" | "bodyDedupeKey" | "bodyHash" | "etDay"> {
  return {
    bookingId: row.bookingId,
    prospectEmail: row.prospectEmail,
    prospectPhone: row.prospectPhone,
    touchpoint,
    variant: row.variant ?? null,
    addressSource: touchpoint === "t1" ? row.addressSource : null,
    body,
    groupId: row.groupId,
    error: null,
    edited,
    autoSent: opts.autoSent ?? false,
    approvedBy: opts.approvedBy || null,
    dryRun,
    reconnectId: opts.reconnectId ?? null,
  };
}

export async function sendConfirmation(
  row: WorklistRow,
  touchpoint: Touchpoint,
  // forceDryRun: touchpoint-level kill-switch layered on SENDBLUE_LIVE — lets a
  // new touchpoint (origination) log dry-run rows in a prod env that's already
  // live for t1/day-of.
  // reconnectId: ties the log row to a ReconnectSequence (reconnect touchpoints only).
  opts: { editedBody?: string; approvedBy?: string; autoSent?: boolean; forceDryRun?: boolean; reconnectId?: string } = {},
  deps: SendDeps = {}
): Promise<SendOutcome> {
  const body = opts.editedBody?.trim() || row.body;
  const edited = !!opts.editedBody && opts.editedBody.trim() !== row.body;
  const live = deps.live ?? isLive();
  const dryRun = opts.forceDryRun || !live;
  const db = deps.db ?? prismaDb;
  const now = deps.now ?? new Date();
  const deliver =
    deps.deliver ?? ((args: DeliverArgs) => deliverConfirmationMessage(args, { ...deps.io, live }));

  const skip = async (error: string): Promise<SendOutcome> => {
    const etDay = etDayString(now);
    const hash = bodyHash(body);
    await db.logUnclaimed({
      ...baseRow(row, touchpoint, body, edited, dryRun, opts),
      error,
      claimKey: null,
      dayOfGroupDayKey: null,
      bodyDedupeKey: null,
      bodyHash: hash,
      etDay,
    });
    return { bookingId: row.bookingId, status: "skipped", dryRun, error };
  };

  if (!row.groupId) return skip("no_group");

  // QUIET HOURS: t1 + day_of only. Nothing is logged, so the row stays
  // sendable and a later in-window attempt can still claim it.
  if (touchpoint === "t1" || touchpoint === "day_of") {
    const w = checkSendWindow(row.prospectTimezone, row.prospectPhone, now);
    if (!w.ok) {
      return {
        bookingId: row.bookingId,
        status: "deferred",
        dryRun,
        error: `quiet_hours:${w.tz}:${w.localHour}h${w.trusted ? "" : ":tz_untrusted"}`,
        retryAt: w.retryAt.toISOString(),
      };
    }
  }

  if (await db.isInternalGroup(row.groupId)) return skip("internal_group");
  if (await db.optedOut(row.prospectPhone, row.groupId)) return skip("opted_out");

  const etDay = etDayString(now);
  const window = etDayWindow(etDay);
  const hash = bodyHash(body);
  const reconnectId = opts.reconnectId ?? null;
  const claimKey = claimKeyFor({ bookingId: row.bookingId, reconnectId, touchpoint, dryRun });
  const claimedRow: ClaimRow = {
    ...baseRow(row, touchpoint, body, edited, dryRun, opts),
    claimKey,
    dayOfGroupDayKey: touchpoint === "day_of" ? dayOfGroupDayKeyFor(row.groupId, etDay, dryRun) : null,
    bodyDedupeKey: bodyDedupeKeyFor(row.groupId, hash, etDay, dryRun),
    bodyHash: hash,
    etDay,
  };
  const input: ClaimInput = {
    bookingId: row.bookingId,
    touchpoint,
    dryRun,
    reconnectId,
    groupId: row.groupId,
    bodyHash: hash,
    etDay,
    etDayStart: window.start,
    etDayEnd: window.end,
    hourBucket: hourBucket(now),
    rateLimit: deps.rateLimit ?? maxSendsPerHour(),
    windowStart: new Date(now.getTime() - dedupeWindowMs()),
    now,
    row: claimedRow,
  };

  const claimed = await db.claim(input);
  if (!claimed.ok) return skip(claimed.reason);

  const mediaUrl = touchpoint === "day_of" ? process.env.TESTIMONIAL_VIDEO_URL || null : null;
  try {
    const result = await deliver({
      groupId: row.groupId,
      touchpoint,
      body,
      dryRun,
      mediaUrl,
      pauseMs: deps.pauseMs,
    });
    try {
      await db.mark(claimed.id, {
        status: "sent",
        dryRun: result.dryRun,
        messageHandle: result.messageHandle,
      });
    } catch (markErr) {
      // The provider already accepted it (or the dry-run was recorded). Leave
      // the queued claim so a retry cannot send a second copy.
      console.error(`confirmation claim ${claimed.id} stayed queued after a successful deliver`, markErr);
    }
    return { bookingId: row.bookingId, status: "sent", dryRun: result.dryRun };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await db.mark(claimed.id, { status: "failed", dryRun, error: msg });
    } catch (markErr) {
      console.error(`confirmation claim ${claimed.id} stayed queued after a failed deliver`, markErr);
    }
    return { bookingId: row.bookingId, status: "failed", dryRun, error: msg };
  }
}
