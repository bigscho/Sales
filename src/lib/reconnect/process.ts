// Reconnect-sequence processor — runs every 15 min via /api/reconnect/process.
// Touch state is computed LIVE from ReconnectSequence + the ConfirmationSend
// log (repo idiom: nothing pre-scheduled, so a cancelled/superseded sequence
// simply stops matching). Three touches per active sequence:
//   1. reconnect_recap_email  — bookedAt + 90min: GENERIC "great to chat" +
//      testimonials line (Colin killed the AI-written Fireflies recap
//      2026-09-29 — "it's just going to make it weird")
//   2. reconnect_t1_text      — day before the call, 12pm-10pm prospect-local,
//      into the prospect's EXISTING SendBlue group (no group -> skip + one-time
//      ops alert; the closer texts manually)
//   3. reconnect_t1_email     — same window as the text
// Booked <24h before the call -> touches 2+3 skipped. Emails come from the
// closer's own address (TeamMember.email) via Resend.
//
// SAFETY: RECONNECT_LIVE !== "true" -> full dry-run. Texts go through
// sendConfirmation with forceDryRun (layered on SENDBLUE_LIVE, same pattern as
// CONFIRMATIONS_ORIGINATION_LIVE); emails skip the Resend call but the FULL
// pipeline runs (Fireflies fetch + Claude rewrite) and the real rendered body
// is logged to ConfirmationSend for QA before flipping live.
import { prisma } from "@/lib/db";
import { sendConfirmation } from "@/lib/confirmations/send";
import {
  lookupGroup,
  syncGroupsFromApi,
  type Touchpoint,
  type WorklistRow,
} from "@/lib/confirmations/worklist";
import { prospectLocalHour } from "@/lib/confirmations/origination";
import { firstNameOf, formatDemoDay, formatDemoTime } from "@/lib/confirmations/copy";
import { sendEmail } from "@/lib/email";
import {
  RECAP_EMAIL_SUBJECT,
  T1_EMAIL_SUBJECT,
  renderRecapEmail,
  renderReconnectT1Email,
  renderReconnectT1Text,
} from "./copy";

export function reconnectLive(): boolean {
  return process.env.RECONNECT_LIVE === "true";
}

const RECAP_DELAY_MS = 90 * 60 * 1000; // email #1 fires ~1.5h after booking
const RECAP_MIN_LEAD_MS = 30 * 60 * 1000; // don't send <30min before the call
const RECAP_DEDUP_DAYS = 30; // one recap email per prospect per 30d across sequences
const T1_LOCAL_HOUR_MIN = 12; // T-1 touches fire noon-10pm prospect-local
const LOCAL_HOUR_MAX = 22;
const MAX_FAILURES = 3; // per touchpoint — then give up + ops alert

const seqInclude = {
  originalBooking: { include: { demo: { include: { closer: true } }, setter: true } },
  closer: true,
} as const;

function fetchActive(now: Date) {
  return prisma.reconnectSequence.findMany({
    where: { status: "active", callAt: { gt: now } },
    include: seqInclude,
    orderBy: { callAt: "asc" },
  });
}
type Seq = Awaited<ReturnType<typeof fetchActive>>[number];

export interface ProcessResult {
  active: number;
  sent: number;
  skipped: number;
  failed: number;
  waiting: number;
}

export async function processReconnects(): Promise<ProcessResult> {
  const now = new Date();
  // Housekeeping: the call happened — nothing sends after callAt.
  await prisma.reconnectSequence.updateMany({
    where: { status: "active", callAt: { lt: now } },
    data: { status: "completed" },
  });

  const seqs = await fetchActive(now);

  const result: ProcessResult = { active: seqs.length, sent: 0, skipped: 0, failed: 0, waiting: 0 };
  if (seqs.length === 0) return result;

  // Learn any new setter-created groups once per run (same as the worklists).
  await syncGroupsFromApi();

  for (const seq of seqs) {
    try {
      await processSequence(seq, now, result);
    } catch (err) {
      console.error(`reconnect ${seq.id} processing failed:`, err);
      result.failed++;
    }
  }
  return result;
}

async function processSequence(seq: Seq, now: Date, result: ProcessResult): Promise<void> {
  // === Touch 1: recap email (~1.5h after booking) ===
  if (!(await done(seq.id, "reconnect_recap_email"))) {
    await maybeSendRecapEmail(seq, now, result);
  }

  // === Touches 2+3: T-1 text + email ===
  const bookedWithin24h = seq.bookedAt.getTime() > seq.callAt.getTime() - 24 * 60 * 60 * 1000;
  if (bookedWithin24h) {
    // Not enough runway for "tomorrow" copy — log once per touchpoint and stop.
    for (const tp of ["reconnect_t1_text", "reconnect_t1_email"] as const) {
      if (!(await done(seq.id, tp))) {
        await logEmailRow(seq, tp, "", { status: "skipped", error: "booked_within_24h", dryRun: true });
        result.skipped++;
      }
    }
    return;
  }

  const isDayBefore = formatDemoDay(seq.callAt, seq.prospectTimezone) === "tomorrow";
  const localHour = prospectLocalHour(seq.prospectTimezone);
  if (!isDayBefore || localHour < T1_LOCAL_HOUR_MIN || localHour >= LOCAL_HOUR_MAX) {
    result.waiting++;
    return; // outside the send window — retry next tick
  }

  if (!(await done(seq.id, "reconnect_t1_text"))) {
    await maybeSendT1Text(seq, result);
  }
  if (!(await done(seq.id, "reconnect_t1_email"))) {
    await sendReconnectEmail(
      seq,
      "reconnect_t1_email",
      T1_EMAIL_SUBJECT,
      renderReconnectT1Email({
        firstName: firstNameOf(seq.prospectName),
        closerFirstName: closerFirstName(seq),
      }),
      null,
      result
    );
  }
}

// === Touch 1: recap email ===

async function maybeSendRecapEmail(seq: Seq, now: Date, result: ProcessResult): Promise<void> {
  const dueAt = seq.bookedAt.getTime() + RECAP_DELAY_MS;
  if (now.getTime() < dueAt) {
    result.waiting++;
    return;
  }
  if (seq.callAt.getTime() - now.getTime() < RECAP_MIN_LEAD_MS) {
    await logEmailRow(seq, "reconnect_recap_email", "", {
      status: "skipped",
      error: "too_close_to_call",
      dryRun: true,
    });
    result.skipped++;
    return;
  }
  // Cross-sequence dedup: a rebooked reconnect must not re-send the recap.
  // REAL sends only (dry runs during rollout don't mark the prospect).
  if (seq.prospectEmail) {
    const since = new Date(now.getTime() - RECAP_DEDUP_DAYS * 24 * 60 * 60 * 1000);
    const prior = await prisma.confirmationSend.findFirst({
      where: {
        touchpoint: "reconnect_recap_email",
        status: "sent",
        dryRun: false,
        prospectEmail: { equals: seq.prospectEmail, mode: "insensitive" },
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (prior) {
      await logEmailRow(seq, "reconnect_recap_email", "", {
        status: "skipped",
        error: "recently_recapped",
        dryRun: true,
      });
      result.skipped++;
      return;
    }
  }

  const body = renderRecapEmail({
    firstName: firstNameOf(seq.prospectName),
    closerFirstName: closerFirstName(seq),
  });
  await sendReconnectEmail(seq, "reconnect_recap_email", RECAP_EMAIL_SUBJECT, body, "generic", result);
}

// === Touch 2: T-1 text into the existing SendBlue group ===

async function maybeSendT1Text(seq: Seq, result: ProcessResult): Promise<void> {
  // Without a prior booking there's no FK home for the send log — texts are
  // off for this sequence (ops was alerted at creation); emails still go.
  if (!seq.originalBookingId) {
    console.error(`reconnect ${seq.id}: no originalBooking — T-1 text skipped (unlogged)`);
    result.skipped++;
    return;
  }
  const groupId = await lookupGroup(seq.originalBookingId, seq.prospectPhone);
  if (!groupId) {
    // Setter never made a group on the FIRST call (rare). Skip the text
    // permanently and tell ops once so the closer texts manually.
    await logEmailRow(seq, "reconnect_t1_text", renderReconnectT1Text(), {
      status: "skipped",
      error: "no_group",
      dryRun: true,
    });
    result.skipped++;
    if (!seq.opsAlertedAt) {
      await prisma.reconnectSequence.update({ where: { id: seq.id }, data: { opsAlertedAt: new Date() } });
      try {
        const { sendSlackShowRate } = await import("@/lib/slack");
        await sendSlackShowRate(
          `⚠️ Reconnect for ${seq.prospectName}: no SendBlue group — T-1 text skipped, ` +
            `${closerFirstName(seq)} should text manually. Emails still go out.`
        );
      } catch (err) {
        console.error("reconnect no_group Slack alert failed:", err);
      }
    }
    return;
  }

  const row = buildRow(seq, renderReconnectT1Text(), groupId);
  const outcome = await sendConfirmation(row, "reconnect_t1_text", {
    autoSent: true,
    forceDryRun: !reconnectLive(),
    reconnectId: seq.id,
  });
  if (outcome.status === "sent") {
    result.sent++;
    if (!outcome.dryRun) await notifyTouchSent(seq, "T-1 text");
  } else if (outcome.status === "failed") result.failed++;
  else result.skipped++;
}

/**
 * EMAIL the closers whenever a reconnect touch REALLY goes out (Colin,
 * 2026-09-29: notify by email, not #closer-tpds — "Email us"). Goes to every
 * active closer's TeamMember.email. Real sends only — dry-runs and skips stay
 * quiet. Best-effort; a failed ping never blocks the sequence.
 */
async function notifyTouchSent(seq: Seq, label: string): Promise<void> {
  try {
    const closers = await prisma.teamMember.findMany({
      where: { role: "closer", isActive: true, email: { not: null } },
      select: { email: true },
    });
    const to = closers.map((c) => c.email!).filter(Boolean);
    if (to.length === 0) return;
    await sendEmail({
      from: "Grassfed Reconnect <notifications@grsfd.ai>",
      to,
      subject: `Reconnect ${label} sent — ${seq.prospectName}`,
      text: `${label} just went out to ${seq.prospectName}${seq.prospectEmail ? ` <${seq.prospectEmail}>` : ""} (${closerFirstName(seq)}'s sequence).`,
    });
  } catch (err) {
    console.error("reconnect touch-sent email ping failed:", err);
  }
}

// === Email send + logging ===

async function sendReconnectEmail(
  seq: Seq,
  touchpoint: Touchpoint,
  subject: string,
  body: string,
  variant: string | null,
  result: ProcessResult
): Promise<void> {
  if (!seq.prospectEmail) {
    await logEmailRow(seq, touchpoint, body, { status: "skipped", error: "no_email", dryRun: true, variant });
    result.skipped++;
    return;
  }
  // Give up after repeated failures (Resend outage, bad address) — one ops ping.
  const failures = await prisma.confirmationSend.count({
    where: { reconnectId: seq.id, touchpoint, status: "failed" },
  });
  if (failures >= MAX_FAILURES) {
    await logEmailRow(seq, touchpoint, body, { status: "skipped", error: "retry_cap_exceeded", dryRun: true, variant });
    result.skipped++;
    try {
      const { sendSlackShowRate } = await import("@/lib/slack");
      await sendSlackShowRate(`⚠️ Reconnect ${touchpoint} for ${seq.prospectName} gave up after ${MAX_FAILURES} failures.`);
    } catch {
      /* alert best-effort */
    }
    return;
  }

  const closer = seq.closer || seq.originalBooking?.demo?.closer || null;
  const closerEmail = closer?.email || process.env.RECONNECT_FROM_FALLBACK || "colin@grsfd.co";
  // grsfd.ai is the Resend-verified sending domain (grsfd.co is NOT — verified
  // empirically 2026-09-29); replies still land in the closer's real @grsfd.co
  // inbox via reply_to.
  const fromEmail = closerEmail.replace(/@grsfd\.co$/i, "@grsfd.ai");
  const from = `${firstNameOf(closer?.name || "Colin")} <${fromEmail}>`;
  const live = reconnectLive();

  try {
    let resendId: string | null = null;
    if (live) {
      const sent = await sendEmail({ from, to: seq.prospectEmail, subject, text: body, replyTo: closerEmail });
      resendId = sent.id;
    }
    // Dry-run rows carry the REAL rendered body so it can be QA'd straight
    // from the DB before RECONNECT_LIVE is flipped.
    await logEmailRow(seq, touchpoint, `Subject: ${subject}\nFrom: ${from}\nReply-To: ${closerEmail}\n\n${body}`, {
      status: "sent",
      dryRun: !live,
      variant,
      messageId: resendId,
    });
    result.sent++;
    if (live) {
      const label = touchpoint === "reconnect_recap_email" ? `"${subject}" email` : "T-1 email";
      await notifyTouchSent(seq, label);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEmailRow(seq, touchpoint, body, { status: "failed", error: msg, dryRun: !live, variant });
    result.failed++;
  }
}

/**
 * "Has this touch already happened for this sequence." Terminal skips always
 * count. A dry-run "sent" counts only while the system is STILL in dry-run
 * mode (stops the 15-min loop re-running Claude/logging forever) — once
 * RECONNECT_LIVE flips, dry-run rows stop counting and the touch fires for
 * real: prospects booked before go-live never actually received anything.
 * Failed rows never count; they retry next tick up to MAX_FAILURES.
 */
async function done(reconnectId: string, touchpoint: Touchpoint): Promise<boolean> {
  const hit = await prisma.confirmationSend.findFirst({
    where: {
      reconnectId,
      touchpoint,
      OR: [
        { status: "skipped" },
        { status: "sent", ...(reconnectLive() ? { dryRun: false } : {}) },
      ],
    },
    select: { id: true },
  });
  return !!hit;
}

async function logEmailRow(
  seq: Seq,
  touchpoint: Touchpoint,
  body: string,
  outcome: { status: string; dryRun: boolean; error?: string; variant?: string | null; messageId?: string | null }
): Promise<void> {
  // ConfirmationSend.bookingId is a required FK — without a prior booking the
  // append-only log can't hold the row; console + the sequence row are the
  // only record (deliberate: never relax the FK).
  if (!seq.originalBookingId) {
    console.error(
      `reconnect ${seq.id} ${touchpoint} ${outcome.status}${outcome.error ? ` (${outcome.error})` : ""} — no originalBooking, not logged`
    );
    return;
  }
  await prisma.confirmationSend.create({
    data: {
      bookingId: seq.originalBookingId,
      reconnectId: seq.id,
      prospectEmail: seq.prospectEmail,
      prospectPhone: seq.prospectPhone,
      touchpoint,
      variant: outcome.variant || null,
      body,
      status: outcome.status,
      sendblueMessageId: outcome.messageId || null,
      error: outcome.error || null,
      autoSent: true,
      dryRun: outcome.dryRun,
      sentAt: outcome.status === "sent" ? new Date() : null,
    },
  });
}

// === Helpers ===

function closerFirstName(seq: Seq): string {
  const closer = seq.closer || seq.originalBooking?.demo?.closer || null;
  return firstNameOf(closer?.name || "Colin");
}

/** Synthetic WorklistRow so text sends ride the shared sendConfirmation path. */
function buildRow(seq: Seq, body: string, groupId: string): WorklistRow {
  return {
    bookingId: seq.originalBookingId || "reconnect_no_booking",
    prospectName: seq.prospectName,
    prospectFirstName: firstNameOf(seq.prospectName),
    inviteStatus: null,
    prospectPhone: seq.prospectPhone,
    prospectEmail: seq.prospectEmail,
    demoDate: seq.callAt.toISOString(),
    demoTimeLabel: formatDemoTime(seq.callAt, seq.prospectTimezone),
    closerName: seq.closer?.name || seq.originalBooking?.demo?.closer?.name || null,
    setterName: seq.originalBooking?.setter?.name || null,
    caseType: "area",
    addressVariable: null,
    addressSource: "none",
    ambiguous: false,
    emailCount: null,
    body,
    groupId,
    sendable: true,
    skipReason: null,
    blockReason: null,
    sendStatus: "not_sent",
    sentDryRun: false,
    sentAt: null,
  };
}
