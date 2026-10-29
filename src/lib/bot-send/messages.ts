// Read-only trim of Sendblue history for bots. Never a send.

import { listMessages, type SendblueMessage } from "@/lib/sendblue";

export interface PublicSendblueMessage {
  group_id: string | null;
  from_number: string | null;
  content: string | null;
  date_sent: string | null;
  is_outbound: boolean;
}

export function clampMessageLimit(raw: string | null): number {
  const n = raw == null || raw === "" ? 20 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(100, Math.floor(n));
}

export function toPublicMessage(msg: SendblueMessage): PublicSendblueMessage {
  const content = typeof msg.content === "string" ? msg.content.slice(0, 500) : null;
  return {
    group_id: msg.group_id ?? null,
    from_number: msg.from_number ?? msg.number ?? null,
    content,
    date_sent: msg.date_sent ?? null,
    is_outbound: msg.is_outbound === true,
  };
}

export function selectVisibleMessages(
  msgs: SendblueMessage[],
  opts: { limit: number; allowed: Set<string>; groupId?: string | null }
): PublicSendblueMessage[] {
  const groupId = opts.groupId?.trim() || "";
  return msgs
    .filter((msg) => {
      const id = msg.group_id ?? "";
      if (!id || !opts.allowed.has(id)) return false;
      if (groupId && id !== groupId) return false;
      return true;
    })
    .slice(0, opts.limit)
    .map(toPublicMessage);
}

/** How many recent messages to scan when a group filter is on. */
export function historyScanLimit(limit: number, groupId: string | null): number {
  if (!groupId) return Math.min(500, Math.max(limit, 100));
  return Math.min(500, Math.max(limit, 100));
}

export async function recentMessages(
  limit: number,
  list: (max: number) => Promise<SendblueMessage[]> = listMessages,
  opts: { allowed: Set<string>; groupId?: string | null } = { allowed: new Set() }
) {
  const groupId = opts.groupId?.trim() || null;
  const msgs = await list(historyScanLimit(limit, groupId));
  return selectVisibleMessages(msgs, { limit, allowed: opts.allowed, groupId });
}
