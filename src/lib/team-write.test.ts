import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTeamWrite } from "./team-write";

test("PATCH drops arbitrary fields and keeps the allowlist", () => {
  const result = sanitizeTeamWrite(
    {
      id: "mem_1",
      tier: 2,
      trellusUserId: " res_athan ",
      creditBalance: 1000000,
      cumulativeShows: 99,
      pin: "1234",
    },
    "update",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, {
    tier: 2,
    trellusUserId: "res_athan",
    pin: "1234",
  });
  assert.equal("creditBalance" in result.data, false);
});

test("empty Trellus id clears the link, and a bad PIN is rejected", () => {
  const cleared = sanitizeTeamWrite({ trellusUserId: "  " }, "update");
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.data.trellusUserId, null);

  const badPin = sanitizeTeamWrite({ pin: "12" }, "update");
  assert.equal(badPin.ok, false);
  if (!badPin.ok) assert.match(badPin.error, /PIN/);
});

test("create requires a name and a known role", () => {
  const missing = sanitizeTeamWrite({ role: "setter" }, "create");
  assert.equal(missing.ok, false);

  const badRole = sanitizeTeamWrite({ name: "Athan", role: "admin" }, "create");
  assert.equal(badRole.ok, false);

  const ok = sanitizeTeamWrite(
    { name: " Athan Pohlman ", role: "setter", slackUserId: "", excludeFromLeaderboard: false },
    "create",
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.data.name, "Athan Pohlman");
    assert.equal(ok.data.role, "setter");
    assert.equal(ok.data.slackUserId, null);
    assert.equal(ok.data.excludeFromLeaderboard, false);
  }
});

test("an update with only unknown keys is rejected", () => {
  const result = sanitizeTeamWrite({ creditBalance: 5, id: "mem_1" }, "update");
  assert.equal(result.ok, false);
});
