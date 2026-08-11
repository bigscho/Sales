import { NextRequest, NextResponse } from "next/server";

// TEMPORARY read-only diagnostic: why do day-of testimonial VIDEOS only send
// sometimes? Pull recent OUTBOUND messages and classify media vs text by
// delivery status / service / downgrade / error. DELETE after diagnosis.
const DIAG_TOKEN = "sb-diag-7f3a9c2e1b0d";

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("key") !== DIAG_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const BASE = process.env.SENDBLUE_BASE_URL || "https://api.sendblue.co";
  const headers = {
    "Content-Type": "application/json",
    "sb-api-key-id": process.env.SENDBLUE_API_KEY_ID || "",
    "sb-api-secret-key": process.env.SENDBLUE_API_SECRET || "",
  };

  const all: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const res = await fetch(`${BASE}/api/v2/messages?limit=100&offset=${offset}&order_direction=desc`, { headers });
    if (!res.ok) break;
    const data = await res.json().catch(() => null);
    const arr = Array.isArray(data) ? data : data?.messages || data?.data || [];
    all.push(...arr);
    if (!Array.isArray(arr) || arr.length < 100) break;
  }

  const outbound = all.filter((m) => m.is_outbound === true);
  const media = outbound.filter((m) => m.media_url && String(m.media_url).length > 0);
  const text = outbound.filter((m) => !m.media_url || String(m.media_url).length === 0);

  const tally = (rows: Record<string, unknown>[], key: string) => {
    const acc: Record<string, number> = {};
    for (const r of rows) { const k = String(r[key] ?? "null"); acc[k] = (acc[k] || 0) + 1; }
    return acc;
  };

  const brief = (m: Record<string, unknown>) => ({
    date: m.date_sent,
    group: m.group_id ? `…${String(m.group_id).slice(-6)}` : null,
    status: m.status,
    service: m.service,
    downgraded: m.was_downgraded,
    media: m.media_url ? `${String(m.media_url).split("/").pop()}` : null,
    error_code: m.error_code ?? null,
    error_message: m.error_message ?? null,
    error_reason: m.error_reason ?? null,
    error_detail: m.error_detail ?? null,
  });

  return NextResponse.json({
    env: {
      TESTIMONIAL_VIDEO_URL: process.env.TESTIMONIAL_VIDEO_URL || null,
      SENDBLUE_LIVE: process.env.SENDBLUE_LIVE || null,
    },
    counts: {
      scanned: all.length,
      outbound: outbound.length,
      media_messages: media.length,
      text_messages: text.length,
    },
    media_status_tally: tally(media, "status"),
    media_service_tally: tally(media, "service"),
    media_downgraded_tally: tally(media, "was_downgraded"),
    text_status_tally: tally(text, "status"),
    media_samples: media.slice(0, 25).map(brief),
    // Today's outbound in chronological order — see video/text pairing per group
    today_timeline: outbound
      .filter((m) => String(m.date_sent || "").startsWith("2026-08-11"))
      .sort((a, b) => String(a.date_sent).localeCompare(String(b.date_sent)))
      .map((m) => ({
        t: String(m.date_sent).slice(11, 23),
        group: m.group_id ? `…${String(m.group_id).slice(-6)}` : null,
        type: m.media_url ? "VIDEO" : "text",
        status: m.status,
        service: m.service,
      })),
  });
}
