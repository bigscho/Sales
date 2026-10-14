import { resolveSetterAlias } from "./setter-aliases";
import { normalizePersonName } from "./setter-attribution";

// Names for unmapped Trellus resource_ids. The dialer sync only stores ids in
// SyncLog; GET https://api.trellus.ai/bootstrap (same Bearer key as the RPT
// session API) is the roster that joins user_id → user_name / platform_email.
// Missing or rejected roster responses degrade to id-only seats.

export interface TrellusRosterUser {
  id: string;
  name: string | null;
  email: string | null;
}

export interface TrellusSuggestion {
  memberId: string;
  memberName: string;
  reason: "email" | "name" | "alias";
}

export interface UnmappedTrellusSeat {
  trellusUserId: string;
  dials: number;
  name: string | null;
  email: string | null;
  suggestion: TrellusSuggestion | null;
}

export interface SuggestableMember {
  id: string;
  name: string;
  email: string | null;
  role: string;
  isActive: boolean;
  trellusUserId: string | null;
}

const ID_KEYS = ["user_id", "userId", "resource_id", "resourceId"];
const NAME_KEYS = ["user_name", "userName", "display_name", "displayName", "name", "full_name", "fullName"];
const EMAIL_KEYS = ["platform_email", "platformEmail", "email"];

function readString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Pull user records out of whatever shape the Trellus bootstrap payload uses. */
export function extractRosterUsers(body: unknown): TrellusRosterUser[] {
  const found = new Map<string, TrellusRosterUser>();

  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const id = readString(obj, ID_KEYS);
    const name = readString(obj, NAME_KEYS);
    const email = readString(obj, EMAIL_KEYS);
    // Require an explicit user/resource id plus a name or email. Bare `{id, name}`
    // objects (teams, dispositions) are not seats.
    const hasUserId = ID_KEYS.some((key) => typeof obj[key] === "string" && obj[key]);
    if (hasUserId && id && (name || email) && !found.has(id)) {
      found.set(id, { id, name, email });
    }
    for (const value of Object.values(obj)) visit(value, depth + 1);
  };

  visit(body, 0);
  return [...found.values()];
}

/** Parse `unmapped resource_ids: {"abc": 12}` from a Trellus SyncLog.errorMessage. */
export function parseUnmappedResourceIds(errorMessage: string | null | undefined): Record<string, number> {
  if (!errorMessage) return {};
  const marker = "unmapped resource_ids:";
  const idx = errorMessage.indexOf(marker);
  if (idx === -1) return {};
  const json = errorMessage.slice(idx + marker.length).trim();
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, dials] of Object.entries(parsed)) {
      if (!id.trim()) continue;
      const n = typeof dials === "number" ? dials : Number(dials);
      if (!Number.isFinite(n)) continue;
      out[id.trim()] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function uniqueHit<T>(items: T[]): T | null {
  return items.length === 1 ? items[0] : null;
}

/**
 * Suggest a setter for an unmapped Trellus seat. Exact email, exact normalized
 * name, or an explicit setter alias only — never a fuzzy name, and never auto-applied.
 * Only unlinked active setters are candidates (a seat already on someone else is a conflict).
 */
export function suggestSetterForTrellusUser(
  user: { name: string | null; email: string | null },
  members: SuggestableMember[],
): TrellusSuggestion | null {
  const open = members.filter((m) => m.role === "setter" && m.isActive && !m.trellusUserId);
  if (open.length === 0) return null;

  const email = user.email?.trim().toLowerCase() || "";
  if (email) {
    const hit = uniqueHit(open.filter((m) => (m.email || "").trim().toLowerCase() === email));
    if (hit) return { memberId: hit.id, memberName: hit.name, reason: "email" };
  }

  const name = user.name?.trim() || "";
  if (!name) return null;
  const normalized = normalizePersonName(name);
  if (normalized) {
    const hit = uniqueHit(open.filter((m) => normalizePersonName(m.name) === normalized));
    if (hit) return { memberId: hit.id, memberName: hit.name, reason: "name" };
  }

  const aliased = resolveSetterAlias(name);
  if (aliased && normalizePersonName(aliased) !== normalized) {
    const target = normalizePersonName(aliased);
    const hit = uniqueHit(open.filter((m) => normalizePersonName(m.name) === target));
    if (hit) return { memberId: hit.id, memberName: hit.name, reason: "alias" };
  }

  return null;
}

export function buildUnmappedSeats(
  dialsById: Record<string, number>,
  roster: TrellusRosterUser[],
  members: SuggestableMember[],
): UnmappedTrellusSeat[] {
  const byId = new Map(roster.map((u) => [u.id, u]));
  return Object.entries(dialsById)
    .map(([trellusUserId, dials]) => {
      const known = byId.get(trellusUserId);
      const name = known?.name ?? null;
      const email = known?.email ?? null;
      return {
        trellusUserId,
        dials,
        name,
        email,
        suggestion: suggestSetterForTrellusUser({ name, email }, members),
      };
    })
    .sort((a, b) => b.dials - a.dials || a.trellusUserId.localeCompare(b.trellusUserId));
}

const BOOTSTRAP_URL = "https://api.trellus.ai/bootstrap";
const ROSTER_TTL_MS = 10 * 60 * 1000;

let rosterCache: { at: number; users: TrellusRosterUser[] } | null = null;

export function resetTrellusRosterCache() {
  rosterCache = null;
}

async function fetchBootstrap(apiKey: string, authorization: string): Promise<Response> {
  return fetch(BOOTSTRAP_URL, {
    headers: { Authorization: authorization, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
}

/**
 * Best-effort roster. Returns available:false when the key is missing or Trellus
 * rejects the call — callers still show unmapped ids from the sync log.
 */
export async function loadTrellusRoster(
  apiKey: string | undefined,
): Promise<{ users: TrellusRosterUser[]; available: boolean }> {
  if (!apiKey) return { users: [], available: false };
  if (rosterCache && Date.now() - rosterCache.at < ROSTER_TTL_MS) {
    return { users: rosterCache.users, available: true };
  }
  try {
    let res = await fetchBootstrap(apiKey, `Bearer ${apiKey}`);
    if (res.status === 401 || res.status === 403) {
      res = await fetchBootstrap(apiKey, apiKey);
    }
    if (!res.ok) {
      console.error(`[trellus] bootstrap ${res.status}`);
      return { users: rosterCache?.users ?? [], available: false };
    }
    const body = await res.json();
    const users = extractRosterUsers(body);
    rosterCache = { at: Date.now(), users };
    return { users, available: true };
  } catch (err) {
    console.error("[trellus] bootstrap failed", err);
    return { users: rosterCache?.users ?? [], available: false };
  }
}
