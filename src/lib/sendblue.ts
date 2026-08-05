// SendBlue iMessage client — show-rate confirmations.
//
// The dedicated line is an "AI Agent" line: it can only REPLY into a group it
// has already been added to (the setter creates the group at booking and adds
// the line). It cannot cold-initiate. So every confirmation is a reply into an
// existing group via /api/send-group-message with the captured group_id.
//
// SAFETY: nothing actually sends unless SENDBLUE_LIVE === "true" (or a call
// passes { live: true }). Until then every send is a no-op "dry_run" so the
// whole flow can be exercised end-to-end without texting real prospects.

const BASE = process.env.SENDBLUE_BASE_URL || "https://api.sendblue.co";
const KEY_ID = process.env.SENDBLUE_API_KEY_ID;
const SECRET = process.env.SENDBLUE_API_SECRET;

/** The dedicated line's E.164 number, used as from_number and to exclude it from group participants. */
export const SENDBLUE_LINE = process.env.SENDBLUE_LINE_NUMBER || "";

/** Global kill-switch: real sends only happen when this is explicitly true. */
export function isLive(): boolean {
  return process.env.SENDBLUE_LIVE === "true";
}

function authHeaders(): Record<string, string> {
  if (!KEY_ID || !SECRET) {
    throw new Error(
      "SendBlue credentials missing (SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET)"
    );
  }
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": KEY_ID,
    "sb-api-secret-key": SECRET,
  };
}

export interface SendResult {
  status: string; // sent | queued | dry_run | ...
  messageHandle?: string;
  groupId?: string;
  dryRun: boolean;
  raw?: unknown;
}

export interface SendGroupOptions {
  /** Existing group to continue. Preferred — the only mode the AI Agent line supports. */
  groupId?: string;
  /** Only for first message that creates a group (Blue Ocean line only). */
  numbers?: string[];
  content: string;
  /** Video/image URL — used for the day-of testimonial. */
  mediaUrl?: string;
  /** Override the global kill-switch for this one call. */
  live?: boolean;
}

/**
 * Send a message into a SendBlue group. Returns a dry-run result unless live.
 */
export async function sendGroupMessage(opts: SendGroupOptions): Promise<SendResult> {
  const live = opts.live ?? isLive();
  if (!live) {
    return {
      status: "dry_run",
      messageHandle: `dry_${Date.now()}`,
      groupId: opts.groupId,
      dryRun: true,
    };
  }

  const body: Record<string, unknown> = {};
  if (opts.content) body.content = opts.content; // omit when media-only
  if (opts.groupId) body.group_id = opts.groupId;
  if (opts.numbers) body.numbers = opts.numbers;
  if (opts.mediaUrl) body.media_url = opts.mediaUrl;
  if (SENDBLUE_LINE) body.from_number = SENDBLUE_LINE;

  const res = await fetch(`${BASE}/api/send-group-message`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`SendBlue send-group-message ${res.status}: ${JSON.stringify(data)}`);
  }
  return {
    status: (data.status as string) || "sent",
    messageHandle: data.message_handle as string | undefined,
    groupId: (data.group_id as string | undefined) || opts.groupId,
    dryRun: false,
    raw: data,
  };
}

/**
 * Send a 1:1 message (ops alerts / diagnostics). Not the prospect path.
 */
export async function sendMessage(opts: {
  number: string;
  content: string;
  mediaUrl?: string;
  live?: boolean;
}): Promise<SendResult> {
  const live = opts.live ?? isLive();
  if (!live) {
    return { status: "dry_run", messageHandle: `dry_${Date.now()}`, dryRun: true };
  }
  const body: Record<string, unknown> = { number: opts.number, content: opts.content };
  if (opts.mediaUrl) body.media_url = opts.mediaUrl;
  if (SENDBLUE_LINE) body.from_number = SENDBLUE_LINE;

  const res = await fetch(`${BASE}/api/send-message`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`SendBlue send-message ${res.status}: ${JSON.stringify(data)}`);
  }
  return {
    status: (data.status as string) || "sent",
    messageHandle: data.message_handle as string | undefined,
    dryRun: false,
    raw: data,
  };
}

/** iMessage-vs-SMS lookup for a number. Never throws — returns "unknown" on failure. */
export async function evaluateService(
  number: string
): Promise<"iMessage" | "SMS" | "unknown"> {
  try {
    const res = await fetch(
      `${BASE}/api/evaluate-service?number=${encodeURIComponent(number)}`,
      { headers: authHeaders() }
    );
    if (!res.ok) return "unknown";
    const data = await res.json();
    return (data.service as "iMessage" | "SMS") || "unknown";
  } catch {
    return "unknown";
  }
}

export interface SendblueMessage {
  group_id?: string | null;
  from_number?: string | null;
  is_outbound?: boolean;
  content?: string | null;
  date_sent?: string | null;
}

/**
 * Recent message history (v2 API). This is how we discover setter-created
 * groups WITHOUT a dashboard webhook: poll before building each worklist and
 * map group_id -> participant phones.
 */
export async function listMessages(limit = 100): Promise<SendblueMessage[]> {
  const res = await fetch(
    `${BASE}/api/v2/messages?limit=${limit}&order_direction=desc`,
    { headers: authHeaders() }
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const msgs = Array.isArray(data) ? data : data?.messages || data?.data || [];
  return msgs as SendblueMessage[];
}

/** List the numbers (lines) on this SendBlue account. */
export async function getLines(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/lines`, { headers: authHeaders() });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({ numbers: [] }));
  return (data.numbers as string[]) || [];
}
