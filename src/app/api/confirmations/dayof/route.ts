import { NextRequest, NextResponse } from "next/server";
import { buildDayOfWorklist } from "@/lib/confirmations/worklist";
import { sendConfirmation } from "@/lib/confirmations/send";
import { nudgeRep } from "@/lib/confirmations/nudge";
import { isLive } from "@/lib/sendblue";
import { authorizeScheduler, dayOfAutoEnabled } from "@/lib/confirmations/guards";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BASE_URL = process.env.VERCEL_URL
  ? `https://barn.grsfd.ai`
  : "http://localhost:3000";

// Day-of cron — the testimonial + invite reminder. Vercel Cron calls GET
// hourly (`0 * * * *` in vercel.json) and, when CRON_SECRET is set, sends
// `Authorization: Bearer $CRON_SECRET`. POST with the same header still
// runs this handler. A link preview does not send the header. Missing
// secret fails closed. authorizeScheduler is the same check the reconnect
// cron uses.
//
// Auto-send stays OFF unless CONFIRMATIONS_DAYOF_AUTO is exactly "true".
// SENDBLUE_LIVE remains the master kill switch inside sendConfirmation.
// Quiet hours, one text per demo, and cancelled / already-started skips
// stay in the worklist and sendConfirmation — this handler does not bypass them.
export async function POST(request: NextRequest) {
  const auth = authorizeScheduler(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const rows = await buildDayOfWorklist();
  const autoEnabled = dayOfAutoEnabled();

  const sendable = rows.filter((r) => r.sendable);
  const noGroup = rows.filter((r) => r.blockReason === "no_group");

  let sent = 0;
  let failed = 0;
  let again = 0;
  let deferred = 0;
  let skipped = 0;
  if (autoEnabled) {
    for (const row of sendable) {
      const res = await sendConfirmation(row, "day_of", { autoSent: true });
      if (res.status === "sent") {
        sent++;
        if (row.variant === "again") again++;
      } else if (res.status === "deferred") deferred++;
      else if (res.status === "skipped") skipped++;
      else failed++;
    }
  }

  const lines = [
    `Day-of testimonials — ${rows.length} demos today.`,
    autoEnabled
      ? `Sent ${sent}${again ? ` (${again} "again" variant)` : ""}${failed ? `, ${failed} failed` : ""}${deferred ? `, ${deferred} deferred (quiet hours)` : ""}${skipped ? `, ${skipped} skipped` : ""}.`
      : `Auto-send off — ${sendable.length} waiting on the page.`,
    noGroup.length ? `${noGroup.length} missing a group chat: ${noGroup.map((r) => r.prospectName).join(", ")}.` : null,
    !isLive() ? `DRY RUN mode — no real texts fire.` : null,
    `${BASE_URL}/confirmations`,
  ].filter(Boolean);
  // Cron runs hourly so deferred rows retry. Only nudge when something
  // happened, plus the one 12:00 UTC summary (the old once-a-day ping).
  const shouldNudge = sent > 0 || failed > 0 || new Date().getUTCHours() === 12;
  const nudged = shouldNudge ? await nudgeRep(lines.join("\n")) : "none";

  return NextResponse.json({
    total: rows.length,
    autoEnabled,
    sent,
    failed,
    deferred,
    skipped,
    noGroup: noGroup.length,
    nudged,
    live: isLive(),
  });
}

export async function GET(request: NextRequest) {
  return POST(request);
}
