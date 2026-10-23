import { NextResponse } from "next/server";
import { buildDayOfWorklist } from "@/lib/confirmations/worklist";
import { sendConfirmation } from "@/lib/confirmations/send";
import { nudgeRep } from "@/lib/confirmations/nudge";
import { isLive } from "@/lib/sendblue";

export const dynamic = "force-dynamic";

const BASE_URL = process.env.VERCEL_URL
  ? `https://barn.grsfd.ai`
  : "http://localhost:3000";

// Day-of cron — the testimonial + invite reminder. Hourly so a send that
// landed outside quiet hours goes out at the next in-window hour. Mostly
// automated by design (less custom than T-1): sends to every pending demo
// today, with the std-vs-"again" variant chosen by the send log. Set
// CONFIRMATIONS_DAYOF_AUTO to "false" to fall back to rep-approved sending
// on the page (that kill switch is unchanged).
export async function POST() {
  const rows = await buildDayOfWorklist();
  const autoEnabled = process.env.CONFIRMATIONS_DAYOF_AUTO !== "false";

  const sendable = rows.filter((r) => r.sendable);
  const noGroup = rows.filter((r) => r.blockReason === "no_group");

  let sent = 0;
  let failed = 0;
  let again = 0;
  let deferred = 0;
  if (autoEnabled) {
    for (const row of sendable) {
      const res = await sendConfirmation(row, "day_of", { autoSent: true });
      if (res.status === "sent") {
        sent++;
        if (row.variant === "again") again++;
      } else if (res.status === "deferred") deferred++;
      else failed++;
    }
  }

  const lines = [
    `Day-of testimonials — ${rows.length} demos today.`,
    autoEnabled
      ? `Sent ${sent}${again ? ` (${again} "again" variant)` : ""}${failed ? `, ${failed} failed` : ""}${deferred ? `, ${deferred} deferred (quiet hours)` : ""}.`
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
    noGroup: noGroup.length,
    nudged,
    live: isLive(),
  });
}

export async function GET() {
  return POST();
}
