import { NextRequest, NextResponse } from "next/server";
import { authenticateBot } from "@/lib/bot-send/auth";
import { clampMessageLimit, recentMessages } from "@/lib/bot-send/messages";

export const dynamic = "force-dynamic";

// GET /api/sendblue/messages?limit=20
// Read-only proxy of recent Sendblue history. Does not send.
export async function GET(request: NextRequest) {
  const auth = authenticateBot(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const limit = clampMessageLimit(request.nextUrl.searchParams.get("limit"));
  try {
    const messages = await recentMessages(limit);
    return NextResponse.json({ messages });
  } catch (err) {
    console.error("bot message list failed", err instanceof Error ? err.name : "error");
    return NextResponse.json({ error: "sendblue_unavailable" }, { status: 503 });
  }
}

export async function POST() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
