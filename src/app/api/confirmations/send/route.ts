import { NextRequest, NextResponse } from "next/server";
import { buildT1Worklist, buildDayOfWorklist } from "@/lib/confirmations/worklist";
import { sendConfirmation, type SendOutcome } from "@/lib/confirmations/send";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/confirmations/send
// { touchpoint: "t1" | "day_of", items: [{ bookingId, body? }] }
// body present and different from the rendered default = rep edited it (tracked).
// Rows are re-derived server-side at send time — the client can't send to a
// booking that's no longer sendable (rescheduled/cancelled since page load).
export async function POST(request: NextRequest) {
  const session = await getSession();
  const payload = await request.json();
  const touchpoint: "t1" | "day_of" = payload.touchpoint === "day_of" ? "day_of" : "t1";
  const items: Array<{ bookingId: string; body?: string }> = payload.items || [];
  if (!items.length) {
    return NextResponse.json({ error: "No items" }, { status: 400 });
  }

  // Recompute the worklist NOW — suppression is checked at send time, not page load.
  const rows = touchpoint === "day_of" ? await buildDayOfWorklist() : await buildT1Worklist();
  const byId = new Map(rows.map((r) => [r.bookingId, r]));

  const results: SendOutcome[] = [];
  for (const item of items) {
    const row = byId.get(item.bookingId);
    if (!row) {
      results.push({ bookingId: item.bookingId, status: "skipped", dryRun: true, error: "not_in_worklist" });
      continue;
    }
    if (!row.sendable) {
      results.push({
        bookingId: item.bookingId,
        status: "skipped",
        dryRun: true,
        error: row.skipReason || row.blockReason || "not_sendable",
      });
      continue;
    }
    results.push(
      await sendConfirmation(row, touchpoint, {
        editedBody: item.body,
        approvedBy: session?.memberId,
        autoSent: false,
      })
    );
  }

  const sent = results.filter((r) => r.status === "sent").length;
  return NextResponse.json({ results, sent, total: items.length });
}
