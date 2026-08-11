// Shared send path for both touchpoints — every send (manual, batch, cron,
// dry-run) goes through here so the ConfirmationSend log is the single source
// of truth for dedup, variants, and the automation-readiness metrics.
import { prisma } from "@/lib/db";
import { sendGroupMessage, isLive } from "@/lib/sendblue";
import type { WorklistRow } from "./worklist";

/** Day-of testimonial video attachment. */
const TESTIMONIAL_URL = process.env.TESTIMONIAL_VIDEO_URL;

export interface SendOutcome {
  bookingId: string;
  status: "sent" | "failed" | "skipped";
  dryRun: boolean;
  error?: string;
}

export async function sendConfirmation(
  row: WorklistRow,
  touchpoint: "t1" | "day_of",
  opts: { editedBody?: string; approvedBy?: string; autoSent?: boolean } = {}
): Promise<SendOutcome> {
  const body = opts.editedBody?.trim() || row.body;
  const edited = !!opts.editedBody && opts.editedBody.trim() !== row.body;
  const dryRun = !isLive();

  if (!row.groupId) {
    await logSend(row, touchpoint, body, edited, opts, {
      status: "skipped",
      dryRun,
      error: "no_group",
    });
    return { bookingId: row.bookingId, status: "skipped", dryRun, error: "no_group" };
  }

  try {
    // Day-of goes as TWO messages: video first, text second — so the text (not
    // "1 Attachment") is what shows in the prospect's inbox preview.
    // SendBlue delivers the tiny text instantly but processes media async, so
    // without a head start the video can land AFTER the text (minutes late when
    // the file is large). The asset is now compressed (~2.4MB) so it processes
    // in seconds; a short pause here lets it lead. Best-effort, not guaranteed.
    if (touchpoint === "day_of" && TESTIMONIAL_URL) {
      await sendGroupMessage({ groupId: row.groupId, mediaUrl: TESTIMONIAL_URL, content: "" });
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    const result = await sendGroupMessage({
      groupId: row.groupId,
      content: body,
    });
    await logSend(row, touchpoint, body, edited, opts, {
      status: "sent",
      dryRun: result.dryRun,
      messageHandle: result.messageHandle,
    });
    return { bookingId: row.bookingId, status: "sent", dryRun: result.dryRun };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSend(row, touchpoint, body, edited, opts, {
      status: "failed",
      dryRun,
      error: msg,
    });
    return { bookingId: row.bookingId, status: "failed", dryRun, error: msg };
  }
}

async function logSend(
  row: WorklistRow,
  touchpoint: "t1" | "day_of",
  body: string,
  edited: boolean,
  opts: { approvedBy?: string; autoSent?: boolean },
  outcome: { status: string; dryRun: boolean; messageHandle?: string; error?: string }
) {
  await prisma.confirmationSend.create({
    data: {
      bookingId: row.bookingId,
      prospectEmail: row.prospectEmail,
      prospectPhone: row.prospectPhone,
      touchpoint,
      variant: row.variant || null,
      addressSource: touchpoint === "t1" ? row.addressSource : null,
      body,
      status: outcome.status,
      groupId: row.groupId,
      sendblueMessageId: outcome.messageHandle || null,
      error: outcome.error || null,
      edited,
      autoSent: opts.autoSent ?? false,
      approvedBy: opts.approvedBy || null,
      dryRun: outcome.dryRun,
      sentAt: outcome.status === "sent" ? new Date() : null,
    },
  });
}
