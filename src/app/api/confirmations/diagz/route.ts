import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SENDBLUE_LINE } from "@/lib/sendblue";
import { normalizePhone, etDayRange } from "@/lib/confirmations/worklist";

// TEMPORARY read-only diagnostic for the "everything is call-only" issue.
// Gated by a one-off token in the query string. DELETE after diagnosis.
const DIAG_TOKEN = "sb-diag-7f3a9c2e1b0d";

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("key") !== DIAG_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const out: Record<string, unknown> = {};
  const lineNorm = normalizePhone(SENDBLUE_LINE);
  out.env = {
    SENDBLUE_LINE_NUMBER_set: !!process.env.SENDBLUE_LINE_NUMBER,
    SENDBLUE_LINE_normalized: lineNorm,
    SENDBLUE_LIVE: process.env.SENDBLUE_LIVE || null,
    SENDBLUE_BASE_URL: process.env.SENDBLUE_BASE_URL || "(default)",
    keyId_set: !!process.env.SENDBLUE_API_KEY_ID,
    secret_set: !!process.env.SENDBLUE_API_SECRET,
  };

  // --- 1. Raw SendBlue message shape (see EXACT keys the API returns) ---
  try {
    const BASE = process.env.SENDBLUE_BASE_URL || "https://api.sendblue.co";
    const res = await fetch(`${BASE}/api/v2/messages?limit=100&order_direction=desc`, {
      headers: {
        "Content-Type": "application/json",
        "sb-api-key-id": process.env.SENDBLUE_API_KEY_ID || "",
        "sb-api-secret-key": process.env.SENDBLUE_API_SECRET || "",
      },
    });
    const data = await res.json().catch(() => null);
    const arr = Array.isArray(data) ? data : data?.messages || data?.data || [];
    out.sendblue_http_status = res.status;
    out.sendblue_top_level_type = Array.isArray(data) ? "array" : typeof data;
    out.sendblue_top_level_keys = Array.isArray(data) ? null : data ? Object.keys(data) : null;
    out.sendblue_message_count = Array.isArray(arr) ? arr.length : 0;
    // Full key set seen across messages, and a couple of redacted samples
    const keySet = new Set<string>();
    const withGroup = (arr as Record<string, unknown>[]).filter((m) => m && m.group_id);
    for (const m of arr as Record<string, unknown>[]) {
      if (m) Object.keys(m).forEach((k) => keySet.add(k));
    }
    out.sendblue_all_keys = Array.from(keySet);
    out.sendblue_group_message_count = withGroup.length;
    out.sendblue_group_samples = withGroup.slice(0, 4).map((m) => ({
      group_id: m.group_id,
      is_outbound: m.is_outbound,
      from_number: mask(m.from_number),
      number: mask(m.number),
      to_number: mask(m.to_number),
      participants_type: Array.isArray(m.participants)
        ? `array[${(m.participants as unknown[]).length}]`
        : typeof m.participants,
      participants: Array.isArray(m.participants)
        ? (m.participants as string[]).map(mask)
        : m.participants ?? null,
      group_display_name: (m as Record<string, unknown>).group_display_name ?? null,
      date_sent: m.date_sent,
    }));
    // If there's no participants field, show one full raw (redacted) message
    if (withGroup.length && !("participants" in (withGroup[0] as object))) {
      out.sendblue_raw_group_message_redacted = redactObj(withGroup[0]);
    }
  } catch (e) {
    out.sendblue_error = String(e);
  }

  // --- 1b. Raw feed: which booking phones appear in ANY raw message participants? ---
  // (answers "did a real prospect group get created on SendBlue at all")
  try {
    const BASE = process.env.SENDBLUE_BASE_URL || "https://api.sendblue.co";
    const res = await fetch(`${BASE}/api/v2/messages?limit=100&order_direction=desc`, {
      headers: {
        "Content-Type": "application/json",
        "sb-api-key-id": process.env.SENDBLUE_API_KEY_ID || "",
        "sb-api-secret-key": process.env.SENDBLUE_API_SECRET || "",
      },
    });
    const data = await res.json().catch(() => null);
    const arr: Record<string, unknown>[] = Array.isArray(data) ? data : data?.messages || data?.data || [];
    const rawGroupToNums = new Map<string, Set<string>>();
    for (const m of arr) {
      const gid = m.group_id as string | undefined;
      if (!gid) continue;
      const set = rawGroupToNums.get(gid) || new Set<string>();
      const nums = [
        ...(Array.isArray(m.participants) ? (m.participants as string[]) : []),
        m.from_number as string,
        m.number as string,
        m.to_number as string,
      ];
      for (const n of nums) {
        const nn = normalizePhone(n);
        if (nn) set.add(nn);
      }
      rawGroupToNums.set(gid, set);
    }
    const allRawNorms = new Set<string>();
    rawGroupToNums.forEach((s) => s.forEach((n) => allRawNorms.add(n)));
    out.raw_distinct_group_count = rawGroupToNums.size;
    out.raw_distinct_participant_norms = Array.from(allRawNorms).map((n) => `…${n.slice(-4)}`);
  } catch (e) {
    out.raw_scan_error = String(e);
  }

  // --- 1c. TRIGGER the real sync, then measure before/after ---
  const { syncGroupsFromApi } = await import("@/lib/confirmations/worklist");
  const beforeCount = await prisma.sendblueGroup.count();
  let syncError: string | null = null;
  try {
    await syncGroupsFromApi();
  } catch (e) {
    syncError = String(e);
  }
  const afterCount = await prisma.sendblueGroup.count();
  out.sync = { beforeCount, afterCount, created: afterCount - beforeCount, error: syncError };

  // --- 2. Stored SendblueGroup rows (AFTER the sync) ---
  const groups = await prisma.sendblueGroup.findMany({ orderBy: { createdAt: "desc" } });
  out.db_group_count = groups.length;
  out.db_groups = groups.map((g) => ({
    groupId: g.groupId,
    bookingId: g.bookingId,
    prospectPhone: mask(g.prospectPhone),
    prospectPhone_norm: normalizePhone(g.prospectPhone),
    participants: safeParse(g.participants).map(mask),
    participants_norm: safeParse(g.participants).map(normalizePhone),
    lastInboundAt: g.lastInboundAt,
  }));

  // --- 3. Today + tomorrow bookings and whether they match a group ---
  const groupNorms = groups.flatMap((g) => [
    normalizePhone(g.prospectPhone),
    ...safeParse(g.participants).map(normalizePhone),
  ]);
  for (const [label, offset] of [["today", 0], ["tomorrow", 1]] as const) {
    const { start, end } = etDayRange(offset);
    const bookings = await prisma.booking.findMany({
      where: { demoDate: { gte: start, lt: end }, supersededAt: null },
      select: { id: true, prospectName: true, prospectPhone: true, demoDate: true },
      orderBy: { demoDate: "asc" },
    });
    out[`bookings_${label}`] = bookings.map((b) => {
      const norm = normalizePhone(b.prospectPhone);
      return {
        name: b.prospectName,
        prospectPhone: mask(b.prospectPhone),
        prospectPhone_norm: norm,
        has_phone: !!b.prospectPhone,
        matches_a_group: !!norm && groupNorms.includes(norm),
      };
    });
  }

  // --- 4. Real worklist builders — the actual sendable/block/skip the page uses ---
  try {
    const { buildT1Worklist, buildDayOfWorklist } = await import("@/lib/confirmations/worklist");
    const [t1, dayof] = await Promise.all([buildT1Worklist(), buildDayOfWorklist()]);
    const summarize = (rows: Array<{ prospectName: string; sendable: boolean; blockReason: string | null; skipReason: string | null; sendStatus: string }>) => ({
      total: rows.length,
      sendable: rows.filter((r) => r.sendable).length,
      byBlock: rows.reduce((a, r) => { const k = r.blockReason || r.skipReason || (r.sendStatus !== "not_sent" ? r.sendStatus : "ok"); a[k] = (a[k] || 0) + 1; return a; }, {} as Record<string, number>),
      rows: rows.map((r) => ({ name: r.prospectName, sendable: r.sendable, block: r.blockReason, skip: r.skipReason, status: r.sendStatus })),
    });
    out.worklist_t1 = summarize(t1);
    out.worklist_dayof = summarize(dayof);
  } catch (e) {
    out.worklist_error = String(e);
  }

  return NextResponse.json(out, { status: 200 });
}

function mask(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  if (s.length <= 4) return s;
  return `…${s.slice(-4)}`;
}
function safeParse(s: string | null): string[] {
  if (!s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
function redactObj(o: unknown): unknown {
  if (typeof o === "string") return o.length > 6 ? `…${o.slice(-4)}` : o;
  if (Array.isArray(o)) return o.map(redactObj);
  if (o && typeof o === "object") {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) r[k] = redactObj(v);
    return r;
  }
  return o;
}
