// Internal iMessage groups the SendBlue line sits in besides prospect chats:
// the setters' coaching group, the closers' group (Colin, Matthew, and the
// line), and any later one added the same way. group_id does not exist until
// the first inbound, so each group is recognized from its own member list in
// SENDBLUE_INTERNAL_GROUPS. A prospect group always contains the prospect, so
// it does not equal any of those lists.
//
// One configured number is not enough. The setter who opens a prospect group
// is a member of that group; a one-number list would swallow every prospect
// thread they start. Membership is an exact set (line excluded), not "any
// overlap", so the closers pair is not confused with the setters list.

/** Last 10 digits. Same rule as normalizePhone in worklist.ts (numeric-safe). */
function last10(p: string | number | null | undefined): string | null {
  const digits = String(p ?? "").replace(/\D/g, "");
  if (digits.length < 10) return digits || null;
  return digits.slice(-10);
}

/**
 * Phone-roster matches require at least this many distinct humans. A single
 * setter number is also a member of that setter's prospect groups.
 */
export const MIN_INTERNAL_ROSTER = 2;

export function parseEnvList(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(/[,;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One coaching chat. Phones are the humans; the SendBlue line is not listed. */
export interface InternalGroupConfig {
  name: string;
  phones: string[];
  /** Optional pins, filled in after the first message reveals group_id. */
  groupIds: string[];
}

export interface InternalMatch {
  internal: boolean;
  /** Configured name (`setters`, `closers`, …) when this payload matched one. */
  name: string | null;
}

const NOT_INTERNAL: InternalMatch = { internal: false, name: null };

export function internalGroupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  groups: InternalGroupConfig[];
  error: string | null;
} {
  return parseInternalGroups(env.SENDBLUE_INTERNAL_GROUPS);
}

/**
 * `SENDBLUE_INTERNAL_GROUPS` is a list, not one shared phone set.
 *
 * Text (newline or `;` between groups):
 *   setters:+15551111111,+15552222222|grp_setters
 *   closers:+15553333333,+15554444444
 * `|groupIds` is optional. JSON is accepted when the value starts with `[`:
 *   [{"name":"closers","phones":["+1555...","+1555..."],"groupIds":["grp_..."]}]
 */
export function parseInternalGroups(value: string | undefined | null): {
  groups: InternalGroupConfig[];
  error: string | null;
} {
  if (!value || !value.trim()) return { groups: [], error: null };
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) return parseJsonGroups(trimmed);
  return parseTextGroups(trimmed);
}

function parseTextGroups(value: string): { groups: InternalGroupConfig[]; error: string | null } {
  const entries = value
    .split(/[;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const groups: InternalGroupConfig[] = [];
  for (const entry of entries) {
    const colon = entry.indexOf(":");
    const eq = entry.indexOf("=");
    const cut = colon === -1 ? eq : eq === -1 ? colon : Math.min(colon, eq);
    if (cut <= 0) {
      return {
        groups: [],
        error: `SENDBLUE_INTERNAL_GROUPS entry "${entry}" needs name:phone,phone`,
      };
    }
    const name = entry.slice(0, cut).trim();
    const rest = entry.slice(cut + 1).trim();
    const pipe = rest.indexOf("|");
    const phonesPart = (pipe === -1 ? rest : rest.slice(0, pipe)).trim();
    const idsPart = pipe === -1 ? "" : rest.slice(pipe + 1).trim();
    if (!name) {
      return { groups: [], error: "SENDBLUE_INTERNAL_GROUPS entry is missing a name" };
    }
    groups.push({
      name,
      phones: phonesPart.split(",").map((s) => s.trim()).filter(Boolean),
      groupIds: idsPart.split(",").map((s) => s.trim()).filter(Boolean),
    });
  }
  if (groups.length === 0) {
    return { groups: [], error: "SENDBLUE_INTERNAL_GROUPS did not contain any groups" };
  }
  return { groups, error: null };
}

function parseJsonGroups(value: string): { groups: InternalGroupConfig[]; error: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return { groups: [], error: "SENDBLUE_INTERNAL_GROUPS is not valid JSON" };
  }
  if (!Array.isArray(raw)) {
    return { groups: [], error: "SENDBLUE_INTERNAL_GROUPS JSON must be an array" };
  }
  const groups: InternalGroupConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { groups: [], error: "SENDBLUE_INTERNAL_GROUPS JSON entries must be objects" };
    }
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) {
      return { groups: [], error: "each SENDBLUE_INTERNAL_GROUPS entry needs a name" };
    }
    groups.push({
      name,
      phones: stringArray(rec.phones),
      groupIds: stringArray(rec.groupIds),
    });
  }
  return { groups, error: null };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function pinnedInternalGroupIds(groups: InternalGroupConfig[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const id of group.groupIds) {
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export interface ClassifyInternalInput {
  groupId: string;
  /** Roster numbers. The SendBlue line may be included; it is ignored. */
  participants: Array<string | number | null | undefined>;
  /**
   * True when SendBlue sent a participants array (or the poll actually saw
   * one). A from_number-only payload is not a roster: in a prospect group the
   * sender is usually the setter.
   */
  participantsExplicit: boolean;
  lineNumber?: string | null;
  groups: InternalGroupConfig[];
  /** Sticky. A later partial payload must not un-flag a coaching chat. */
  alreadyInternal?: boolean;
  /** Kept when this payload does not match a list entry on its own. */
  alreadyName?: string | null;
}

/**
 * Which configured internal group this roster is, if any.
 * A pinned group id wins. Otherwise the humans in the explicit roster must
 * equal one entry's phone list (line removed on both sides).
 */
export function classifyInboundGroup(input: ClassifyInternalInput): InternalMatch {
  const groupId = input.groupId.trim();
  if (groupId) {
    const pinned = input.groups.find((g) => g.groupIds.some((id) => id.trim() === groupId));
    if (pinned) return { internal: true, name: pinned.name };
  }
  if (input.participantsExplicit) {
    const found = matchRoster(input.participants, input.groups, input.lineNumber);
    if (found) return { internal: true, name: found.name };
  }
  if (input.alreadyInternal) return { internal: true, name: input.alreadyName ?? null };
  return NOT_INTERNAL;
}

/** True when the humans in `participants` are exactly `configuredPhones`. */
export function rosterMatchesGroup(
  participants: Array<string | number | null | undefined>,
  configuredPhones: string[],
  lineNumber?: string | null
): boolean {
  const configured = humanSet(configuredPhones, lineNumber);
  if (configured.size < MIN_INTERNAL_ROSTER) return false;
  const members = humanSet(participants, lineNumber);
  if (members.size !== configured.size) return false;
  for (const n of members) {
    if (!configured.has(n)) return false;
  }
  return true;
}

function matchRoster(
  participants: Array<string | number | null | undefined>,
  groups: InternalGroupConfig[],
  lineNumber?: string | null
): InternalGroupConfig | null {
  const hits = groups.filter((g) => rosterMatchesGroup(participants, g.phones, lineNumber));
  return hits[0] ?? null;
}

function humanSet(
  numbers: Array<string | number | null | undefined>,
  lineNumber?: string | null
): Set<string> {
  const line = last10(lineNumber);
  const members = new Set<string>();
  for (const p of numbers) {
    const n = last10(p);
    if (!n || n.length !== 10) continue;
    if (line && n === line) continue;
    members.add(n);
  }
  return members;
}

/**
 * Columns forced on an internal group. Empty for everyone else, so a prospect
 * upsert does not gain fields it did not write before.
 * bookingId / prospectPhone are cleared so a member's own number can never
 * route T-1, day-of, or reconnect into a coaching chat.
 * internalName is omitted when this payload didn't re-identify the list
 * entry, so a sticky flag does not wipe `setters` / `closers`.
 */
export function internalGroupWrite(match: InternalMatch): {
  internal: true;
  bookingId: null;
  prospectPhone: null;
  internalName?: string;
} | Record<string, never> {
  if (!match.internal) return {};
  return {
    internal: true,
    bookingId: null,
    prospectPhone: null,
    ...(match.name ? { internalName: match.name } : {}),
  };
}

/** Worklist / reconnect group lookup. Internal rows and pinned ids never match. */
export function confirmationGroupWhere(
  bookingId: string,
  phoneNorm: string | null,
  excludedGroupIds: string[]
) {
  return {
    internal: false as const,
    ...(excludedGroupIds.length ? { groupId: { notIn: excludedGroupIds } } : {}),
    OR: [
      { bookingId },
      ...(phoneNorm
        ? [{ prospectPhone: { contains: phoneNorm } }, { participants: { contains: phoneNorm } }]
        : []),
    ],
  };
}

export interface InboundPayload {
  is_outbound?: boolean;
  from_number?: string | number | null;
  number?: string | number | null;
  content?: string | null;
  media_url?: string | null;
  date_sent?: string | null;
  message_handle?: string | null;
}

export interface InternalInboundDraft {
  groupId: string;
  senderNumber: string;
  text: string | null;
  mediaUrl: string | null;
  sentAt: Date;
  messageHandle: string | null;
}

/** Prospect threads and our own outbound echoes are not coaching-log rows. */
export function shouldRecordInbound(internal: boolean, isOutbound: boolean): boolean {
  return internal && !isOutbound;
}

function senderNumber(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed || null;
}

function textOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v.trim() ? v : null;
}

/**
 * Map one inbound webhook body onto the coaching-log row. Null for outbound,
 * or when there is no sender number to store. `now` is only used when
 * date_sent is missing or unparseable.
 */
export function draftInternalInbound(
  body: InboundPayload,
  groupId: string,
  now = new Date()
): InternalInboundDraft | null {
  if (body.is_outbound === true) return null;
  const sender = senderNumber(body.from_number) || senderNumber(body.number);
  if (!sender) return null;
  const sentRaw = typeof body.date_sent === "string" ? body.date_sent : null;
  const parsed = sentRaw ? new Date(sentRaw) : null;
  const sentAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
  const media =
    typeof body.media_url === "string" && body.media_url.trim() ? body.media_url.trim() : null;
  const handle =
    typeof body.message_handle === "string" && body.message_handle.trim()
      ? body.message_handle.trim()
      : null;
  return {
    groupId,
    senderNumber: sender,
    text: textOrNull(body.content),
    mediaUrl: media,
    sentAt,
    messageHandle: handle,
  };
}
