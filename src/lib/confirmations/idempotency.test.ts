import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as dayofGet, POST as dayofPost } from "../../app/api/confirmations/dayof/route";
import { GET as t1Get, POST as t1Post } from "../../app/api/confirmations/t1/route";
import {
  claimInTx,
  reasonForUniqueTarget,
  uniqueTargetOf,
  priorClaimExists,
  bodyWindowHit,
  dayOfHit,
  uniqueConflictTarget,
  UniqueConflict,
  isUniqueConflict,
  type ClaimSnapshot,
  type ClaimTx,
} from "./claim";
import {
  authorizeCron,
  bodyHash,
  dayOfAutoEnabled,
  dedupeWindowMs,
  etDayString,
  etDayWindow,
  hourBucket,
  inboundOptOutIdentity,
  isOptOutText,
  maxSendsPerHour,
  originationTextingEnabled,
  t1AutoEnabled,
} from "./guards";
import { originationLive } from "./origination";
import { deliverConfirmationMessage, sendConfirmation, type DeliverArgs, type SendDeps } from "./send";
import type { WorklistRow } from "./worklist";

const NOW = new Date("2026-07-15T17:00:00.000Z"); // 1:00 PM EDT, inside the send window

function row(over: Partial<WorklistRow> = {}): WorklistRow {
  return {
    bookingId: "b1",
    prospectName: "Ada Agent",
    prospectFirstName: "Ada",
    prospectPhone: "+13135550100",
    prospectEmail: "ada@example.com",
    demoDate: "2026-07-16T17:00:00.000Z",
    demoTimeLabel: "1:00 PM EDT",
    prospectTimezone: "America/New_York",
    closerName: null,
    setterName: null,
    inviteStatus: null,
    caseType: "single",
    addressVariable: "123 Main",
    addressSource: "calendly",
    ambiguous: false,
    emailCount: 1,
    body: "Meant to send this yesterday — here's our Grassfed testimonial. Thanks Ada.",
    variant: "standard",
    groupId: "group-1",
    sendable: true,
    skipReason: null,
    blockReason: null,
    sendStatus: "not_sent",
    sentDryRun: false,
    sentAt: null,
    ...over,
  };
}

function rateKey(input: { hourBucket: string; dryRun: boolean }): string {
  return `${input.hourBucket}:${input.dryRun ? "dry" : "live"}`;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  db: NonNullable<SendDeps["db"]>;
  rows: ClaimSnapshot[];
  optOuts: Array<{ phone: string; groupId: string }>;
}

function harness(seed: ClaimSnapshot[] = []): Harness {
  const rows = seed.map((r) => ({ ...r }));
  const rates = new Map<string, number>();
  const optOuts: Array<{ phone: string; groupId: string }> = [];
  const internal = new Set<string>();
  let seq = 1;
  const ids = new Map<string, ClaimSnapshot>();

  const tx: ClaimTx = {
    async findPrior(input) {
      await tick();
      return priorClaimExists(rows, input);
    },
    async findBodyWindow(input) {
      await tick();
      return bodyWindowHit(rows, input);
    },
    async findDayOf(input) {
      await tick();
      return dayOfHit(rows, input);
    },
    async takeRateSlot(input) {
      const key = rateKey(input);
      const n = rates.get(key) ?? 0;
      if (n >= input.rateLimit) return false;
      rates.set(key, n + 1);
      return true;
    },
    async insertQueued(input) {
      const target = uniqueConflictTarget(rows, input.row);
      if (target) throw new UniqueConflict(target);
      const snap: ClaimSnapshot = {
        bookingId: input.row.bookingId,
        touchpoint: input.row.touchpoint,
        dryRun: input.row.dryRun,
        reconnectId: input.row.reconnectId,
        status: "queued",
        groupId: input.row.groupId,
        bodyHash: input.row.bodyHash,
        body: input.row.body,
        etDay: input.row.etDay,
        createdAt: input.now,
        claimKey: input.row.claimKey,
        dayOfGroupDayKey: input.row.dayOfGroupDayKey,
        bodyDedupeKey: input.row.bodyDedupeKey,
      };
      const id = `c${seq++}`;
      rows.push(snap);
      ids.set(id, snap);
      return { id };
    },
  };

  const db: NonNullable<SendDeps["db"]> = {
    async optedOut(phone, groupId) {
      const digits = String(phone ?? "").replace(/\D/g, "").slice(-10);
      return optOuts.some((o) => (digits.length === 10 && o.phone === digits) || (!!groupId && o.groupId === groupId));
    },
    async isInternalGroup(groupId) {
      return internal.has(groupId);
    },
    async claim(input) {
      let took = false;
      const wrapped: ClaimTx = {
        findPrior: (i) => tx.findPrior(i),
        findBodyWindow: (i) => tx.findBodyWindow(i),
        findDayOf: (i) => tx.findDayOf(i),
        insertQueued: (i) => tx.insertQueued(i),
        async takeRateSlot(i) {
          const ok = await tx.takeRateSlot(i);
          if (ok) took = true;
          return ok;
        },
      };
      try {
        return await claimInTx(wrapped, input);
      } catch (err) {
        if (took && isUniqueConflict(err)) {
          const key = rateKey(input);
          rates.set(key, Math.max(0, (rates.get(key) ?? 1) - 1));
        }
        if (isUniqueConflict(err)) return { ok: false, reason: reasonForUniqueTarget(uniqueTargetOf(err)) };
        throw err;
      }
    },
    async mark(id, outcome) {
      const snap = ids.get(id);
      if (!snap) throw new Error(`missing claim ${id}`);
      snap.status = outcome.status;
    },
    async logUnclaimed(unclaimed) {
      rows.push({
        bookingId: unclaimed.bookingId,
        touchpoint: unclaimed.touchpoint,
        dryRun: unclaimed.dryRun,
        reconnectId: unclaimed.reconnectId,
        status: "skipped",
        groupId: unclaimed.groupId,
        bodyHash: unclaimed.bodyHash,
        body: unclaimed.body,
        etDay: unclaimed.etDay,
        createdAt: new Date(),
        claimKey: null,
        dayOfGroupDayKey: null,
        bodyDedupeKey: null,
      });
    },
  };

  return { db, rows, optOuts };
}

function deps(h: Harness, extra: Partial<SendDeps> = {}): SendDeps {
  return { db: h.db, live: true, now: NOW, pauseMs: 0, ...extra };
}

test("five parallel sends of one booking produce one provider call", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { dryRun: false, messageHandle: "m1" };
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => sendConfirmation(row(), "day_of", {}, deps(h, { deliver })))
  );
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === "sent").length, 1);
  assert.equal(results.filter((r) => r.status === "skipped").length, 4);
  const open = h.rows.filter((r) => r.status === "sent" || r.status === "queued" || r.status === "failed");
  assert.equal(open.length, 1);
});

test("five parallel runs across three groups send once per group", async () => {
  const h = harness();
  const sent: string[] = [];
  const deliver = async (args: DeliverArgs) => {
    sent.push(args.groupId);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { dryRun: false, messageHandle: args.groupId };
  };
  const groups = ["g1", "g2", "g3"];
  await Promise.all(
    groups.flatMap((groupId) =>
      Array.from({ length: 5 }, (_, i) =>
        sendConfirmation(
          row({ bookingId: `${groupId}-${i}`, groupId, body: `Hello ${groupId}` }),
          "day_of",
          {},
          deps(h, { deliver })
        )
      )
    )
  );
  assert.equal(sent.length, 3);
  assert.deepEqual([...sent].sort(), ["g1", "g2", "g3"]);
});

test("five different bookings in one group still send one day-of text", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { dryRun: false, messageHandle: "m" };
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      sendConfirmation(
        row({ bookingId: `b${i}`, body: `Different copy ${i}`, prospectPhone: `+1313555010${i}` }),
        "day_of",
        {},
        deps(h, { deliver })
      )
    )
  );
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === "sent").length, 1);
  for (const skipped of results.filter((r) => r.status !== "sent")) {
    assert.equal(skipped.error, "dayof_cap");
  }
});

test("same body to one group is deduped across bookings even when it is not day-of", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const body = "Email counts are done for tomorrow.";
  const results = await Promise.all([
    sendConfirmation(row({ bookingId: "a", body }), "t1", {}, deps(h, { deliver })),
    sendConfirmation(row({ bookingId: "b", body }), "t1", {}, deps(h, { deliver })),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.error === "body_dedupe").length, 1);
});

test("default hourly cap is 30 and the 31st send is skipped", async () => {
  assert.equal(maxSendsPerHour({}), 30);
  assert.equal(maxSendsPerHour({ CONFIRMATIONS_MAX_SENDS_PER_HOUR: "12" }), 12);
  assert.equal(dedupeWindowMs({}), 24 * 60 * 60 * 1000);

  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const results = await Promise.all(
    Array.from({ length: 31 }, (_, i) =>
      sendConfirmation(
        row({ bookingId: `b${i}`, groupId: `g${i}`, body: `body ${i}` }),
        "t1",
        {},
        deps(h, { deliver, rateLimit: maxSendsPerHour({}) })
      )
    )
  );
  assert.equal(calls, 30);
  assert.equal(results.filter((r) => r.status === "sent").length, 30);
  assert.equal(results.filter((r) => r.error === "rate_cap").length, 1);
});

test("opt-out by phone or group skips before any send", async () => {
  const h = harness();
  h.optOuts.push({ phone: "3135550100", groupId: "" });
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const byPhone = await sendConfirmation(row(), "day_of", {}, deps(h, { deliver }));
  assert.equal(byPhone.status, "skipped");
  assert.equal(byPhone.error, "opted_out");

  const allowed = await sendConfirmation(
    row({ bookingId: "other", prospectPhone: "+19995550199", groupId: "open-group", body: "other body" }),
    "t1",
    {},
    deps(h, { deliver })
  );
  h.optOuts.push({ phone: "", groupId: "blocked-group" });
  const blocked = await sendConfirmation(
    row({ bookingId: "third", prospectPhone: "+19995550198", groupId: "blocked-group", body: "third body" }),
    "t1",
    {},
    deps(h, { deliver })
  );
  assert.equal(allowed.status, "sent");
  assert.equal(blocked.error, "opted_out");
  assert.equal(calls, 1);
});

test("a failed send stays claimed and is not sent again", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    throw new Error("gateway dropped");
  };
  const first = await sendConfirmation(row(), "day_of", {}, deps(h, { deliver }));
  const second = await sendConfirmation(row(), "day_of", {}, deps(h, { deliver }));
  assert.equal(first.status, "failed");
  assert.equal(first.error, "gateway dropped");
  assert.equal(second.status, "skipped");
  assert.equal(second.error, "already_claimed");
  assert.equal(calls, 1);
  assert.equal(h.rows.filter((r) => r.status === "failed").length, 1);
});

test("dry-run logs group, touchpoint, and body hash and does not call Sendblue", async () => {
  const h = harness();
  const logs: string[] = [];
  let calls = 0;
  const body = row().body;
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      sendConfirmation(
        row(),
        "day_of",
        { forceDryRun: true },
        {
          ...deps(h, { live: true }),
          io: {
            live: true,
            log: (line) => logs.push(line),
            sendGroup: async () => {
              calls++;
              throw new Error("sendblue should not be called");
            },
          },
        }
      )
    )
  );
  assert.equal(calls, 0);
  assert.equal(results.filter((r) => r.status === "sent" && r.dryRun).length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /confirmation dry-run groupId=group-1 touchpoint=day_of/);
  assert.match(logs[0], new RegExp(`bodyHash=${bodyHash(body)}`));
});

test("SENDBLUE_LIVE off is a dry-run even when the caller asked for a live deliver", async () => {
  const logs: string[] = [];
  let calls = 0;
  const result = await deliverConfirmationMessage(
    {
      groupId: "group-9",
      touchpoint: "t1",
      body: "hello",
      dryRun: false,
      mediaUrl: "https://example.com/video.mp4",
    },
    {
      live: false,
      log: (line) => logs.push(line),
      sendGroup: async () => {
        calls++;
        return { status: "sent", dryRun: false };
      },
    }
  );
  assert.equal(calls, 0);
  assert.equal(result.dryRun, true);
  assert.match(logs[0], /groupId=group-9 touchpoint=t1/);
  assert.match(logs[0], new RegExp(`bodyHash=${bodyHash("hello")}`));
});

test("a live day-of deliver sends the video and then the text", async () => {
  const seen: Array<{ content: string; mediaUrl?: string }> = [];
  await deliverConfirmationMessage(
    {
      groupId: "group-9",
      touchpoint: "day_of",
      body: "hello",
      dryRun: false,
      mediaUrl: "https://example.com/video.mp4",
      pauseMs: 0,
    },
    {
      live: true,
      sendGroup: async (opts) => {
        seen.push({ content: opts.content, mediaUrl: opts.mediaUrl });
        return { status: "sent", dryRun: false, messageHandle: "h" };
      },
    }
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[0].mediaUrl, "https://example.com/video.mp4");
  assert.equal(seen[0].content, "");
  assert.equal(seen[1].content, "hello");
});

test("quiet hours and missing groups do not claim or send", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const quiet = await sendConfirmation(
    row(),
    "day_of",
    {},
    deps(h, { deliver, now: new Date("2026-07-15T07:00:00.000Z") })
  );
  assert.equal(quiet.status, "deferred");
  assert.equal(calls, 0);
  assert.equal(h.rows.length, 0);

  const missing = await sendConfirmation(row({ groupId: null }), "t1", {}, deps(h, { deliver }));
  assert.equal(missing.error, "no_group");
  assert.equal(calls, 0);
});

test("a legacy day-of row without etDay still blocks that group for the Eastern day", async () => {
  const window = etDayWindow("2026-07-15");
  const legacy: ClaimSnapshot = {
    bookingId: "old",
    touchpoint: "day_of",
    dryRun: false,
    reconnectId: null,
    status: "sent",
    groupId: "group-1",
    bodyHash: null,
    body: "older copy",
    etDay: null,
    createdAt: new Date(window.start.getTime() + 60 * 60 * 1000),
    claimKey: null,
    dayOfGroupDayKey: null,
    bodyDedupeKey: null,
  };
  const h = harness([legacy]);
  let calls = 0;
  const res = await sendConfirmation(
    row({ bookingId: "new", body: "brand new copy" }),
    "day_of",
    {},
    deps(h, {
      deliver: async () => {
        calls++;
        return { dryRun: false, messageHandle: "m" };
      },
    })
  );
  assert.equal(res.error, "dayof_cap");
  assert.equal(calls, 0);
});

test("t1 and day-of for the same booking are different claims", async () => {
  const h = harness();
  let calls = 0;
  const deliver = async () => {
    calls++;
    return { dryRun: false, messageHandle: "m" };
  };
  const t1 = await sendConfirmation(row({ body: "t1 copy" }), "t1", {}, deps(h, { deliver }));
  const day = await sendConfirmation(row({ body: "day copy" }), "day_of", {}, deps(h, { deliver }));
  assert.equal(t1.status, "sent");
  assert.equal(day.status, "sent");
  assert.equal(calls, 2);
});

test("auto-send flags default off", () => {
  assert.equal(dayOfAutoEnabled({}), false);
  assert.equal(dayOfAutoEnabled({ CONFIRMATIONS_DAYOF_AUTO: "false" }), false);
  assert.equal(dayOfAutoEnabled({ CONFIRMATIONS_DAYOF_AUTO: "true" }), true);
  assert.equal(t1AutoEnabled({}), false);
  assert.equal(t1AutoEnabled({ CONFIRMATIONS_AUTO_SEND: "true" }), true);
  assert.equal(originationTextingEnabled({}), false);
  assert.equal(originationTextingEnabled({ CONFIRMATIONS_ORIGINATION_LIVE: "true" }), true);
  const prev = process.env.CONFIRMATIONS_ORIGINATION_LIVE;
  delete process.env.CONFIRMATIONS_ORIGINATION_LIVE;
  try {
    assert.equal(originationLive(), false);
  } finally {
    if (prev === undefined) delete process.env.CONFIRMATIONS_ORIGINATION_LIVE;
    else process.env.CONFIRMATIONS_ORIGINATION_LIVE = prev;
  }
});

test("opt-out phrases match STOP and miss ordinary sentences", () => {
  assert.equal(isOptOutText("STOP"), true);
  assert.equal(isOptOutText("Stop."), true);
  assert.equal(isOptOutText("unsubscribe"), true);
  assert.equal(isOptOutText("please no more texts"), true);
  assert.equal(isOptOutText("Can you stop by the office tomorrow morning?"), false);
  assert.equal(isOptOutText("I need to stop"), false);
  const ident = inboundOptOutIdentity({
    content: "STOP",
    fromNumber: "+1 (313) 555-0100",
    groupId: "g",
  });
  assert.deepEqual(ident, { phone: "3135550100", groupId: "g", reason: "stop", source: "sendblue_inbound" });
  assert.equal(inboundOptOutIdentity({ content: "see you then", fromNumber: "+13135550100", groupId: "g" }), null);
  assert.equal(inboundOptOutIdentity({ optedOut: true, fromNumber: "+13135550100", groupId: "g" })?.reason, "opted_out");
});

test("Eastern day window covers midnight EDT and EST", () => {
  assert.equal(etDayString(NOW), "2026-07-15");
  const summer = etDayWindow("2026-07-15");
  assert.equal(summer.start.toISOString(), "2026-07-15T04:00:00.000Z");
  const winter = etDayWindow("2026-01-15");
  assert.equal(winter.start.toISOString(), "2026-01-15T05:00:00.000Z");
  assert.equal(hourBucket(NOW), "2026-07-15T17");
});

test("cron auth requires a bearer secret and rejects GET", () => {
  const headers = (value: string | null) => ({ get: () => value });
  assert.deepEqual(authorizeCron({ method: "GET", headers: headers(null) }, "s3cret"), {
    ok: false,
    status: 405,
    error: "method_not_allowed",
  });
  const missing = authorizeCron({ method: "POST", headers: headers(null) }, undefined);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, "cron_secret_unconfigured");
  const wrong = authorizeCron({ method: "POST", headers: headers("Bearer no") }, "s3cret");
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.status, 401);
  assert.equal(authorizeCron({ method: "POST", headers: headers("Bearer s3cret") }, "s3cret").ok, true);
  assert.equal(authorizeCron({ method: "POST", headers: headers("Bearer s3cret-extra") }, "s3cret").ok, false);
});

test("day-of and t1 routes reject GET and unauthenticated POST", async () => {
  assert.equal((await dayofGet()).status, 405);
  assert.equal((await t1Get()).status, 405);

  const prev = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const day = await dayofPost(new NextRequest("http://localhost/api/confirmations/dayof", { method: "POST" }));
    const t1 = await t1Post(new NextRequest("http://localhost/api/confirmations/t1", { method: "POST" }));
    assert.equal(day.status, 401);
    assert.equal(t1.status, 401);
    assert.equal((await day.json()).error, "cron_secret_unconfigured");
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }

  process.env.CRON_SECRET = "test-secret";
  try {
    const denied = await dayofPost(
      new NextRequest("http://localhost/api/confirmations/dayof", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      })
    );
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error, "unauthorized");
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});
