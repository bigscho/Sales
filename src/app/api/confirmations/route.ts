import { NextRequest, NextResponse } from "next/server";
import {
  buildT1Worklist,
  buildDayOfWorklist,
  readinessMetrics,
} from "@/lib/confirmations/worklist";
import { isLive } from "@/lib/sendblue";

export const dynamic = "force-dynamic";

// GET /api/confirmations?view=t1|dayof — the Confirmations page worklist.
export async function GET(request: NextRequest) {
  const view = request.nextUrl.searchParams.get("view") || "t1";
  const [rows, readiness] = await Promise.all([
    view === "dayof" ? buildDayOfWorklist() : buildT1Worklist(),
    readinessMetrics(14),
  ]);
  return NextResponse.json({ view, rows, readiness, live: isLive() });
}
