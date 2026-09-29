// Reconnect-sequence processor cron — every 15 min (vercel.json). Computes due
// touches live from ReconnectSequence + ConfirmationSend; see
// src/lib/reconnect/process.ts for the full decision logic and safety gates.
import { NextResponse } from "next/server";
import { processReconnects, reconnectLive } from "@/lib/reconnect/process";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await processReconnects();
    return NextResponse.json({ ok: true, live: reconnectLive(), ...result });
  } catch (error) {
    console.error("reconnect process error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// Vercel cron hits GET
export async function GET() {
  return POST();
}
