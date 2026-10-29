// Reconnect-sequence processor cron — every 15 min (vercel.json). Computes due
// touches live from ReconnectSequence + ConfirmationSend; see
// src/lib/reconnect/process.ts for the full decision logic and safety gates.
//
// Vercel Cron calls GET and attaches `Authorization: Bearer $CRON_SECRET`
// when that env var is set. A link preview does not. Missing secret fails
// closed, so this route sends nothing until CRON_SECRET is configured.
// Texts still also require RECONNECT_LIVE and SENDBLUE_LIVE.
import { NextRequest, NextResponse } from "next/server";
import { authorizeScheduler } from "@/lib/confirmations/guards";
import { processReconnects, reconnectLive } from "@/lib/reconnect/process";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = authorizeScheduler(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const result = await processReconnects();
    return NextResponse.json({ ok: true, live: reconnectLive(), ...result });
  } catch (error) {
    console.error("reconnect process error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
