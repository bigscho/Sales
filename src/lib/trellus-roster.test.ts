import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUnmappedSeats,
  extractRosterUsers,
  parseUnmappedResourceIds,
  suggestSetterForTrellusUser,
  type SuggestableMember,
} from "./trellus-roster";

const ATHAN: SuggestableMember = {
  id: "setter-athan",
  name: "Athan Pohlman",
  email: "athan@grsfd.co",
  role: "setter",
  isActive: true,
  trellusUserId: null,
};
const CHRIS: SuggestableMember = {
  id: "setter-chris",
  name: "Chris Carr",
  email: null,
  role: "setter",
  isActive: true,
  trellusUserId: null,
};
const CHRISTIAN: SuggestableMember = {
  id: "setter-christian",
  name: "Christian",
  email: "christian@grsfd.co",
  role: "setter",
  isActive: true,
  trellusUserId: null,
};

test("bootstrap payloads yield user id, name, and email", () => {
  const users = extractRosterUsers({
    user: {
      user_id: "res_admin",
      user_name: "Office",
      platform_email: "office@grsfd.co",
      is_authenticated_user: true,
    },
    directory: [
      { user_id: "res_athan", user_name: "Athan Pohlman", platform_email: "athan@grsfd.co" },
      { resource_id: "res_chris", name: "Chris Carr" },
    ],
    team: { id: "team_1", name: "Grassfed" },
  });
  assert.deepEqual(
    users.map((u) => u.id).sort(),
    ["res_admin", "res_athan", "res_chris"],
  );
  assert.equal(users.find((u) => u.id === "res_athan")?.email, "athan@grsfd.co");
  assert.equal(users.find((u) => u.id === "res_chris")?.name, "Chris Carr");
});

test("sync log unmapped ids parse, and other error text does not", () => {
  assert.deepEqual(
    parseUnmappedResourceIds('unmapped resource_ids: {"res_athan":12,"res_chris":3}'),
    { res_athan: 12, res_chris: 3 },
  );
  assert.deepEqual(parseUnmappedResourceIds("Trellus session-list 500: boom"), {});
  assert.deepEqual(parseUnmappedResourceIds(null), {});
});

test("suggestions are exact name, email, or alias — not a fuzzy name", () => {
  const members = [ATHAN, CHRIS, CHRISTIAN];
  assert.deepEqual(suggestSetterForTrellusUser({ name: "Athan Pohlman", email: null }, members), {
    memberId: ATHAN.id,
    memberName: ATHAN.name,
    reason: "name",
  });
  assert.equal(
    suggestSetterForTrellusUser({ name: "Someone Else", email: "athan@grsfd.co" }, members)?.memberId,
    ATHAN.id,
  );
  assert.equal(suggestSetterForTrellusUser({ name: "AP", email: null }, members)?.memberId, ATHAN.id);
  assert.equal(suggestSetterForTrellusUser({ name: "CC", email: null }, members)?.reason, "alias");
  assert.equal(suggestSetterForTrellusUser({ name: "Chris", email: null }, members)?.memberId, CHRIS.id);
  assert.equal(suggestSetterForTrellusUser({ name: "Chriszel", email: null }, members), null);
  assert.equal(suggestSetterForTrellusUser({ name: "Christian P", email: null }, members), null);
});

test("a setter who already has a Trellus id is not suggested", () => {
  const linked = { ...ATHAN, trellusUserId: "res_old" };
  assert.equal(suggestSetterForTrellusUser({ name: "Athan Pohlman", email: "athan@grsfd.co" }, [linked]), null);
});

test("unmapped seats from the latest sync pick up roster names and a suggestion", () => {
  const seats = buildUnmappedSeats(
    { res_athan: 40, res_unknown: 2 },
    [{ id: "res_athan", name: "Athan Pohlman", email: "athan@grsfd.co" }],
    [ATHAN, CHRIS],
  );
  assert.equal(seats[0].trellusUserId, "res_athan");
  assert.equal(seats[0].name, "Athan Pohlman");
  assert.equal(seats[0].suggestion?.memberId, ATHAN.id);
  assert.equal(seats[1].trellusUserId, "res_unknown");
  assert.equal(seats[1].name, null);
  assert.equal(seats[1].suggestion, null);
});
