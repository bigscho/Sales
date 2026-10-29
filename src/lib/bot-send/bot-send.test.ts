import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { UniqueConflict, isUniqueConflict } from "@/lib/confirmations/claim";
import { GET as sendGet, POST as sendPost } from "@/app/api/sendblue/bot-send/route";
import { GET as summaryGet } from "@/app/api/sendblue/bot-sends/route";
import { POST as messagesPost } from "@/app/api/sendblue/messages/route";
import { authenticateBot, hashBotToken, parseBotTokens } from "./auth";
import {
  CapReject,
  claimBotInTx,
  reasonForBotConflict,
  type BotClaimInput,
  type BotClaimTx,
} from "./claim";
import { clampMessageLimit, recentMessages, toPublicMessage } from "./messages";
import { deliverBotMessage, sendBotMessage, summarizeBotSends, type BotSendDeps } from "./send";
import { parseBotSendBody, type BotSendRequest } from "./validate";

const TOKEN = "test-token-chief-sdr";
const HASH = hashBotToken(TOKEN);
const NOW = new Date("2026-07-15T17:00:00.000Z");

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function headers(value: string | null) {
  return { get: () => value };
}

function body(over: Record<string, unknown> = {}): BotSendRequest {
  const payload: Record<string, unknown> = {
    idempotencyKey: "idem-key-01",
    to: "+13135550100",
    content: "Hello from the bot",
    ...over,
  };
  if (over.groupId) delete payload.to;
  const parsed = parseBotSendBody(payload);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

interface Stored {
  id: string;
  claimKey: string | null;
  bodyDedupeKey: string | null;
  recipient: string;
  bodyHash: string;
  dryRun: boolean;
  status: string;
  reason: string | null;
  createdAt: Date;
  etDay: string;
  phone: string | null;
  groupId: string | null;
}

function harness() {
  const rows: Stored[] = [];
  const daily = new Map<string, number>();
  const rates = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  const optOuts: Array<{ phone: string; groupId: string }> = [];
  const confirmations: Array<{
    phone: string | null;
    groupId: string | null;
    bodyHash: string;
    dryRun: boolean;
    etDay: string;
    createdAt: Date;
  }> = [];
  let seq = 1;

  const keyOf = (input: BotClaimInput) => `${input.recipient}\0${input.bodyHash}`;

  const tx: BotClaimTx = {
    async lockBody(input) {
      const key = keyOf(input);
      const prev = tails.get(key) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, prev.then(() => gate));
      await prev;
      releases.set(key, release);
    },
    async unlockBody(input) {
      const release = releases.get(keyOf(input));
      releases.delete(keyOf(input));
      release?.();
    },
    async findIdempotent(input) {
      await tick();
      return rows.some((r) => r.claimKey === input.claimKey && r.status !== "skipped");
    },
    async findBodyWindow(input) {
      await tick();
      const bot = rows.some(
        (r) =>
          r.status !== "skipped" &&
          r.recipient === input.recipient &&
          r.bodyHash === input.bodyHash &&
          r.dryRun === input.dryRun &&
          r.createdAt >= input.windowStart
      );
      if (bot) return true;
      return confirmations.some(
        (c) =>
          c.dryRun === input.dryRun &&
          c.bodyHash === input.bodyHash &&
          c.createdAt >= input.windowStart &&
          ((input.groupId && c.groupId === input.groupId) || (input.phone && c.phone === input.phone))
      );
    },
    async confirmationCountToday(input) {
      return confirmations.filter(
        (c) =>
          c.dryRun === input.dryRun &&
          c.etDay === input.etDay &&
          ((input.groupId && c.groupId === input.groupId) || (input.phone && c.phone === input.phone))
      ).length;
    },
    async takeDailySlot(input, room) {
      const key = `${input.recipient}:${input.etDay}:${input.dryRun}`;
      const n = daily.get(key) ?? 0;
      if (n >= room) return false;
      daily.set(key, n + 1);
      return true;
    },
    async takeGlobalSlot(input) {
      const key = `${input.hourBucket}:${input.dryRun}`;
      const n = rates.get(key) ?? 0;
      if (n >= input.globalLimit) return false;
      rates.set(key, n + 1);
      return true;
    },
    async takeCallerSlot(input) {
      const key = `${input.callerBucket}:${input.dryRun}`;
      const n = rates.get(key) ?? 0;
      if (n >= input.callerLimit) return false;
      rates.set(key, n + 1);
      return true;
    },
    async insertQueued(input) {
      await tick();
      if (input.claimKey && rows.some((r) => r.claimKey === input.claimKey)) throw new UniqueConflict("claimKey");
      if (input.bodyDedupeKey && rows.some((r) => r.bodyDedupeKey === input.bodyDedupeKey)) {
        throw new UniqueConflict("bodyDedupeKey");
      }
      const id = `b${seq++}`;
      rows.push({
        id,
        claimKey: input.claimKey,
        bodyDedupeKey: input.bodyDedupeKey,
        recipient: input.recipient,
        bodyHash: input.bodyHash,
        dryRun: input.dryRun,
        status: "queued",
        reason: null,
        createdAt: new Date(),
        etDay: input.etDay,
        phone: input.phone,
        groupId: input.groupId,
      });
      return { id };
    },
  };

  const db: NonNullable<BotSendDeps["db"]> = {
    async optedOut(phone, groupId) {
      return optOuts.some((o) => (phone && o.phone === phone) || (groupId && o.groupId === groupId));
    },
    async claim(input) {
      const undo: Array<() => void> = [];
      const wrapped: BotClaimTx = {
        ...tx,
        async takeDailySlot(i, room) {
          const ok = await tx.takeDailySlot(i, room);
          if (ok) undo.push(() => daily.set(`${i.recipient}:${i.etDay}:${i.dryRun}`, (daily.get(`${i.recipient}:${i.etDay}:${i.dryRun}`) ?? 1) - 1));
          return ok;
        },
        async takeGlobalSlot(i) {
          const ok = await tx.takeGlobalSlot(i);
          if (ok) undo.push(() => rates.set(`${i.hourBucket}:${i.dryRun}`, (rates.get(`${i.hourBucket}:${i.dryRun}`) ?? 1) - 1));
          return ok;
        },
        async takeCallerSlot(i) {
          const ok = await tx.takeCallerSlot(i);
          if (ok) undo.push(() => rates.set(`${i.callerBucket}:${i.dryRun}`, (rates.get(`${i.callerBucket}:${i.dryRun}`) ?? 1) - 1));
          return ok;
        },
      };
      try {
        return await claimBotInTx(wrapped, input);
      } catch (err) {
        while (undo.length) undo.pop()?.();
        if (err instanceof CapReject) return { ok: false, reason: err.reason };
        if (isUniqueConflict(err)) return { ok: false, reason: reasonForBotConflict((err as UniqueConflict).target) };
        throw err;
      }
    },
    async mark(id, outcome) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`missing ${id}`);
      row.status = outcome.status;
      row.dryRun = outcome.dryRun;
      row.reason = outcome.reason ?? null;
    },
    async logSkip(input, reason) {
      rows.push({
        id: `s${seq++}`,
        claimKey: null,
        bodyDedupeKey: null,
        recipient: input.recipient,
        bodyHash: input.bodyHash,
        dryRun: input.dryRun,
        status: "skipped",
        reason,
        createdAt: new Date(),
        etDay: input.etDay,
        phone: input.phone,
        groupId: input.groupId,
      });
    },
  };

  return { db, rows, optOuts, confirmations, rates, daily };
}

function env(over: Record<string, string> = {}): Record<string, string> {
  return {
    BOT_SEND_MAX_PER_CALLER_PER_HOUR: "10",
    BOT_SEND_MAX_PER_RECIPIENT_PER_DAY: "2",
    CONFIRMATIONS_MAX_SENDS_PER_HOUR: "30",
    ...over,
  };
}

function deps(h: ReturnType<typeof harness>, extra: Partial<BotSendDeps> = {}): BotSendDeps {
  return { db: h.db, env: env(), live: true, botLive: true, now: NOW, ...extra };
}

test("bot token map is hash to caller, and auth fails closed", () => {
  assert.equal(parseBotTokens(undefined).size, 0);
  assert.equal(parseBotTokens("not-json").size, 0);
  assert.equal(parseBotTokens('{"abcd":"Chief SDR"}').size, 0);
  const tokens = parseBotTokens(JSON.stringify({ [HASH.toUpperCase()]: "chief-sdr" }));
  assert.equal(tokens.get(HASH), "chief-sdr");
  assert.deepEqual(authenticateBot({ headers: headers(null) }, { BOT_SEND_TOKENS: JSON.stringify({ [HASH]: "chief-sdr" }) }), {
    ok: false,
    status: 401,
    error: "unauthorized",
  });
  assert.equal(
    authenticateBot(
      { headers: headers(`Bearer ${TOKEN}`) },
      { BOT_SEND_TOKENS: JSON.stringify({ [HASH]: "chief-sdr" }) }
    ).ok,
    true
  );
  assert.equal(
    authenticateBot(
      { headers: headers("Bearer wrong-token") },
      { BOT_SEND_TOKENS: JSON.stringify({ [HASH]: "chief-sdr" }) }
    ).ok,
    false
  );
});

test("parse accepts 1:1, group, and https media, and rejects a missing idempotency key", () => {
  const direct = parseBotSendBody({ idempotencyKey: "idem-key-01", to: "3135550100", content: "Hi" });
  assert.equal(direct.ok && direct.value.to, "+13135550100");
  assert.equal(direct.ok && direct.value.channel, "direct");
  const group = parseBotSendBody({
    idempotencyKey: "idem-key-01",
    groupId: "group-1",
    content: "",
    mediaUrl: "https://example.com/a.mp4",
  });
  assert.equal(group.ok && group.value.channel, "group");
  assert.equal(parseBotSendBody({ to: "+13135550100", content: "Hi" }).ok, false);
  assert.equal(parseBotSendBody({ idempotencyKey: "idem-key-01", to: "+13135550100", groupId: "g", content: "Hi" }).ok, false);
  assert.equal(parseBotSendBody({ idempotencyKey: "idem-key-01", groupId: "g", mediaUrl: "http://example.com/a.mp4" }).ok, false);
});

test("parallel identical calls send once", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { dryRun: false, messageHandle: "m1" };
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      sendBotMessage(
        "chief-sdr",
        body(),
        deps(h, {
          deliver,
          env: env({ BOT_SEND_MAX_PER_CALLER_PER_HOUR: "20", BOT_SEND_MAX_PER_RECIPIENT_PER_DAY: "20" }),
        })
      )
    )
  );
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === "sent").length, 1);
  assert.equal(results.filter((r) => r.reason === "idempotency").length, 4);
  assert.equal(h.rows.filter((r) => r.status === "sent").length, 1);
});

test("the same body to one recipient is deduped across idempotency keys", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const first = await sendBotMessage("chief-sdr", body(), deps(h, { deliver }));
  const second = await sendBotMessage(
    "chief-sdr",
    body({ idempotencyKey: "idem-key-02" }),
    deps(h, { deliver })
  );
  assert.equal(first.status, "sent");
  assert.equal(second.reason, "body_dedupe");
  assert.equal(calls, 1);
});

test("hourly, per-caller, and per-recipient caps skip without a provider call", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const globalEnv = env({ CONFIRMATIONS_MAX_SENDS_PER_HOUR: "1", BOT_SEND_MAX_PER_RECIPIENT_PER_DAY: "5" });
  const a = await sendBotMessage("chief-sdr", body({ to: "+13135550101", idempotencyKey: "idem-key-11" }), deps(h, { deliver, env: globalEnv }));
  const b = await sendBotMessage("solo-live", body({ to: "+13135550102", idempotencyKey: "idem-key-12", content: "other" }), deps(h, { deliver, env: globalEnv }));
  assert.equal(a.status, "sent");
  assert.equal(b.reason, "rate_cap");

  const callerEnv = env({ BOT_SEND_MAX_PER_CALLER_PER_HOUR: "1", CONFIRMATIONS_MAX_SENDS_PER_HOUR: "30" });
  const h2 = harness();
  const c1 = await sendBotMessage("chief-sdr", body({ to: "+13135550103", idempotencyKey: "idem-key-21" }), deps(h2, { deliver, env: callerEnv }));
  const c2 = await sendBotMessage("chief-sdr", body({ to: "+13135550104", idempotencyKey: "idem-key-22", content: "second" }), deps(h2, { deliver, env: callerEnv }));
  assert.equal(c1.status, "sent");
  assert.equal(c2.reason, "caller_rate_cap");

  const dayEnv = env({ BOT_SEND_MAX_PER_RECIPIENT_PER_DAY: "1" });
  const h3 = harness();
  const d1 = await sendBotMessage("chief-sdr", body(), deps(h3, { deliver, env: dayEnv }));
  const d2 = await sendBotMessage("chief-sdr", body({ idempotencyKey: "idem-key-32", content: "different copy" }), deps(h3, { deliver, env: dayEnv }));
  assert.equal(d1.status, "sent");
  assert.equal(d2.reason, "recipient_daily_cap");
  assert.equal(calls, 3);
});

test("a confirmation already sent today counts toward body dedupe and the recipient cap", async () => {
  const h = harness();
  const parsed = body();
  h.confirmations.push({
    phone: parsed.phone,
    groupId: null,
    bodyHash: parsed.bodyHash,
    dryRun: false,
    etDay: "2026-07-15",
    createdAt: NOW,
  });
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const dup = await sendBotMessage("chief-sdr", parsed, deps(h, { deliver }));
  assert.equal(dup.reason, "body_dedupe");

  const h2 = harness();
  h2.confirmations.push({
    phone: "3135550100",
    groupId: null,
    bodyHash: "different-hash",
    dryRun: false,
    etDay: "2026-07-15",
    createdAt: NOW,
  });
  const capped = await sendBotMessage(
    "chief-sdr",
    body({ content: "a different bot text" }),
    deps(h2, { deliver, env: env({ BOT_SEND_MAX_PER_RECIPIENT_PER_DAY: "1" }) })
  );
  assert.equal(capped.reason, "recipient_daily_cap");
  assert.equal(calls, 0);
});

test("opt-out and a disabled caller do not call the provider", async () => {
  const h = harness();
  h.optOuts.push({ phone: "3135550100", groupId: "" });
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const opted = await sendBotMessage("chief-sdr", body(), deps(h, { deliver }));
  assert.equal(opted.reason, "opted_out");

  const h2 = harness();
  const disabled = await sendBotMessage(
    "coach",
    body({ groupId: "g-1", content: "hi team" }),
    deps(h2, { deliver, env: env({ BOT_SEND_DISABLED_CALLERS: "solo-live, coach" }) })
  );
  assert.equal(disabled.reason, "caller_disabled");
  assert.equal(calls, 0);
  assert.equal(h2.rows.filter((r) => r.claimKey).length, 0);
});

test("kill switches dry-run even when the caller asked the harness to deliver", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "should-not-run" };
  };
  const masterOff = await sendBotMessage("chief-sdr", body(), deps(h, { deliver, live: false, botLive: true }));
  const botsOff = await sendBotMessage(
    "chief-sdr",
    body({ idempotencyKey: "idem-key-02", content: "other dry copy" }),
    deps(h, { deliver, live: true, botLive: false })
  );
  assert.equal(masterOff.status, "dry_run");
  assert.equal(botsOff.status, "dry_run");
  assert.equal(calls, 0);

  const replay = await sendBotMessage("chief-sdr", body(), deps(h, { deliver, live: false, botLive: true }));
  assert.equal(replay.reason, "idempotency");
  assert.equal(calls, 0);
});

test("a failed provider call stays claimed", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    throw new Error("gateway dropped");
  };
  const first = await sendBotMessage("chief-sdr", body(), deps(h, { deliver }));
  const second = await sendBotMessage("chief-sdr", body(), deps(h, { deliver }));
  assert.equal(first.status, "failed");
  assert.equal(first.reason, "provider");
  assert.equal(second.reason, "idempotency");
  assert.equal(calls, 1);
});

test("deliverBotMessage does not call Sendblue while SENDBLUE_LIVE is off", async () => {
  const prev = process.env.SENDBLUE_LIVE;
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  delete process.env.SENDBLUE_LIVE;
  try {
    const result = await deliverBotMessage({
      channel: "group",
      to: null,
      groupId: "g",
      content: "hi",
      mediaUrl: "https://example.com/a.mp4",
      dryRun: false,
    });
    assert.equal(result.dryRun, true);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = prevFetch;
    if (prev === undefined) delete process.env.SENDBLUE_LIVE;
    else process.env.SENDBLUE_LIVE = prev;
  }
});

test("bot-send route rejects GET, bad tokens, and a missing idempotency key", async () => {
  assert.equal((await sendGet()).status, 405);
  const prev = process.env.BOT_SEND_TOKENS;
  process.env.BOT_SEND_TOKENS = JSON.stringify({ [HASH]: "chief-sdr" });
  try {
    const anon = await sendPost(new NextRequest("http://localhost/api/sendblue/bot-send", { method: "POST" }));
    assert.equal(anon.status, 401);
    const bad = await sendPost(
      new NextRequest("http://localhost/api/sendblue/bot-send", {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "idem-key-01", to: "+13135550100", content: "Hi" }),
      })
    );
    assert.equal(bad.status, 401);
    const invalid = await sendPost(
      new NextRequest("http://localhost/api/sendblue/bot-send", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "+13135550100", content: "Hi" }),
      })
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).reason, "idempotency_key");
    const summary = await summaryGet(new NextRequest("http://localhost/api/sendblue/bot-sends"));
    assert.equal(summary.status, 401);
    assert.equal((await messagesPost()).status, 405);
  } finally {
    if (prev === undefined) delete process.env.BOT_SEND_TOKENS;
    else process.env.BOT_SEND_TOKENS = prev;
  }
});

test("message proxy trims history and does not send", async () => {
  assert.equal(clampMessageLimit("500"), 100);
  assert.equal(clampMessageLimit(null), 20);
  const trimmed = toPublicMessage({
    group_id: "g",
    content: "x".repeat(800),
    is_outbound: true,
    date_sent: "2026-07-15T00:00:00Z",
    participants: ["+13135550100"],
  });
  assert.equal(trimmed.content?.length, 500);
  assert.equal("participants" in trimmed, false);

  const listed = await recentMessages(1, async () => [
    { group_id: "g", content: "hi", is_outbound: false, date_sent: null },
    { group_id: "h", content: "second", is_outbound: true, date_sent: null },
  ]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].group_id, "g");
});

test("summary groups the last day's rows by caller", () => {
  const rows = summarizeBotSends([
    { caller: "solo-live", status: "sent", dryRun: true },
    { caller: "chief-sdr", status: "sent", dryRun: false },
    { caller: "chief-sdr", status: "skipped", dryRun: true },
    { caller: "chief-sdr", status: "failed", dryRun: false },
  ]);
  assert.deepEqual(rows, [
    { caller: "chief-sdr", sent: 1, dry_run: 0, skipped: 1, failed: 1, queued: 0 },
    { caller: "solo-live", sent: 0, dry_run: 1, skipped: 0, failed: 0, queued: 0 },
  ]);
});
