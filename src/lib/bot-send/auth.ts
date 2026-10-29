// Per-caller bearer tokens for the bot send API.
// BOT_SEND_TOKENS is a JSON object of sha256(token) hex → caller name.
// The raw token is never stored. Comparison walks every configured hash.

import { createHash, timingSafeEqual } from "crypto";

export type EnvLike = { [key: string]: string | undefined };

const CALLER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface BotCaller {
  caller: string;
}

export type BotAuth =
  | { ok: true; caller: string }
  | { ok: false; status: 401; error: "unauthorized" };

/** sha256 hex of the raw bearer token. */
export function hashBotToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Parse BOT_SEND_TOKENS. Malformed JSON, non-hex keys, and illegal caller
 * names are dropped. An empty result fails closed (every request is 401).
 */
export function parseBotTokens(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [hash, caller] of Object.entries(parsed)) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue;
    if (typeof caller !== "string" || !CALLER_NAME.test(caller)) continue;
    out.set(hash.toLowerCase(), caller);
  }
  return out;
}

function bearerToken(header: string | null): string {
  const value = header?.trim() ?? "";
  const prefix = "Bearer ";
  if (!value.startsWith(prefix)) return "";
  return value.slice(prefix.length).trim();
}

export function authenticateBot(
  request: { headers: { get(name: string): string | null } },
  env: EnvLike = process.env
): BotAuth {
  const tokens = parseBotTokens(env.BOT_SEND_TOKENS);
  const given = createHash("sha256").update(bearerToken(request.headers.get("authorization")), "utf8").digest();
  let caller = "";
  for (const [hex, name] of tokens) {
    const configured = Buffer.from(hex, "hex");
    if (configured.length === given.length && timingSafeEqual(given, configured)) {
      caller = name;
    }
  }
  if (!caller) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true, caller };
}

/** Bots stay dry-run unless this is exactly "true", even when SENDBLUE_LIVE is on. */
export function botSendLive(env: EnvLike = process.env): boolean {
  return env.BOT_SEND_LIVE === "true";
}

export function callerDisabled(caller: string, env: EnvLike = process.env): boolean {
  const raw = env.BOT_SEND_DISABLED_CALLERS ?? "";
  const names = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return names.includes(caller.toLowerCase());
}

export function callerHourlyCap(env: EnvLike = process.env): number {
  const raw = env.BOT_SEND_MAX_PER_CALLER_PER_HOUR;
  const n = raw == null || raw === "" ? 10 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.floor(n);
}

export function recipientDailyCap(env: EnvLike = process.env): number {
  const raw = env.BOT_SEND_MAX_PER_RECIPIENT_PER_DAY;
  const n = raw == null || raw === "" ? 2 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.floor(n);
}
