import { NextRequest, NextResponse } from "next/server";
import { buildT1Worklist, readinessMetrics } from "@/lib/confirmations/worklist";
import { sendConfirmation } from "@/lib/confirmations/send";
import { nudgeRep } from "@/lib/confirmations/nudge";
import { isLive } from "@/lib/sendblue";
import { authorizeCron, t1AutoEnabled } from "@/lib/confirmations/guards";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BASE_URL = process.env.VERCEL_URL
  ? `https://barn.grsfd.ai`
  : "http://localhost:3000";

// T-1 afternoon cron. POST only, with `Authorization: Bearer $CRON_SECRET`.
// GET is rejected. Auto-send stays OFF unless CONFIRMATIONS_AUTO_SEND is
// exactly "true".
//
//  - Gate OFF (default): sends nothing to prospects — texts the worklist
//    summary to the rep (CONFIRMATIONS_REP_PHONE) so they open
//    /confirmations, QA, and send. If that phone is unset, the nudge is dropped.
//  - Gate ON (CONFIRMATIONS_AUTO_SEND=true, earned via the readiness metrics):
//    auto-sends the STAGED-SAFE subset only — single address, straight from
//    Calendly, unambiguous parse. Fallback/zip/multi rows stay gated for the
//    rep, and everything is still recorded in the send log.
//
// Vercel Cron invokes this path with GET, which now returns 405. Call POST
// with the bearer secret when the nudge (or auto-send) should run again.
export async function POST(request: NextRequest) {
  const auth = authorizeCron(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const rows = await buildT1Worklist();
  const autoEnabled = t1AutoEnabled();

  const sendableRows = rows.filter((r) => r.sendable);
  const autoSafe = sendableRows.filter(
    (r) => r.caseType === "single" && r.addressSource === "calendly" && !r.ambiguous
  );
  const needsRep = sendableRows.filter((r) => !autoSafe.includes(r));
  const noGroup = rows.filter((r) => r.blockReason === "no_group");
  const skipped = rows.filter((r) => r.skipReason);

  let autoSent = 0;
  let autoFailed = 0;
  let autoDeferred = 0;
  let autoSkipped = 0;
  if (autoEnabled) {
    for (const row of autoSafe) {
      const res = await sendConfirmation(row, "t1", { autoSent: true });
      if (res.status === "sent") autoSent++;
      else if (res.status === "deferred") autoDeferred++;
      else if (res.status === "skipped") autoSkipped++;
      else autoFailed++;
    }
  }

  // Nudge the show-rate rep from the SendBlue line
  const readiness = await readinessMetrics(14);
  const lines = [
    `T-1 confirmations ready — ${rows.length} demos tomorrow.`,
    autoEnabled
      ? `Auto-sent ${autoSent} single-address texts${autoFailed ? ` (${autoFailed} failed)` : ""}${autoDeferred ? ` (${autoDeferred} deferred, quiet hours)` : ""}${autoSkipped ? ` (${autoSkipped} skipped)` : ""}. ${needsRep.length} need your QA.`
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
    autoDeferred,
    autoSkipped,
    needsRep: needsRep.length,
    noGroup: noGroup.length,
    skipped: skipped.length,
    readiness,
    nudged,
    live: isLive(),
  });
}

export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
