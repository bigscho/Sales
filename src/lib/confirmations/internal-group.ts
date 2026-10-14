// Internal iMessage groups the SendBlue line sits in besides prospect chats:
// the setters' coaching group, the closers' group (Colin, Matthew, and the
// line), and any later one added the same way. group_id does not exist until
// the first inbound, so each group is recognized from its own member list in
// SENDBLUE_INTERNAL_GROUPS. A prospect group always contains the prospect, so
// it does not equal any of those lists.
//
// One configured handle is not enough. The setter who opens a prospect group
// is a member of that group; a one-handle list would swallow every prospect
// thread they start. Full exclusion (no booking, no worklist, no confirmation
// send, message storage) is an exact set (line excluded), not "any overlap",
// so the closers pair is not confused with the setters list.
//
// Handles are E.164 numbers or iMessage Apple Account emails. SendBlue's
// webhook puts both in `participants` as plain strings. When the sender is
// email-only, `from_number` and `number` are that email too. The groups API
// object field is `handle` (the same raw phone or email); `participant_numbers`
// omits email-only people, so this code never reads that list.
//
// Origination has a wider safety net than full exclusion: any group that
// merely contains an internal-list handle or a TeamMember email skips the
// automatic greeting. That does not flag the group, clear its booking, store
// its messages, or take it off a worklist.

/** Last 10 digits. Same rule as normalizePhone in worklist.ts (numeric-safe). */
function last10(p: string | number | null | undefined): string | null {
  const digits = String(p ?? "").replace(/\D/g, "");
  if (digits.length < 10) return digits || null;
  return digits.slice(-10);
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

function stripMailto(value: string): string {
  return value.startsWith("mailto:") ? value.slice("mailto:".length).trim() : value;
}

/** iMessage Apple Account email, or null when `raw` is a phone or junk. */
function extractEmail(raw: string): string | null {
  let s = stripMailto(raw.trim().toLowerCase());
  const angle = s.match(/<([^<>]+)>/);
  if (angle) s = stripMailto(angle[1].trim());
  s = s.replace(/^["']+|["']+$/g, "");
  return EMAIL_RE.test(s) ? s : null;
}

/**
 * String form of one SendBlue participant. Webhook entries are strings (phone
 * or email). Groups-API entries are objects; `handle` is the raw identifier.
 */
export function participantIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  for (const key of ["handle", "email", "phone", "number"] as const) {
    const inner = rec[key];
    if (typeof inner === "number" && Number.isFinite(inner)) return String(inner);
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  }
  return null;
}

/**
 * Canonical roster token. Emails are trimmed and lowercased. Phones are the
 * last 10 digits. The SendBlue line and anything that is neither are omitted.
 * Emails contain `@`, so they never collide with a phone token.
 */
export function normalizeHandle(value: unknown, lineNumber?: string | null): string | null {
  const id = participantIdentifier(value);
  if (!id) return null;
  const email = extractEmail(id);
  if (email) return email;
  const phone = last10(id);
  if (!phone || phone.length !== 10) return null;
  const line = last10(lineNumber);
  if (line && phone === line) return null;
  return phone;
}

/** Config tokens keep phone text as typed; emails are stored canonical. */
function configToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return extractEmail(trimmed) ?? trimmed;
}

function dedupeTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
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

/**
 * One coaching chat. `phones` is the human roster: E.164 numbers and iMessage
 * emails. The SendBlue line is not listed. The field name stays `phones` so
 * existing JSON config keeps working; `handles` is accepted as an alias.
 */
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
 * Text (newline or `;` between groups). Each human is an E.164 phone or an
 * iMessage email (trimmed; emails lowercased):
 *   setters:+15551111111,solomonnassa@icloud.com|grp_setters
 *   closers:+15553333333,+15554444444
 * `|groupIds` is optional. JSON is accepted when the value starts with `[`:
 *   [{"name":"closers","phones":["+1555..."],"handles":["a@icloud.com"],"groupIds":["grp_..."]}]
 * `phones` and `handles` are one roster; either or both may be set.
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
        error: `SENDBLUE_INTERNAL_GROUPS entry "${entry}" needs name:handle,handle`,
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
      phones: dedupeTokens(phonesPart.split(",").map((s) => configToken(s))),
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
      phones: dedupeTokens([...stringArray(rec.phones), ...stringArray(rec.handles)]),
      groupIds: stringArray(rec.groupIds),
    });
  }
  return { groups, error: null };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => configToken(s))
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
  /**
   * Roster. Strings (E.164 or iMessage email), numbers, or groups-API
   * participant objects. The SendBlue line may be included; it is ignored.
   */
  participants: unknown[];
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
 * equal one entry's handles (phones and emails, line removed on both sides).
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
  participants: unknown[],
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
  participants: unknown[],
  groups: InternalGroupConfig[],
  lineNumber?: string | null
): InternalGroupConfig | null {
  const hits = groups.filter((g) => rosterMatchesGroup(participants, g.phones, lineNumber));
  return hits[0] ?? null;
}

function humanSet(values: unknown[], lineNumber?: string | null): Set<string> {
  const members = new Set<string>();
  for (const value of values) {
    const handle = normalizeHandle(value, lineNumber);
    if (!handle) continue;
    members.add(handle);
  }
  return members;
}

/**
 * When the sender's Apple ID email is missing from an explicit `participants`
 * array, fold it in so the roster can still equal the configured set. A phone
 * `from_number` is not added: that field alone is not a roster. No-op when
 * `sender` is not an email.
 */
export function withSenderEmail(participants: unknown[], sender: unknown): unknown[] {
  const id = participantIdentifier(sender);
  const email = id ? extractEmail(id) : null;
  if (!email) return participants;
  for (const participant of participants) {
    const existing = participantIdentifier(participant);
    if (existing && extractEmail(existing) === email) return participants;
  }
  return [...participants, email];
}

/**
 * Walk a stored or inbound participant value down to identifier leaves.
 * SendblueGroup.participants was merged with `new Set([...parsed, ...incoming])`.
 * Set dedupes strings, not arrays: `normalizePhone` stringifies an array into
 * digits, so the array object itself was stored, and every later sync appended
 * another copy. Leaves are phones, emails, and participant objects. JSON
 * strings of arrays are parsed. Wide sibling copies and a few layers of
 * wrapping both collapse here.
 */
export function flattenParticipantValues(value: unknown): unknown[] {
  const out: unknown[] = [];
  const stack: unknown[] = [value];
  let steps = 0;
  while (stack.length > 0 && steps < 200_000) {
    steps++;
    const current = stack.pop();
    if (current == null) continue;
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("[") || trimmed.startsWith('"')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsed) || typeof parsed === "string") {
            stack.push(parsed);
            continue;
          }
        } catch {
          // Not a wrapped roster. Keep the string as an identifier.
        }
      }
      out.push(trimmed);
      continue;
    }
    if (typeof current === "number") {
      if (Number.isFinite(current)) out.push(current);
      continue;
    }
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
      continue;
    }
    if (typeof current === "object") out.push(current);
  }
  return out;
}

/**
 * First three characters of a JSON string whose contents are another JSON
 * value: quote, backslash, quote. Flat arrays start with `[` and do not match.
 */
export const DOUBLE_ENCODED_JSON_PREFIX = '"\\"';

/** True when a stored JSON blob still has nested arrays, objects, or a second encoding. */
export function storedParticipantsLookNested(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return (
    raw.includes(",[") ||
    raw.startsWith("[[") ||
    raw.startsWith('"[') ||
    raw.startsWith(DOUBLE_ENCODED_JSON_PREFIX) ||
    raw.includes(",{")
  );
}

/**
 * Values persisted on `SendblueGroup.participants`.
 * Always a flat list of strings: phones in the first-seen text form (booking
 * lookup is a last-10 `contains` on that JSON), emails canonical. Nested
 * copies collapse. The line is omitted. Short digit strings are kept,
 * matching the pre-email phone filter.
 */
export function participantsToStore(values: unknown[], lineNumber?: string | null): string[] {
  const lineNorm = last10(lineNumber);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of flattenParticipantValues(values)) {
    const id = participantIdentifier(value);
    if (!id) continue;
    const email = extractEmail(id);
    if (email) {
      if (seen.has(email)) continue;
      seen.add(email);
      out.push(email);
      continue;
    }
    const phone = last10(id);
    if (!phone || (lineNorm && phone === lineNorm)) continue;
    const key = `p:${phone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id.trim());
  }
  return out;
}

/**
 * Union a stored participants JSON blob with newly seen identifiers.
 * The result is flat and deduped. Repeating the call with the same incoming
 * roster does not grow the list.
 */
export function mergeParticipants(
  existingRaw: string | null | undefined,
  incoming: unknown,
  lineNumber?: string | null
): string[] {
  let existing: unknown = [];
  if (existingRaw && existingRaw.trim()) {
    try {
      existing = JSON.parse(existingRaw) as unknown;
    } catch {
      existing = existingRaw;
    }
  }
  return participantsToStore([existing, incoming], lineNumber);
}

/**
 * Canonical JSON for a SendblueGroup.participants cell. Idempotent: a second
 * pass returns the same string. Null stays null.
 */
export function normalizeStoredParticipants(
  raw: string | null | undefined,
  lineNumber?: string | null
): string | null {
  if (raw == null) return null;
  if (!raw.trim()) return raw;
  return JSON.stringify(mergeParticipants(raw, [], lineNumber));
}

function coerceParticipantList(value: unknown): unknown[] {
  return flattenParticipantValues(value);
}

function configuredHandleSet(groups: InternalGroupConfig[], lineNumber?: string | null): Set<string> {
  const handles = new Set<string>();
  for (const group of groups) {
    for (const phone of group.phones) {
      const handle = normalizeHandle(phone, lineNumber);
      if (handle) handles.add(handle);
    }
  }
  return handles;
}

function teamEmailSet(emails: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const email of emails) {
    if (typeof email !== "string") continue;
    const canonical = extractEmail(email);
    if (canonical) out.add(canonical);
  }
  return out;
}

export type OriginationBlockReason = "internal_group" | "internal_handle";

/**
 * Why origination must not greet this group.
 * `internal_group` — exact roster, pinned id, or the sticky flag. Full exclusion.
 * `internal_handle` — the roster merely contains an internal-list phone/email
 * or any TeamMember email. Origination only; the group stays a prospect group
 * for booking match, worklists, and message storage.
 * Null means origination may proceed.
 */
export function originationInternalBlock(input: {
  internal: boolean;
  groupId: string;
  participants: unknown;
  groups: InternalGroupConfig[];
  teamMemberEmails?: Array<string | null | undefined>;
  lineNumber?: string | null;
}): OriginationBlockReason | null {
  const groupId = input.groupId.trim();
  if (input.internal || (groupId && pinnedInternalGroupIds(input.groups).includes(groupId))) {
    return "internal_group";
  }
  const handles = configuredHandleSet(input.groups, input.lineNumber);
  const teamEmails = teamEmailSet(input.teamMemberEmails ?? []);
  if (handles.size === 0 && teamEmails.size === 0) return null;
  for (const participant of coerceParticipantList(input.participants)) {
    const handle = normalizeHandle(participant, input.lineNumber);
    if (!handle) continue;
    if (handles.has(handle)) return "internal_handle";
    if (handle.includes("@") && teamEmails.has(handle)) return "internal_handle";
  }
  return null;
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
