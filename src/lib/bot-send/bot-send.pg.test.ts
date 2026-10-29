// Real Postgres race for bot claims. Skips unless DATABASE_URL is a local
// database named sales_test. Never points at a shared database.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { prisma } from "@/lib/db";
import { sendBotMessage } from "./send";
import { parseBotSendBody } from "./validate";

function localTestUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const name = url.pathname.replace(/^\//, "");
    if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && name === "sales_test") return raw;
    return null;
  } catch {
    return null;
  }
}

test("postgres bot claims send once under parallel identical calls", async (t) => {
  const url = localTestUrl();
  if (!url) {
    t.skip("DATABASE_URL is not a local sales_test database");
    return;
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
  try {
    await client.connect();
  } catch {
    t.skip("local Postgres is not running");
    return;
  }

  try {
    const reg = await client.query(`SELECT to_regclass('"BotSend"') AS t`);
    if (!reg.rows[0]?.t) {
      throw new Error("BotSend is missing. Run prisma db push against the local sales_test database.");
    }
    const sql = fs.readFileSync(
      path.join(process.cwd(), "prisma/migrations/20261029183000_bot_sends/migration.sql"),
      "utf8"
    );
    await client.query(sql);

    await prisma.botSend.deleteMany({ where: { caller: "pgtest-bot" } });
    await prisma.confirmationRateBucket.deleteMany({
      where: { hourBucket: { startsWith: "bot:pgtest-bot:" } },
    });

    const parsed = parseBotSendBody({
      idempotencyKey: "pgtest-idem-01",
      to: "+13135550199",
      content: "postgres race",
    });
    if (!parsed.ok) throw new Error(parsed.reason);

    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        sendBotMessage("pgtest-bot", parsed.value, {
          live: true,
          botLive: true,
          now: new Date("2026-07-15T17:00:00.000Z"),
          env: {
            BOT_SEND_MAX_PER_CALLER_PER_HOUR: "20",
            BOT_SEND_MAX_PER_RECIPIENT_PER_DAY: "20",
            CONFIRMATIONS_MAX_SENDS_PER_HOUR: "30",
            BOT_SEND_CALLER_SCOPES: JSON.stringify({ "pgtest-bot": { phones: ["+13135550199"] } }),
          },
          deliver: async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { dryRun: false, messageHandle: "pg-m" };
          },
        })
      )
    );
    assert.equal(calls, 1);
    assert.equal(results.filter((r) => r.status === "sent").length, 1);
    assert.equal(results.filter((r) => r.reason === "idempotency").length, 7);
    const open = await prisma.botSend.count({
      where: { caller: "pgtest-bot", idempotencyKey: "pgtest-idem-01", status: "sent" },
    });
    assert.equal(open, 1);

    const dup = await client
      .query(
        `INSERT INTO "BotSend" (id, caller, "idempotencyKey", channel, recipient, "bodyHash", "claimKey")
         VALUES ('pgtest-dup', 'pgtest-bot', 'other', 'direct', '+13135550199', 'abc', $1)`,
        [`bot:pgtest-bot:pgtest-idem-01:live`]
      )
      .then(
        () => "inserted",
        (err: { code?: string }) => err.code || "error"
      );
    assert.equal(dup, "23505");
  } finally {
    await prisma.botSend.deleteMany({ where: { caller: "pgtest-bot" } });
    await prisma.botRecipientDay.deleteMany({ where: { recipientKey: "+13135550199" } });
    await prisma.confirmationRateBucket.deleteMany({
      where: { OR: [{ hourBucket: { startsWith: "bot:pgtest-bot:" } }, { hourBucket: "2026-07-15T17" }] },
    });
    await client.end().catch(() => undefined);
    await prisma.$disconnect();
  }
});
