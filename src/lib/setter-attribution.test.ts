import assert from "node:assert/strict";
import test from "node:test";
import { attributeBookedBy, isNonNameBookedBy, type AttributionMember } from "./setter-attribution";

const SOLOMON: AttributionMember = {
  id: "setter-solomon",
  name: "Solomon Gerges",
  role: "setter",
  isActive: true,
};
const ATHAN: AttributionMember = {
  id: "setter-athan",
  name: "Athan Pohlman",
  role: "setter",
  isActive: true,
};
const CHRIS: AttributionMember = {
  id: "setter-chris",
  name: "Chris Carr",
  role: "setter",
  isActive: true,
};
const CHRISTIAN: AttributionMember = {
  id: "setter-christian",
  name: "Christian",
  role: "setter",
  isActive: true,
};
const COLIN: AttributionMember = {
  id: "closer-colin",
  name: "Colin Schofield",
  role: "closer",
  isActive: true,
};

const ROSTER: AttributionMember[] = [SOLOMON, ATHAN, CHRIS, CHRISTIAN, COLIN];

test("exact, alias, and a one-character typo match the real setter", () => {
  assert.equal(attributeBookedBy("Solomon Gerges", ROSTER).memberId, SOLOMON.id);
  assert.equal(attributeBookedBy("SG", ROSTER).memberId, SOLOMON.id);
  assert.equal(attributeBookedBy("solomon gergs", ROSTER).memberId, SOLOMON.id);
  assert.equal(attributeBookedBy("Solonon", ROSTER).memberId, SOLOMON.id);
  assert.equal(attributeBookedBy("AP", ROSTER).memberId, ATHAN.id);
  assert.equal(attributeBookedBy("CC", ROSTER).memberId, CHRIS.id);
});

test("Chris resolves to Chris Carr and not Christian", () => {
  const hit = attributeBookedBy("Chris", ROSTER);
  assert.equal(hit.memberId, CHRIS.id);
  assert.equal(hit.matchedRole, "setter");
  assert.equal(attributeBookedBy("Christian", ROSTER).memberId, CHRISTIAN.id);
});

test("an alias does not fall through to a different setter when the target is inactive", () => {
  const inactiveChris: AttributionMember = { ...CHRIS, isActive: false };
  const hit = attributeBookedBy("Chris", [inactiveChris, CHRISTIAN, SOLOMON]);
  assert.equal(hit.memberId, null);
  assert.equal(hit.unmatchedBookedBy, "Chris");
});

test("a closer name matches the closer and does not create a setter", () => {
  const hit = attributeBookedBy("Colin", ROSTER);
  assert.equal(hit.memberId, COLIN.id);
  assert.equal(hit.matchedRole, "closer");
  assert.equal(hit.unmatchedBookedBy, null);
});

test("free text is unattributed instead of matched or invented", () => {
  const junk = [
    "Self-booked",
    "myself",
    "Calendly",
    "425-870-6396",
    "prospect@example.com",
    "123 Main St, Austin",
    "Geoffrey - IVY make sure Chris sees this",
  ];
  for (const raw of junk) {
    const hit = attributeBookedBy(raw, ROSTER);
    assert.equal(hit.memberId, null, raw);
    assert.equal(hit.unmatchedBookedBy, raw.trim(), raw);
    assert.equal(isNonNameBookedBy(raw), true, raw);
  }
});

test("a typo prefers the real setter over an excluded junk row of the same text", () => {
  const junk: AttributionMember = {
    id: "junk-solonon",
    name: "Solonon",
    role: "setter",
    isActive: true,
    excludeFromLeaderboard: true,
  };
  assert.equal(attributeBookedBy("Solonon", [...ROSTER, junk]).memberId, SOLOMON.id);
});

test("an excluded guest booker still matches when no real setter does", () => {
  const guest: AttributionMember = {
    id: "guest-ivy",
    name: "Ivy Guest",
    role: "setter",
    isActive: true,
    excludeFromLeaderboard: true,
  };
  assert.equal(attributeBookedBy("Ivy Guest", [...ROSTER, guest]).memberId, guest.id);
});

test("two equally close setters are ambiguous and stay unattributed", () => {
  const other: AttributionMember = {
    id: "setter-solomon-2",
    name: "Solomon Hart",
    role: "setter",
    isActive: true,
  };
  const hit = attributeBookedBy("Solomon", [SOLOMON, other]);
  assert.equal(hit.memberId, null);
  assert.equal(hit.unmatchedBookedBy, "Solomon");
});

test("blank booked-by is not a review flag", () => {
  assert.deepEqual(attributeBookedBy("  ", ROSTER), {
    memberId: null,
    matchedRole: null,
    unmatchedBookedBy: null,
  });
  assert.deepEqual(attributeBookedBy(null, ROSTER), {
    memberId: null,
    matchedRole: null,
    unmatchedBookedBy: null,
  });
});
