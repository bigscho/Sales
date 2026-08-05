import { NextResponse } from "next/server";
import { buildT1Worklist, readinessMetrics } from "@/lib/confirmations/worklist";
import { sendConfirmation } from "@/lib/confirmations/send";
import { nudgeRep } from "@/lib/confirmations/nudge";
import { isLive } from "@/lib/sendblue";

export const dynamic = "force-dynamic";

const BASE_URL = process.env.VERCEL_URL
  ? `https://barn.grsfd.ai`
  : "http://localhost:3000";

// T-1 afternoon cron. Two modes:
//  - Gate ON (default): sends nothing — posts the worklist summary to
//    #show-rate-tpds so the rep opens /confirmations, QAs, and sends.
//  - Gate OFF (CONFIRMATIONS_AUTO_SEND=true, earned via the readiness metrics):
//    auto-sends the STAGED-SAFE subset only — single address, straight from
//    Calendly, unambiguous parse. Fallback/zip/multi rows stay gated for the
//    rep, and everything is still recorded in the send log.
export async function POST() {
  const rows = await buildT1Worklist();
  const autoEnabled = process.env.CONFIRMATIONS_AUTO_SEND === "true";

  const sendableRows = rows.filter((r) => r.sendable);
  const autoSafe = sendableRows.filter(
    (r) => r.caseType === "single" && r.addressSource === "calendly" && !r.ambiguous
  );
  const needsRep = sendableRows.filter((r) => !autoSafe.includes(r));
  const noGroup = rows.filter((r) => r.blockReason === "no_group");
  const skipped = rows.filter((r) => r.skipReason);

  let autoSent = 0;
  let autoFailed = 0;
  if (autoEnabled) {
    for (const row of autoSafe) {
      const res = await sendConfirmation(row, "t1", { autoSent: true });
      if (res.status === "sent") autoSent++;
      else autoFailed++;
    }
  }

  // Nudge the show-rate rep from the SendBlue line (Slack fallback)
  const readiness = await readinessMetrics(14);
  const lines = [
    `T-1 confirmations ready — ${rows.length} demos tomorrow.`,
    autoEnabled
      ? `Auto-sent ${autoSent} single-address texts${autoFailed ? ` (${autoFailed} failed)` : ""}. ${needsRep.length} need your QA.`
      : `${sendableRows.length} texts to QA + send.`,
    noGroup.length ? `${noGroup.length} missing a group chat (call-only until created): ${noGroup.map((r) => r.prospectName).join(", ")}.` : null,
    skipped.length ? `${skipped.length} skipped (already contacted / rescheduled / cancelled).` : null,
    !isLive() ? `DRY RUN mode — no real texts fire.` : null,
    `${BASE_URL}/confirmations`,
  ].filter(Boolean);
  const nudged = await nudgeRep(lines.join("\n"));

  return NextResponse.json({
    total: rows.length,
    sendable: sendableRows.length,
    autoEnabled,
    autoSent,
    autoFailed,
    needsRep: needsRep.length,
    noGroup: noGroup.length,
    skipped: skipped.length,
    readiness,
    nudged,
    live: isLive(),
  });
}

export async function GET() {
  return POST();
}
