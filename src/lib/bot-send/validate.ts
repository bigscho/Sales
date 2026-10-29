// Request shape for POST /api/sendblue/bot-send. No Sendblue calls.

import { createHash } from "crypto";
import { optOutPhone } from "@/lib/confirmations/guards";

const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,128}$/;

export interface BotSendRequest {
  idempotencyKey: string;
  channel: "direct" | "group";
  /** E.164, set for a 1:1. */
  to: string | null;
  /** Last 10 digits, set for a 1:1. */
  phone: string | null;
  groupId: string | null;
  /** Phone or group id. This is the dedupe and daily-cap identity. */
  recipient: string;
  content: string;
  mediaUrl: string | null;
  bodyHash: string;
}

export type ParseResult = { ok: true; value: BotSendRequest } | { ok: false; reason: string };

function asRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** US 10-digit numbers become +1. Longer numbers must already include +. */
export function normalizeBotPhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

function httpsUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return url.toString();
}

export function payloadHash(content: string, mediaUrl: string | null): string {
  return createHash("sha256").update(`${content}\n${mediaUrl ?? ""}`, "utf8").digest("hex");
}

export function parseBotSendBody(body: unknown): ParseResult {
  const rec = asRecord(body);
  if (!rec) return { ok: false, reason: "invalid_body" };

  const idempotencyKey = typeof rec.idempotencyKey === "string" ? rec.idempotencyKey.trim() : "";
  if (!IDEMPOTENCY.test(idempotencyKey)) return { ok: false, reason: "idempotency_key" };

  const hasTo = typeof rec.to === "string" && rec.to.trim().length > 0;
  const hasGroup = typeof rec.groupId === "string" && rec.groupId.trim().length > 0;
  if (hasTo === hasGroup) return { ok: false, reason: "recipient" };

  let to: string | null = null;
  let phone: string | null = null;
  let groupId: string | null = null;
  let recipient = "";
  let channel: "direct" | "group";
  if (hasTo) {
    to = normalizeBotPhone(String(rec.to));
    phone = optOutPhone(to);
    if (!to || !phone) return { ok: false, reason: "recipient" };
    recipient = to;
    channel = "direct";
  } else {
    groupId = String(rec.groupId).trim();
    if (groupId.length > 200 || /[\r\n]/.test(groupId)) return { ok: false, reason: "recipient" };
    recipient = groupId;
    channel = "group";
  }

  const content = typeof rec.content === "string" ? rec.content : "";
  if (content.length > 4000) return { ok: false, reason: "content" };
  let mediaUrl: string | null = null;
  if (typeof rec.mediaUrl === "string" && rec.mediaUrl.trim()) {
    mediaUrl = httpsUrl(rec.mediaUrl);
    if (!mediaUrl) return { ok: false, reason: "media_url" };
  }
  if (!content.trim() && !mediaUrl) return { ok: false, reason: "content" };

  return {
    ok: true,
    value: {
      idempotencyKey,
      channel,
      to,
      phone,
      groupId,
      recipient,
      content,
      mediaUrl,
      bodyHash: payloadHash(content, mediaUrl),
    },
  };
}
