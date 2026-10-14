import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_INTERNAL_ROSTER,
  classifyInboundGroup,
  confirmationGroupWhere,
  draftInternalInbound,
  internalGroupConfigFromEnv,
  internalGroupWrite,
  parseInternalGroups,
  pinnedInternalGroupIds,
  rosterMatchesGroup,
  shouldRecordInbound,
  type InternalGroupConfig,
} from "./internal-group";

const LINE = "+13137683591";
const SETTER_A = "+15551112222";
const SETTER_B = "+15553334444";
const SETTER_C = "+15555556666";
const COLIN = "+15557001111";
const MATTHEW = "+15557002222";
const PROSPECT = "+15559990000";

const GROUPS: InternalGroupConfig[] = [
  { name: "setters", phones: [SETTER_A, SETTER_B, SETTER_C], groupIds: ["grp_setters"] },
  { name: "closers", phones: [COLIN, MATTHEW], groupIds: ["grp_closers"] },
];

function classify(overrides: Partial<Parameters<typeof classifyInboundGroup>[0]> = {}) {
  return classifyInboundGroup({
    groupId: "grp_new",
    participants: [SETTER_A, SETTER_B, SETTER_C, LINE],
    participantsExplicit: true,
    lineNumber: LINE,
    groups: GROUPS,
    ...overrides,
  });
}

test("setters and closers are separate list entries, matched before group id is known", () => {
  assert.equal(MIN_INTERNAL_ROSTER, 2);
  assert.deepEqual(classify(), { internal: true, name: "setters" });
  assert.deepEqual(
    classify({
      groupId: "brand-new",
      participants: [COLIN, MATTHEW, LINE],
    }),
    { internal: true, name: "closers" }
  );
});

test("the closers roster does not match the setters list, and the reverse", () => {
  assert.equal(rosterMatchesGroup([COLIN, MATTHEW, LINE], GROUPS[0].phones, LINE), false);
  assert.equal(rosterMatchesGroup([SETTER_A, SETTER_B, SETTER_C, LINE], GROUPS[1].phones, LINE), false);
  assert.equal(rosterMatchesGroup([COLIN, MATTHEW], [COLIN, MATTHEW, LINE], LINE), true);
});

test("a prospect plus one setter or one closer stays a prospect group", () => {
  assert.deepEqual(classify({ participants: [SETTER_A, PROSPECT, LINE] }), {
    internal: false,
    name: null,
  });
  assert.deepEqual(classify({ participants: [COLIN, PROSPECT, LINE] }), {
    internal: false,
    name: null,
  });
  assert.deepEqual(classify({ participants: [SETTER_A, COLIN, LINE] }), {
    internal: false,
    name: null,
  });
});

test("a partial roster is not a match — the member set has to equal the entry", () => {
  assert.deepEqual(classify({ participants: [SETTER_A, SETTER_B, LINE] }), {
    internal: false,
    name: null,
  });
  assert.deepEqual(classify({ participants: [COLIN, LINE] }), {
    internal: false,
    name: null,
  });
});

test("one configured number cannot classify — it would match prospect groups", () => {
  assert.equal(rosterMatchesGroup([SETTER_A, LINE], [SETTER_A], LINE), false);
  assert.deepEqual(
    classify({
      participants: [SETTER_A, LINE],
      groups: [{ name: "setters", phones: [SETTER_A], groupIds: [] }],
    }),
    { internal: false, name: null }
  );
});

test("from_number alone is not a roster", () => {
  assert.deepEqual(
    classify({
      participants: [SETTER_A, SETTER_B, SETTER_C],
      participantsExplicit: false,
      groups: [{ name: "setters", phones: [SETTER_A, SETTER_B, SETTER_C], groupIds: [] }],
    }),
    { internal: false, name: null }
  );
});

test("a pinned group id selects that list entry even when the roster looks like a prospect", () => {
  assert.deepEqual(
    classify({
      groupId: "grp_closers",
      participants: [COLIN, PROSPECT],
      participantsExplicit: false,
    }),
    { internal: true, name: "closers" }
  );
});

test("once flagged, a later partial payload stays internal and keeps its name", () => {
  assert.deepEqual(
    classify({
      participants: [PROSPECT],
      alreadyInternal: true,
      alreadyName: "closers",
      groups: [],
    }),
    { internal: true, name: "closers" }
  );
});

test("unset config leaves every group on the prospect path", () => {
  assert.deepEqual(classify({ groups: [] }), { internal: false, name: null });
});

test("the env list parses text and JSON, including the closers pair", () => {
  const text = parseInternalGroups(
    "setters:+1 555 111 2222,+15553334444\nclosers:+15557001111,+15557002222|grp_closers"
  );
  assert.equal(text.error, null);
  assert.deepEqual(text.groups, [
    { name: "setters", phones: ["+1 555 111 2222", "+15553334444"], groupIds: [] },
    { name: "closers", phones: ["+15557001111", "+15557002222"], groupIds: ["grp_closers"] },
  ]);

  const json = parseInternalGroups(
    JSON.stringify([
      { name: "setters", phones: [SETTER_A, SETTER_B] },
      { name: "closers", phones: [COLIN, MATTHEW], groupIds: ["grp_closers"] },
    ])
  );
  assert.equal(json.error, null);
  assert.equal(json.groups[1].name, "closers");
  assert.deepEqual(pinnedInternalGroupIds(json.groups), ["grp_closers"]);

  assert.deepEqual(parseInternalGroups(""), { groups: [], error: null });
  assert.equal(parseInternalGroups("not a group").error !== null, true);
  assert.deepEqual(
    internalGroupConfigFromEnv({
      SENDBLUE_INTERNAL_GROUPS: "closers:+15557001111,+15557002222",
    } as unknown as NodeJS.ProcessEnv).groups,
    [{ name: "closers", phones: ["+15557001111", "+15557002222"], groupIds: [] }]
  );
});

test("prospect upserts gain no columns; each internal group records its name and clears the booking link", () => {
  assert.deepEqual(internalGroupWrite({ internal: false, name: null }), {});
  assert.deepEqual(internalGroupWrite({ internal: true, name: "closers" }), {
    internal: true,
    bookingId: null,
    prospectPhone: null,
    internalName: "closers",
  });
  assert.deepEqual(internalGroupWrite({ internal: true, name: null }), {
    internal: true,
    bookingId: null,
    prospectPhone: null,
  });
});

test("worklist lookup excludes every pinned internal id and keeps the prospect phone match", () => {
  assert.deepEqual(confirmationGroupWhere("bk_1", "5559990000", []), {
    internal: false,
    OR: [
      { bookingId: "bk_1" },
      { prospectPhone: { contains: "5559990000" } },
      { participants: { contains: "5559990000" } },
    ],
  });
  const pinned = confirmationGroupWhere("bk_1", "5559990000", ["grp_setters", "grp_closers"]);
  assert.equal(pinned.internal, false);
  assert.deepEqual(pinned.groupId, { notIn: ["grp_setters", "grp_closers"] });
});

test("only inbound internal messages are stored, for whichever group matched", () => {
  assert.equal(shouldRecordInbound(false, false), false);
  assert.equal(shouldRecordInbound(true, true), false);
  assert.equal(shouldRecordInbound(true, false), true);

  const now = new Date("2026-10-14T18:00:00.000Z");
  assert.equal(
    draftInternalInbound({ is_outbound: true, from_number: COLIN, content: "secret" }, "grp", now),
    null
  );
  assert.deepEqual(
    draftInternalInbound(
      {
        is_outbound: false,
        from_number: COLIN,
        content: "  film the opener  ",
        media_url: " https://cdn.example/a.jpg ",
        date_sent: "2026-10-14T17:00:00.000Z",
        message_handle: " HANDLE-1 ",
      },
      "grp_closers",
      now
    ),
    {
      groupId: "grp_closers",
      senderNumber: COLIN,
      text: "  film the opener  ",
      mediaUrl: "https://cdn.example/a.jpg",
      sentAt: new Date("2026-10-14T17:00:00.000Z"),
      messageHandle: "HANDLE-1",
    }
  );
  assert.equal(draftInternalInbound({ content: "no sender" }, "grp", now), null);
});
