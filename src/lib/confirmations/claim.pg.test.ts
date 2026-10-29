// Real Postgres checks for the claim. Skips unless DATABASE_URL points at a
// local database named sales_test, so `npm test` never touches a shared DB.
// Apply the Prisma schema there first: `npx prisma db push`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { prisma } from "@/lib/db";
import { claimWithPrisma, type ClaimInput, type ClaimRow } from "./claim";
import { bodyDedupeKeyFor, bodyHash, claimKeyFor, dayOfGroupDayKeyFor, etDayString, etDayWindow } from "./guards";

const MIGRATION = path.join(
  process.cwd(),
  "prisma/migrations/20261029160000_confirmation_send_claims/migration.sql"
);

function localTestUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname;
    const name = url.pathname.replace(/^\//, "");
    if ((host === "127.0.0.1" || host === "localhost") && name === "sales_test") return raw;
    return null;
  } catch {
    return null;
  }
}

async function canConnect(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
  try {
    await client.connect();
    const reg = await client.query(`SELECT to_regclass('"ConfirmationSend"') AS t`);
    if (!reg.rows[0]?.t) {
      throw new Error("ConfirmationSend is missing. Run prisma db push against the local sales_test database.");
    }
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes("ConfirmationSend is missing")) throw err;
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function rowFor(input: {
  bookingId: string;
  touchpoint: string;
  groupId: string;
  body: string;
  etDay: string;
  dryRun: boolean;
  hourBucket: string;
  rateLimit: number;
  now: Date;
}): ClaimInput {
  const hash = bodyHash(input.body);
  const window = etDayWindow(input.etDay);
  const claimKey = claimKeyFor({
    bookingId: input.bookingId,
    touchpoint: input.touchpoint,
    dryRun: input.dryRun,
  });
  const row: ClaimRow = {
    bookingId: input.bookingId,
    prospectEmail: null,
    prospectPhone: null,
    touchpoint: input.touchpoint,
    variant: null,
    addressSource: null,
    body: input.body,
    groupId: input.groupId,
    error: null,
    edited: false,
    autoSent: false,
    approvedBy: null,
    dryRun: input.dryRun,
    reconnectId: null,
    claimKey,
    dayOfGroupDayKey:
      input.touchpoint === "day_of" ? dayOfGroupDayKeyFor(input.groupId, input.etDay, input.dryRun) : null,
    bodyDedupeKey: bodyDedupeKeyFor(input.groupId, hash, input.etDay, input.dryRun),
    bodyHash: hash,
    etDay: input.etDay,
  };
  return {
    bookingId: input.bookingId,
    touchpoint: input.touchpoint,
    dryRun: input.dryRun,
    reconnectId: null,
    groupId: input.groupId,
    bodyHash: hash,
    etDay: input.etDay,
    etDayStart: window.start,
    etDayEnd: window.end,
    hourBucket: input.hourBucket,
    rateLimit: input.rateLimit,
    windowStart: new Date(input.now.getTime() - 24 * 60 * 60 * 1000),
    now: input.now,
    row,
  };
}

test("postgres claim constraints, backfill, and the rate bucket", async (t) => {
  const url = localTestUrl();
  if (!url) {
    t.skip("DATABASE_URL is not a local sales_test database");
    return;
  }
  if (!(await canConnect(url))) {
    t.skip("local Postgres is not running");
    return;
  }

  const pool = new Pool({ connectionString: url, max: 20 });
  const client = await pool.connect();
  let released = false;
  const releaseClient = () => {
    if (!released) {
      client.release();
      released = true;
    }
  };
  try {
    const sample = "Thanks Ada — video 🎥";
    const hashed = await client.query(
      `SELECT encode(digest(convert_to($1, 'UTF8'), 'sha256'), 'hex') AS h`,
      [sample]
    );
    assert.equal(hashed.rows[0].h, bodyHash(sample));

    const noonBefore = "2026-07-15 03:30:00";
    const et = await client.query(
      `SELECT to_char(($1::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d`,
      [noonBefore]
    );
    assert.equal(et.rows[0].d, etDayString(new Date("2026-07-15T03:30:00.000Z")));

    await prisma.confirmationSend.deleteMany({ where: { bookingId: { startsWith: "pgtest-" } } });
    await prisma.booking.deleteMany({ where: { id: { startsWith: "pgtest-" } } });
    await prisma.week.deleteMany({ where: { id: "pgtest-week" } });
    await prisma.confirmationRateBucket.deleteMany({ where: { hourBucket: { startsWith: "pgtest-" } } });

    await prisma.week.create({
      data: {
        id: "pgtest-week",
        weekStart: new Date("2026-07-13T00:00:00.000Z"),
        weekEnd: new Date("2026-07-20T00:00:00.000Z"),
      },
    });
    const bookingIds = [
      "pgtest-hist",
      "pgtest-held",
      "pgtest-nongroup",
      "pgtest-same",
      "pgtest-w0",
      "pgtest-w1",
      ...Array.from({ length: 8 }, (_, i) => `pgtest-d${i}`),
    ];
    for (const id of bookingIds) {
      await prisma.booking.create({
        data: {
          id,
          weekId: "pgtest-week",
          prospectName: "Pg Test",
          demoDate: new Date("2026-07-16T17:00:00.000Z"),
        },
      });
    }

    const histBody = "Hello group";
    await prisma.confirmationSend.createMany({
      data: [
        {
          id: "pgtest-h1",
          bookingId: "pgtest-hist",
          touchpoint: "day_of",
          body: histBody,
          status: "sent",
          dryRun: false,
          groupId: "pgtest-g-hist",
          createdAt: new Date("2026-07-15T14:00:00.000Z"),
        },
        {
          id: "pgtest-h2",
          bookingId: "pgtest-hist",
          touchpoint: "day_of",
          body: histBody,
          status: "sent",
          dryRun: false,
          groupId: "pgtest-g-hist",
          createdAt: new Date("2026-07-15T15:00:00.000Z"),
        },
        {
          id: "pgtest-h3",
          bookingId: "pgtest-hist",
          touchpoint: "day_of",
          body: histBody,
          status: "failed",
          dryRun: false,
          groupId: "pgtest-g-hist",
          createdAt: new Date("2026-07-15T16:00:00.000Z"),
        },
      ],
    });

    const heldBody = "Held copy";
    const heldAt = new Date("2026-07-15T16:00:00.000Z");
    const heldDay = etDayString(heldAt);
    const heldHash = bodyHash(heldBody);
    const heldClaim = claimKeyFor({ bookingId: "pgtest-held", touchpoint: "day_of", dryRun: false });
    const heldDayKey = dayOfGroupDayKeyFor("pgtest-g-held", heldDay, false);
    const heldBodyKey = bodyDedupeKeyFor("pgtest-g-held", heldHash, heldDay, false);
    await prisma.confirmationSend.createMany({
      data: [
        {
          id: "pgtest-held-new",
          bookingId: "pgtest-held",
          touchpoint: "day_of",
          body: heldBody,
          status: "sent",
          dryRun: false,
          groupId: "pgtest-g-held",
          createdAt: heldAt,
          etDay: heldDay,
          bodyHash: heldHash,
          claimKey: heldClaim,
          dayOfGroupDayKey: heldDayKey,
          bodyDedupeKey: heldBodyKey,
        },
        {
          id: "pgtest-held-old",
          bookingId: "pgtest-held",
          touchpoint: "day_of",
          body: heldBody,
          status: "sent",
          dryRun: false,
          groupId: "pgtest-g-held",
          createdAt: new Date("2026-07-15T15:00:00.000Z"),
        },
      ],
    });
    await prisma.confirmationSend.create({
      data: {
        id: "pgtest-nongroup-row",
        bookingId: "pgtest-nongroup",
        touchpoint: "day_of",
        body: "no group",
        status: "sent",
        dryRun: false,
        groupId: null,
        createdAt: new Date("2026-07-15T15:00:00.000Z"),
      },
    });

    const sql = fs.readFileSync(MIGRATION, "utf8");
    async function runMigration(): Promise<void> {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    await runMigration();
    await runMigration();

    const hist = await prisma.confirmationSend.findMany({
      where: { bookingId: "pgtest-hist" },
      orderBy: { id: "asc" },
    });
    const keyed = hist.filter((r) => r.claimKey);
    assert.equal(keyed.length, 1);
    assert.equal(keyed[0].id, "pgtest-h1");
    assert.equal(keyed[0].claimKey, claimKeyFor({ bookingId: "pgtest-hist", touchpoint: "day_of", dryRun: false }));
    assert.equal(hist.filter((r) => r.dayOfGroupDayKey).length, 1);
    assert.equal(hist.filter((r) => r.bodyDedupeKey).length, 1);
    assert.equal(keyed[0].bodyHash, bodyHash(histBody));
    assert.equal(keyed[0].etDay, etDayString(new Date("2026-07-15T14:00:00.000Z")));

    const heldOld = await prisma.confirmationSend.findUniqueOrThrow({ where: { id: "pgtest-held-old" } });
    const heldNew = await prisma.confirmationSend.findUniqueOrThrow({ where: { id: "pgtest-held-new" } });
    assert.equal(heldOld.claimKey, null);
    assert.equal(heldOld.dayOfGroupDayKey, null);
    assert.equal(heldOld.bodyDedupeKey, null);
    assert.equal(heldNew.claimKey, heldClaim);
    assert.equal(await prisma.confirmationSend.count({ where: { claimKey: heldClaim } }), 1);

    const noGroup = await prisma.confirmationSend.findUniqueOrThrow({ where: { id: "pgtest-nongroup-row" } });
    assert.ok(noGroup.claimKey);
    assert.equal(noGroup.dayOfGroupDayKey, null);

    const dup = await client.query(
      `INSERT INTO "ConfirmationSend" (id, "bookingId", touchpoint, body, status, "dryRun", "claimKey")
       VALUES ('pgtest-dup', 'pgtest-hist', 'day_of', 'x', 'queued', false, $1)`,
      [keyed[0].claimKey]
    ).then(
      () => "inserted",
      (err: { code?: string }) => err.code || "error"
    );
    assert.equal(dup, "23505");
    releaseClient();

    const now = new Date();
    const sameInput = rowFor({
      bookingId: "pgtest-same",
      touchpoint: "day_of",
      groupId: "pgtest-g-same",
      body: "same booking",
      etDay: etDayString(now),
      dryRun: false,
      hourBucket: "pgtest-same",
      rateLimit: 100,
      now,
    });
    const sameResults = await Promise.all(Array.from({ length: 8 }, () => claimWithPrisma(sameInput)));
    assert.equal(sameResults.filter((r) => r.ok).length, 1);
    assert.equal(await prisma.confirmationSend.count({ where: { claimKey: sameInput.row.claimKey } }), 1);
    const sameBucket = await prisma.confirmationRateBucket.findUnique({
      where: { hourBucket_dryRun: { hourBucket: "pgtest-same", dryRun: false } },
    });
    assert.equal(sameBucket?.count, 1);

    const dayBody = "one day-of for the group";
    const dayResults = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimWithPrisma(
          rowFor({
            bookingId: `pgtest-d${i}`,
            touchpoint: "day_of",
            groupId: "pgtest-g-day",
            body: dayBody,
            etDay: etDayString(now),
            dryRun: false,
            hourBucket: "pgtest-day",
            rateLimit: 100,
            now,
          })
        )
      )
    );
    assert.equal(dayResults.filter((r) => r.ok).length, 1);
    assert.equal(
      await prisma.confirmationSend.count({
        where: { dayOfGroupDayKey: dayOfGroupDayKeyFor("pgtest-g-day", etDayString(now), false) },
      }),
      1
    );

    const windowBody = "same words across midnight";
    const windowResults = await Promise.all([
      claimWithPrisma(
        rowFor({
          bookingId: "pgtest-w0",
          touchpoint: "t1",
          groupId: "pgtest-g-win",
          body: windowBody,
          etDay: "2026-07-14",
          dryRun: false,
          hourBucket: "pgtest-window",
          rateLimit: 100,
          now,
        })
      ),
      claimWithPrisma(
        rowFor({
          bookingId: "pgtest-w1",
          touchpoint: "t1",
          groupId: "pgtest-g-win",
          body: windowBody,
          etDay: "2026-07-15",
          dryRun: false,
          hourBucket: "pgtest-window",
          rateLimit: 100,
          now,
        })
      ),
    ]);
    assert.equal(windowResults.filter((r) => r.ok).length, 1);

    const limit = 5;
    const taken = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const rows = await c.query(
            `INSERT INTO "ConfirmationRateBucket" ("hourBucket", "dryRun", "count")
             VALUES ('pgtest-cap', false, 1)
             ON CONFLICT ("hourBucket", "dryRun") DO UPDATE
             SET "count" = "ConfirmationRateBucket"."count" + 1
             WHERE "ConfirmationRateBucket"."count" < $1
             RETURNING "count"`,
            [limit]
          );
          await c.query("COMMIT");
          return (rows.rowCount ?? 0) > 0;
        } catch (err) {
          await c.query("ROLLBACK");
          throw err;
        } finally {
          c.release();
        }
      })
    );
    assert.equal(taken.filter(Boolean).length, limit);
    const cap = await prisma.confirmationRateBucket.findUnique({
      where: { hourBucket_dryRun: { hourBucket: "pgtest-cap", dryRun: false } },
    });
    assert.equal(cap?.count, limit);

    const raceKey = "booking:pgtest-same:t1:live";
    const raced = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query(
            `INSERT INTO "ConfirmationSend"
              (id, "bookingId", touchpoint, body, status, "dryRun", "groupId", "claimKey")
             VALUES ($1, 'pgtest-same', 't1', 'race', 'queued', false, 'pgtest-g-race', $2)`,
            [`pgtest-race-${i}`, raceKey]
          );
          await c.query("COMMIT");
          return "ok";
        } catch (err) {
          await c.query("ROLLBACK");
          const code = typeof err === "object" && err && "code" in err ? (err as { code: string }).code : "";
          if (code === "23505") return "conflict";
          throw err;
        } finally {
          c.release();
        }
      })
    );
    assert.equal(raced.filter((r) => r === "ok").length, 1);
    assert.equal(await prisma.confirmationSend.count({ where: { claimKey: raceKey } }), 1);
  } finally {
    releaseClient();
    await pool.end();
    await prisma.confirmationSend.deleteMany({ where: { bookingId: { startsWith: "pgtest-" } } });
    await prisma.booking.deleteMany({ where: { id: { startsWith: "pgtest-" } } });
    await prisma.week.deleteMany({ where: { id: "pgtest-week" } });
    await prisma.confirmationRateBucket.deleteMany({ where: { hourBucket: { startsWith: "pgtest-" } } });
    await prisma.$disconnect();
  }
});
