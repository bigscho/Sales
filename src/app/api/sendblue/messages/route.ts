import { NextRequest, NextResponse } from "next/server";
import { authenticateBot } from "@/lib/bot-send/auth";
import { clampMessageLimit, recentMessages } from "@/lib/bot-send/messages";
import { groupsVisibleToCaller } from "@/lib/bot-send/scope";

export const dynamic = "force-dynamic";

// GET /api/sendblue/messages?limit=20&groupId=...
// Read-only proxy of recent Sendblue history. Does not send.
// groupId limits the page to that chat. The caller only sees groups they may text.
export async function GET(request: NextRequest) {
  const auth = authenticateBot(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const allowed = groupsVisibleToCaller(auth.caller, process.env);
  if (!allowed) {
    return NextResponse.json({ error: "out_of_scope" }, { status: 403 });
  }
  const requested = request.nextUrl.searchParams.get("groupId")?.trim() || "";
  if (requested && !allowed.has(requested)) {
    return NextResponse.json({ error: "out_of_scope" }, { status: 403 });
  }
  if (allowed.size === 0) {
    return NextResponse.json({ messages: [] });
  }
  const limit = clampMessageLimit(request.nextUrl.searchParams.get("limit"));
  try {
    const messages = await recentMessages(limit, undefined, {
      allowed,
      groupId: requested || null,
    });
    return NextResponse.json({ messages });
  } catch (err) {
    console.error("bot message list failed", err instanceof Error ? err.name : "error");
    return NextResponse.json({ error: "sendblue_unavailable" }, { status: 503 });
  }
}

export async function POST() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
