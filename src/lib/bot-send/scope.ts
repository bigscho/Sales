// Who a bot may text, and which cap applies.
//
// With no BOT_SEND_CALLER_SCOPES entry, a caller may text internal groups only.
// A prospect phone or any other group is refused unless that caller is scoped
// to it. Internal groups are BOT_SEND_INTERNAL_GROUPS plus any group id pinned
// on SENDBLUE_INTERNAL_GROUPS.

import { parseInternalGroups, pinnedInternalGroupIds } from "@/lib/confirmations/internal-group";
import { optOutPhone } from "@/lib/confirmations/guards";
import type { EnvLike } from "./auth";
import { normalizeBotPhone } from "./validate";

export interface CallerScope {
  groups: Set<string>;
  /** Last 10 digits. */
  phones: Set<string>;
}

export type ScopeMap =
  | { ok: true; scopes: Map<string, CallerScope> | null }
  | { ok: false };

function splitIds(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Group ids that get the internal daily cap and the default bot scope. */
export function internalGroupIds(env: EnvLike = process.env): Set<string> {
  const ids = new Set<string>(splitIds(env.BOT_SEND_INTERNAL_GROUPS));
  const parsed = parseInternalGroups(env.SENDBLUE_INTERNAL_GROUPS);
  if (!parsed.error) {
    for (const id of pinnedInternalGroupIds(parsed.groups)) ids.add(id);
  }
  return ids;
}

export function isInternalGroupTarget(groupId: string | null | undefined, env: EnvLike = process.env): boolean {
  return !!groupId && internalGroupIds(env).has(groupId);
}

function phoneKey(raw: string): string {
  return optOutPhone(normalizeBotPhone(raw) ?? raw);
}

export function parseCallerScopes(raw: string | undefined): ScopeMap {
  if (raw == null || raw.trim() === "") return { ok: true, scopes: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const scopes = new Map<string, CallerScope>();
  for (const [caller, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
    const rec = value as Record<string, unknown>;
    const groups = new Set<string>();
    const phones = new Set<string>();
    if (rec.groups != null) {
      if (!Array.isArray(rec.groups)) return { ok: false };
      for (const id of rec.groups) {
        if (typeof id !== "string" || !id.trim()) return { ok: false };
        groups.add(id.trim());
      }
    }
    if (rec.phones != null) {
      if (!Array.isArray(rec.phones)) return { ok: false };
      for (const phone of rec.phones) {
        if (typeof phone !== "string") return { ok: false };
        const key = phoneKey(phone);
        if (!key) return { ok: false };
        phones.add(key);
      }
    }
    scopes.set(caller, { groups, phones });
  }
  return { ok: true, scopes };
}

export interface ScopeTarget {
  channel: "direct" | "group";
  groupId: string | null;
  phone: string | null;
}

/** False when this caller may not text this recipient. Malformed scopes fail closed. */
export function recipientAllowed(caller: string, target: ScopeTarget, env: EnvLike = process.env): boolean {
  const parsed = parseCallerScopes(env.BOT_SEND_CALLER_SCOPES);
  if (!parsed.ok) return false;
  const internal = target.channel === "group" && isInternalGroupTarget(target.groupId, env);
  const scope = parsed.scopes?.get(caller);
  if (!scope) return internal;
  if (target.channel === "group" && target.groupId && scope.groups.has(target.groupId)) return true;
  if (target.channel === "direct" && target.phone && scope.phones.has(target.phone)) return true;
  return false;
}

/**
 * Group ids this caller may read. Null when the scope JSON is malformed.
 * A caller with no scope sees the internal groups. A scoped caller sees only
 * the groups named on that scope.
 */
export function groupsVisibleToCaller(caller: string, env: EnvLike = process.env): Set<string> | null {
  const parsed = parseCallerScopes(env.BOT_SEND_CALLER_SCOPES);
  if (!parsed.ok) return null;
  const scope = parsed.scopes?.get(caller);
  if (!scope) return internalGroupIds(env);
  return scope.groups;
}

export function internalGroupDailyCap(env: EnvLike = process.env): number {
  const raw = env.BOT_SEND_MAX_PER_INTERNAL_GROUP_PER_DAY;
  const n = raw == null || raw === "" ? 40 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 40;
  return Math.floor(n);
}

/** @coach replies on a 5-minute poll, so the internal caller cap is above the prospect cap of 10. */
export function internalCallerHourlyCap(env: EnvLike = process.env): number {
  const raw = env.BOT_SEND_MAX_PER_CALLER_PER_HOUR_INTERNAL;
  const n = raw == null || raw === "" ? 60 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 60;
  return Math.floor(n);
}

/** Internal traffic does not consume the confirmation hourly bucket. */
export function internalGlobalHourlyCap(env: EnvLike = process.env): number {
  const raw = env.BOT_SEND_MAX_INTERNAL_PER_HOUR;
  const n = raw == null || raw === "" ? 60 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 60;
  return Math.floor(n);
}
