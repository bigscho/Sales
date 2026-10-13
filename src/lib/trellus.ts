import { prisma } from "./db";

// Trellus dialer sync — pulls each ET day's call sessions from the Trellus RPT
// API and rolls them up into SetterDialDay rows (dials / conversations / time
// spent dialing) keyed by TeamMember.trellusUserId.
//
// API notes (verified 2026-10-13):
// - POST https://rpt-2.trellus.ai/session-list-v6, Authorization: Bearer key.
// - Sessions carry `started_at` (epoch SECONDS) and belong to `resource_id`
//   (= Trellus user). Page cap is 1000 rows and there is no cursor, so a day
//   is pulled in 3 time windows; any window that comes back exactly full is
//   bisected and refetched so volume spikes can never silently truncate.
// - The API 429s after ~5 rapid calls — requests are paced and retried.

const SESSION_LIST_URL = "https://rpt-2.trellus.ai/session-list-v6";
const PAGE_LIMIT = 1000;
const BASE_WINDOWS = 3;
const MAX_BISECT_DEPTH = 4; // 3 windows * 2^4 = 48 windows ≈ 20k dials/day ceiling
const PACE_MS = 1500;
const CONVERSATION_MIN_SECONDS = 30;
const COVERAGE_SLOT_SECONDS = 300; // 5-min slots; each active slot = 5 min of dialing time

type SessionRow = [string, number, number | null, boolean | null];
// select order: resource_id, started_at, dial_metric.live_duration, sales_metric.has_prospect
const SESSION_SELECT = [
  "resource_id",
  "started_at",
  "dial_metric.live_duration",
  "sales_metric.has_prospect",
];

export interface DialDayTotals {
  dials: number;
  conversations: number;
  dialMinutes: number;
}

export interface TrellusSyncResult {
  date: string; // ET day, YYYY-MM-DD
  sessions: number;
  setters: Record<string, DialDayTotals>; // keyed by TeamMember name
  unmappedResourceIds: Record<string, number>; // resource_id -> dials seen
  apiCalls: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWindow(
  apiKey: string,
  startUs: number,
  endUs: number,
  counter: { calls: number },
): Promise<SessionRow[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    counter.calls++;
    const res = await fetch(SESSION_LIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start: startUs,
        end: endUs,
        limit: PAGE_LIMIT,
        cnf: [],
        select: SESSION_SELECT,
      }),
    });
    if (res.status === 429) {
      await sleep(PACE_MS * (attempt + 2) * 2);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Trellus session-list ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as SessionRow[];
  }
  throw new Error("Trellus session-list: rate-limited after 4 attempts");
}

// Fetch every session in [startUs, endUs), bisecting any window that hits the
// page cap so nothing is dropped.
async function fetchRange(
  apiKey: string,
  startUs: number,
  endUs: number,
  counter: { calls: number },
  depth = 0,
): Promise<SessionRow[]> {
  const rows = await fetchWindow(apiKey, startUs, endUs, counter);
  if (rows.length < PAGE_LIMIT || depth >= MAX_BISECT_DEPTH) {
    if (rows.length >= PAGE_LIMIT) {
      console.error(`[trellus] window still at page cap after ${depth} bisections — some dials uncounted`);
    }
    return rows;
  }
  const mid = Math.floor((startUs + endUs) / 2);
  await sleep(PACE_MS);
  const left = await fetchRange(apiKey, startUs, mid, counter, depth + 1);
  await sleep(PACE_MS);
  const right = await fetchRange(apiKey, mid, endUs, counter, depth + 1);
  return [...left, ...right];
}

export async function fetchDaySessions(
  apiKey: string,
  dayStart: Date,
  dayEnd: Date,
  counter: { calls: number },
): Promise<SessionRow[]> {
  const startUs = dayStart.getTime() * 1000;
  const endUs = dayEnd.getTime() * 1000;
  const all: SessionRow[] = [];
  for (let i = 0; i < BASE_WINDOWS; i++) {
    const a = startUs + Math.floor((i * (endUs - startUs)) / BASE_WINDOWS);
    const b = startUs + Math.floor(((i + 1) * (endUs - startUs)) / BASE_WINDOWS);
    if (i > 0) await sleep(PACE_MS);
    all.push(...(await fetchRange(apiKey, a, b, counter)));
  }
  return all;
}

export function rollupByResource(rows: SessionRow[]): Map<string, DialDayTotals> {
  const slots = new Map<string, Set<number>>();
  const agg = new Map<string, DialDayTotals>();
  for (const [resourceId, startedAt, liveDuration, hasProspect] of rows) {
    let a = agg.get(resourceId);
    if (!a) {
      a = { dials: 0, conversations: 0, dialMinutes: 0 };
      agg.set(resourceId, a);
      slots.set(resourceId, new Set());
    }
    a.dials++;
    if (hasProspect || (liveDuration ?? 0) >= CONVERSATION_MIN_SECONDS) a.conversations++;
    slots.get(resourceId)!.add(Math.floor(startedAt / COVERAGE_SLOT_SECONDS));
  }
  for (const [resourceId, s] of slots) {
    agg.get(resourceId)!.dialMinutes = (s.size * COVERAGE_SLOT_SECONDS) / 60;
  }
  return agg;
}

// ET day bounds for a YYYY-MM-DD string (same offset derivation as
// setter-game's getETDateBounds, generalized to any day).
export function etDayBounds(etDay: string): { start: Date; end: Date; dateKey: Date } {
  const [y, m, d] = etDay.split("-").map(Number);
  // Offset as of noon UTC that day — stable across the day except the two DST
  // switch days, where a 1h slide on an edge slot is acceptable.
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const etString = probe.toLocaleString("en-US", { timeZone: "America/New_York" });
  const diffMs = probe.getTime() - new Date(etString).getTime();
  const start = new Date(Date.UTC(y, m - 1, d) + diffMs);
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    dateKey: new Date(etDay),
  };
}

export function currentETDay(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
}

export function shiftETDay(etDay: string, days: number): string {
  const [y, m, d] = etDay.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export async function syncTrellusDay(apiKey: string, etDay: string): Promise<TrellusSyncResult> {
  const { start, end, dateKey } = etDayBounds(etDay);
  const counter = { calls: 0 };
  const rows = await fetchDaySessions(apiKey, start, end, counter);
  const byResource = rollupByResource(rows);

  const mapped = await prisma.teamMember.findMany({
    where: { trellusUserId: { in: [...byResource.keys()] } },
    select: { id: true, name: true, trellusUserId: true },
  });
  const byTrellusId = new Map(mapped.map((m) => [m.trellusUserId!, m]));

  const result: TrellusSyncResult = {
    date: etDay,
    sessions: rows.length,
    setters: {},
    unmappedResourceIds: {},
    apiCalls: counter.calls,
  };

  for (const [resourceId, totals] of byResource) {
    const member = byTrellusId.get(resourceId);
    if (!member) {
      result.unmappedResourceIds[resourceId] = totals.dials;
      continue;
    }
    const data = {
      dials: totals.dials,
      conversations: totals.conversations,
      dialMinutes: Math.round(totals.dialMinutes),
    };
    await prisma.setterDialDay.upsert({
      where: { setterId_date: { setterId: member.id, date: dateKey } },
      create: { setterId: member.id, date: dateKey, ...data },
      update: data,
    });
    result.setters[member.name] = { ...data };
  }
  return result;
}
