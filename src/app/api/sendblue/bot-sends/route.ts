import { NextRequest, NextResponse } from "next/server";
import { authenticateBot } from "@/lib/bot-send/auth";
import { botSendSummary } from "@/lib/bot-send/summary";

export const dynamic = "force-dynamic";

// GET /api/sendblue/bot-sends — counts per caller for the last 24 hours.
// Same bearer token as the send route. Does not send.
export async function GET(request: NextRequest) {
  const auth = authenticateBot(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const summary = await botSendSummary();
  return NextResponse.json(summary);
}

export async function POST() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
