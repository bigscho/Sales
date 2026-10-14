import { resolveSetterAlias } from "./setter-aliases";

// Resolve a Calendly "Booked by" / UTM string to an existing team member.
// Never invents a TeamMember. Free text that is not a person's name (self-booked,
// phone numbers, emails, addresses, notes) is left unattributed and returned so
// the caller can flag the booking for review.

export interface AttributionMember {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
  excludeFromLeaderboard?: boolean;
}

export interface BookedByAttribution {
  memberId: string | null;
  matchedRole: "setter" | "closer" | null;
  /** Trimmed raw text when nothing matched. Null when there was nothing to match or a member was found. */
  unmatchedBookedBy: string | null;
}

const GENERIC_LABELS = new Set([
  "self-booked",
  "self booked",
  "selfbooked",
  "myself",
  "me",
  "self",
  "calendly",
  "calendar",
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "tbd",
  "test",
  "admin",
  "guest",
  "booked",
  "owner",
  "website",
  "web",
  "organic",
  "inbound",
  "facebook",
  "instagram",
  "google",
  "ads",
]);

export function normalizePersonName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(name: string): string[] {
  const normalized = normalizePersonName(name);
  return normalized ? normalized.split(" ") : [];
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function tokenClose(query: string, candidate: string): boolean {
  if (query === candidate) return true;
  // "ger" can stand in for "gerges", but a 1-2 letter stub cannot.
  if (
    query.length >= 3 &&
    candidate.startsWith(query) &&
    query.length >= Math.ceil(candidate.length / 2)
  ) {
    return true;
  }
  const minLen = Math.min(query.length, candidate.length);
  if (minLen < 5) return false;
  const maxDist = Math.max(query.length, candidate.length) >= 8 ? 2 : 1;
  return editDistance(query, candidate) <= maxDist;
}

/** True when the string is notes, contact info, or a generic label rather than a name. */
export function isNonNameBookedBy(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (trimmed.includes("@")) return true;
  if (trimmed.length > 60) return true;

  const lowered = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (GENERIC_LABELS.has(lowered)) return true;
  if (GENERIC_LABELS.has(lowered.replace(/[^a-z]/g, ""))) return true;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 7) return true;

  if (
    /\d/.test(trimmed) &&
    /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|zip|suite|apt|unit)\b/i.test(trimmed)
  ) {
    return true;
  }

  const words = trimmed.replace(/[^A-Za-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length > 4) return true;

  return false;
}

type MatchOutcome =
  | { kind: "one"; member: AttributionMember }
  | { kind: "ambiguous" }
  | { kind: "none" };

function scoreAgainst(query: string, candidateName: string): number | null {
  const nq = nameTokens(query);
  const nc = nameTokens(candidateName);
  if (nq.length === 0 || nc.length === 0) return null;
  if (nq.join(" ") === nc.join(" ")) return 100;

  if (nq.length === 1) {
    if (tokenClose(nq[0], nc[0])) return 80;
    if (nc.length > 1 && tokenClose(nq[0], nc[nc.length - 1])) return 70;
    return null;
  }

  if (tokenClose(nq[0], nc[0]) && tokenClose(nq[nq.length - 1], nc[nc.length - 1])) return 90;
  return null;
}

function bestMatch(query: string, members: AttributionMember[]): MatchOutcome {
  let bestScore = 0;
  let best: AttributionMember[] = [];
  for (const member of members) {
    const score = scoreAgainst(query, member.name);
    if (score == null) continue;
    if (score > bestScore) {
      bestScore = score;
      best = [member];
    } else if (score === bestScore) {
      best.push(member);
    }
  }
  if (best.length === 1) return { kind: "one", member: best[0] };
  if (best.length > 1) return { kind: "ambiguous" };
  return { kind: "none" };
}

function exactNameHit(canonical: string, members: AttributionMember[]): MatchOutcome {
  const target = normalizePersonName(canonical);
  if (!target) return { kind: "none" };
  const hits = members.filter((m) => normalizePersonName(m.name) === target);
  if (hits.length === 1) return { kind: "one", member: hits[0] };
  if (hits.length > 1) return { kind: "ambiguous" };
  return { kind: "none" };
}

function asRole(role: string): "setter" | "closer" | null {
  return role === "setter" || role === "closer" ? role : null;
}

/**
 * Match free-text "Booked by" against active closers, then real setters, then
 * leaderboard-excluded setters (intentional guest/CEO rows). Ambiguous hits and
 * non-names stay unattributed. An explicit setter alias ("CC" → Chris Carr)
 * resolves only to that canonical active member — it does not fall through to
 * a fuzzy hit on someone else.
 */
export function attributeBookedBy(
  raw: string | null | undefined,
  members: AttributionMember[],
): BookedByAttribution {
  const trimmed = raw?.trim() || "";
  if (!trimmed) {
    return { memberId: null, matchedRole: null, unmatchedBookedBy: null };
  }
  if (isNonNameBookedBy(trimmed)) {
    return { memberId: null, matchedRole: null, unmatchedBookedBy: trimmed };
  }

  const active = members.filter((m) => m.isActive);
  const aliased = resolveSetterAlias(trimmed) ?? trimmed;
  const aliasChanged = normalizePersonName(aliased) !== normalizePersonName(trimmed);

  const finish = (outcome: MatchOutcome): BookedByAttribution | null => {
    if (outcome.kind === "one") {
      return {
        memberId: outcome.member.id,
        matchedRole: asRole(outcome.member.role),
        unmatchedBookedBy: null,
      };
    }
    if (outcome.kind === "ambiguous") {
      return { memberId: null, matchedRole: null, unmatchedBookedBy: trimmed };
    }
    return null;
  };

  if (aliasChanged) {
    const closers = active.filter((m) => m.role === "closer");
    const setters = active.filter((m) => m.role === "setter" && !m.excludeFromLeaderboard);
    const excluded = active.filter((m) => m.role === "setter" && m.excludeFromLeaderboard);
    for (const pool of [closers, setters, excluded]) {
      const hit = finish(exactNameHit(aliased, pool));
      if (hit) return hit;
    }
    return { memberId: null, matchedRole: null, unmatchedBookedBy: trimmed };
  }

  const closers = finish(bestMatch(trimmed, active.filter((m) => m.role === "closer")));
  if (closers) return closers;

  const realSetters = finish(
    bestMatch(trimmed, active.filter((m) => m.role === "setter" && !m.excludeFromLeaderboard)),
  );
  if (realSetters) return realSetters;

  const excludedSetters = finish(
    bestMatch(trimmed, active.filter((m) => m.role === "setter" && m.excludeFromLeaderboard)),
  );
  if (excludedSetters) return excludedSetters;

  return { memberId: null, matchedRole: null, unmatchedBookedBy: trimmed };
}
