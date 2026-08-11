import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// TEMPORARY read-only diagnostic: cross-reference day-of send log vs actual
// SendBlue media messages to detect day-of sends that got a TEXT but no VIDEO.
// DELETE after diagnosis.
const DIAG_TOKEN = "sb-diag-7f3a9c2e1b0d";

function norm(g: unknown): string {
  return String(g ?? "");
}

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
  for (let offset = 0; offset < 400; offset += 100) {
    const res = await fetch(`${BASE}/api/v2/messages?limit=100&offset=${offset}&order_direction=desc`, { headers });
    if (!res.ok) break;
    const data = await res.json().catch(() => null);
    const arr = Array.isArray(data) ? data : data?.messages || data?.data || [];
    all.push(...arr);
    if (!Array.isArray(arr) || arr.length < 100) break;
  }

  // Group -> list of media (video) messages with their send time & status
  const mediaByGroup = new Map<string, { t: string; status: string; service: string }[]>();
  for (const m of all) {
    if (m.is_outbound !== true) continue;
    if (!m.media_url || !norm(m.group_id)) continue;
    const g = norm(m.group_id);
    const list = mediaByGroup.get(g) || [];
    list.push({ t: norm(m.date_sent), status: norm(m.status), service: norm(m.service) });
    mediaByGroup.set(g, list);
  }

  // Our day-of send log (real sends only)
  const sends = await prisma.confirmationSend.findMany({
    where: { touchpoint: "day_of", status: "sent", dryRun: false },
    orderBy: { sentAt: "desc" },
    take: 40,
    select: { id: true, prospectName: true, groupId: true, sentAt: true, variant: true },
  });

  let withVideo = 0;
  let withoutVideo = 0;
  const rows = sends.map((s) => {
    const g = norm(s.groupId);
    const medias = mediaByGroup.get(g) || [];
    // a video counts as "present" if one was sent within 10 min of the text
    const sentMs = s.sentAt ? s.sentAt.getTime() : 0;
    const near = medias.filter((v) => {
      const vMs = Date.parse(v.t);
      return Number.isFinite(vMs) && Math.abs(vMs - sentMs) < 10 * 60 * 1000;
    });
    const hasVideo = near.length > 0;
    if (hasVideo) withVideo++; else withoutVideo++;
    return {
      name: s.prospectName,
      variant: s.variant,
      sentAt: s.sentAt,
      group: g ? `…${g.slice(-6)}` : null,
      video_present: hasVideo,
      video_status: near.map((v) => `${v.status}/${v.service || "?"}`),
      any_media_ever_to_group: medias.length,
    };
  });

  return NextResponse.json({
    env: {
      TESTIMONIAL_VIDEO_URL: process.env.TESTIMONIAL_VIDEO_URL || null,
      SENDBLUE_LIVE: process.env.SENDBLUE_LIVE || null,
    },
    scanned_messages: all.length,
    dayof_sends_examined: sends.length,
    dayof_with_video: withVideo,
    dayof_without_video: withoutVideo,
    rows,
  });
}
