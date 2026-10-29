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

export async function recentMessages(limit: number, list: (max: number) => Promise<SendblueMessage[]> = listMessages) {
  const msgs = await list(limit);
  return msgs.slice(0, limit).map(toPublicMessage);
}
