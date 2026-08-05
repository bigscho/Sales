import { NextResponse } from "next/server";
import { buildDayOfWorklist } from "@/lib/confirmations/worklist";
import { sendConfirmation } from "@/lib/confirmations/send";
import { nudgeRep } from "@/lib/confirmations/nudge";
import { isLive } from "@/lib/sendblue";

export const dynamic = "force-dynamic";

const BASE_URL = process.env.VERCEL_URL
  ? `https://barn.grsfd.ai`
  : "http://localhost:3000";

// Day-of morning cron — the testimonial + invite reminder. Mostly automated by
// design (less custom than T-1): sends to every pending demo today, with the
// std-vs-"again" variant chosen by the send log. Set CONFIRMATIONS_DAYOF_AUTO
// to "false" to fall back to rep-approved sending on the page.
export async function POST() {
  const rows = await buildDayOfWorklist();
  const autoEnabled = process.env.CONFIRMATIONS_DAYOF_AUTO !== "false";

  const sendable = rows.filter((r) => r.sendable);
  const noGroup = rows.filter((r) => r.blockReason === "no_group");

  let sent = 0;
  let failed = 0;
  let again = 0;
  if (autoEnabled) {
    for (const row of sendable) {
      const res = await sendConfirmation(row, "day_of", { autoSent: true });
      if (res.status === "sent") {
        sent++;
        if (row.variant === "again") again++;
      } else failed++;
    }
  }

  const lines = [
    `Day-of testimonials — ${rows.length} demos today.`,
    autoEnabled
      ? `Sent ${sent}${again ? ` (${again} "again" variant)` : ""}${failed ? `, ${failed} failed` : ""}.`
      : `Auto-send off — ${sendable.length} waiting on the page.`,
    noGroup.length ? `${noGroup.length} missing a group chat: ${noGroup.map((r) => r.prospectName).join(", ")}.` : null,
    !isLive() ? `DRY RUN mode — no real texts fire.` : null,
    `${BASE_URL}/confirmations`,
  ].filter(Boolean);
  const nudged = await nudgeRep(lines.join("\n"));

  return NextResponse.json({
    total: rows.length,
    autoEnabled,
    sent,
    failed,
    noGroup: noGroup.length,
    nudged,
    live: isLive(),
  });
}

export async function GET() {
  return POST();
}
