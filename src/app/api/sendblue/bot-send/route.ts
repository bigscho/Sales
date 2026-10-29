import { NextRequest, NextResponse } from "next/server";
import { authenticateBot } from "@/lib/bot-send/auth";
import { sendBotMessage } from "@/lib/bot-send/send";
import { parseBotSendBody } from "@/lib/bot-send/validate";

export const dynamic = "force-dynamic";

// POST /api/sendblue/bot-send
// Authorization: Bearer <per-caller token>
// Bots text through this route instead of calling Sendblue themselves.
// GET is rejected so a link preview cannot send.
export async function POST(request: NextRequest) {
  const auth = authenticateBot(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid", reason: "invalid_body" }, { status: 400 });
  }
  const parsed = parseBotSendBody(payload);
  if (!parsed.ok) {
    return NextResponse.json({ error: "invalid", reason: parsed.reason }, { status: 400 });
  }

  const outcome = await sendBotMessage(auth.caller, parsed.value);
  return NextResponse.json(outcome);
}

export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
