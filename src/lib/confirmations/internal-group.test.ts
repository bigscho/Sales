import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_INTERNAL_ROSTER,
  classifyInboundGroup,
  confirmationGroupWhere,
  draftInternalInbound,
  internalGroupConfigFromEnv,
  internalGroupWrite,
  flattenParticipantValues,
  mergeParticipants,
  normalizeHandle,
  normalizeStoredParticipants,
  originationInternalBlock,
  parseInternalGroups,
  participantsToStore,
  pinnedInternalGroupIds,
  rosterMatchesGroup,
  shouldRecordInbound,
  storedParticipantsLookNested,
  withSenderEmail,
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

const REAL_GROUPS =
  "setters:+14049835597,+17742758987,+17742758299,solomonnassa@icloud.com,+15083203106,+447848983256;closers:+17742758299,+17742758987";

test("the live env string keeps the iMessage email on setters and the closers pair separate", () => {
  const parsed = parseInternalGroups(REAL_GROUPS);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.groups, [
    {
      name: "setters",
      phones: [
        "+14049835597",
        "+17742758987",
        "+17742758299",
        "solomonnassa@icloud.com",
        "+15083203106",
        "+447848983256",
      ],
      groupIds: [],
    },
    { name: "closers", phones: ["+17742758299", "+17742758987"], groupIds: [] },
  ]);

  const messy = parseInternalGroups(
    "setters:+14049835597,+17742758987,+17742758299, SolomonNassa@iCloud.com ,+15083203106,+447848983256"
  );
  assert.equal(messy.groups[0].phones[3], "solomonnassa@icloud.com");

  const json = parseInternalGroups(
    JSON.stringify([
      {
        name: "setters",
        phones: ["+14049835597"],
        handles: ["mailto:SolomonNassa@iCloud.com"],
      },
    ])
  );
  assert.deepEqual(json.groups[0].phones, ["+14049835597", "solomonnassa@icloud.com"]);
});

test("exact setters match includes the email; phones alone are not that group", () => {
  const groups = parseInternalGroups(REAL_GROUPS).groups;
  const setters = [
    "+1 (404) 983-5597",
    "+17742758987",
    "17742758299",
    "mailto:SolomonNassa@iCloud.com",
    "+15083203106",
    "+44 7848 983256",
    LINE,
  ];
  assert.deepEqual(
    classifyInboundGroup({
      groupId: "grp_new",
      participants: setters,
      participantsExplicit: true,
      lineNumber: LINE,
      groups,
    }),
    { internal: true, name: "setters" }
  );
  assert.equal(normalizeHandle("+447848983256"), "7848983256");
  assert.equal(normalizeHandle("  SolomonNassa@iCloud.com "), "solomonnassa@icloud.com");
  assert.equal(normalizeHandle("Solomon Nassa <SolomonNassa@iCloud.com>"), "solomonnassa@icloud.com");
  assert.equal(normalizeHandle(LINE, LINE), null);

  const phonesOnly = setters.filter((p) => !String(p).includes("@") && !String(p).includes("mailto"));
  assert.deepEqual(
    classifyInboundGroup({
      groupId: "grp_new",
      participants: phonesOnly,
      participantsExplicit: true,
      lineNumber: LINE,
      groups,
    }),
    { internal: false, name: null }
  );

  assert.deepEqual(
    classifyInboundGroup({
      groupId: "grp_new",
      participants: [
        { handle: "+14049835597" },
        "+17742758987",
        "+17742758299",
        { handle: "solomonnassa@icloud.com", phone: null },
        "+15083203106",
        "+447848983256",
        LINE,
      ],
      participantsExplicit: true,
      lineNumber: LINE,
      groups,
    }),
    { internal: true, name: "setters" }
  );

  assert.deepEqual(
    classifyInboundGroup({
      groupId: "grp_closers_live",
      participants: ["+1 774-275-8299", "+17742758987", LINE],
      participantsExplicit: true,
      lineNumber: LINE,
      groups,
    }),
    { internal: true, name: "closers" }
  );
});

test("a sender email missing from participants still completes the setters roster", () => {
  const groups = parseInternalGroups(REAL_GROUPS).groups;
  const listed = [
    "+14049835597",
    "+17742758987",
    "+17742758299",
    "+15083203106",
    "+447848983256",
    LINE,
  ];
  assert.deepEqual(
    classifyInboundGroup({
      groupId: "grp_new",
      participants: listed,
      participantsExplicit: true,
      lineNumber: LINE,
      groups,
    }),
    { internal: false, name: null }
  );
  const merged = withSenderEmail(listed, "SolomonNassa@iCloud.com");
  assert.deepEqual(
    classifyInboundGroup({
      groupId: "grp_new",
      participants: merged,
      participantsExplicit: true,
      lineNumber: LINE,
      groups,
    }),
    { internal: true, name: "setters" }
  );
  assert.equal(withSenderEmail(merged, "solomonnassa@icloud.com"), merged);
  assert.deepEqual(withSenderEmail(listed, "+14049835597"), listed);
});

test("one email is not a roster; a phone plus an email can be", () => {
  assert.equal(
    rosterMatchesGroup(["solomonnassa@icloud.com", LINE], ["SolomonNassa@iCloud.com"], LINE),
    false
  );
  assert.equal(
    rosterMatchesGroup(
      [SETTER_A, "mailto:SolomonNassa@iCloud.com", LINE],
      [SETTER_A, "solomonnassa@icloud.com"],
      LINE
    ),
    true
  );
});

test("stored participants keep phone text, canonicalize emails, and drop the line", () => {
  assert.deepEqual(
    participantsToStore(
      ["+1 (404) 983-5597", "  SolomonNassa@iCloud.com ", LINE, "+14049835597", { handle: "solomonnassa@icloud.com" }],
      LINE
    ),
    ["+1 (404) 983-5597", "solomonnassa@icloud.com"]
  );
});

test("nested participant copies collapse to one flat deduped list and stay there", () => {
  const roster = ["+15551112222", "+15553334444"];
  // What the old Set merge stored: the array object is a new reference on
  // every parse, so each sync appended another copy of the same roster.
  let bloated = JSON.stringify(roster);
  const seenArray = roster;
  for (let i = 0; i < 40; i++) {
    const parsed = JSON.parse(bloated) as unknown[];
    bloated = JSON.stringify([...parsed, seenArray]);
  }
  assert.equal(bloated.length > 1000, true);
  assert.equal(storedParticipantsLookNested(bloated), true);

  const once = normalizeStoredParticipants(bloated, LINE);
  const twice = normalizeStoredParticipants(once, LINE);
  assert.equal(once, twice);
  assert.deepEqual(JSON.parse(once!), roster);
  assert.equal(storedParticipantsLookNested(once), false);

  let again = once!;
  for (let i = 0; i < 30; i++) {
    again = JSON.stringify(
      mergeParticipants(again, [roster, "+15551112222", { handle: "+15553334444" }, LINE], LINE)
    );
  }
  assert.equal(again, once);

  const wrapped = JSON.stringify(JSON.stringify([LINE, ["+15551112222", ["+15553334444"]]]));
  assert.equal(storedParticipantsLookNested(wrapped), true);
  assert.deepEqual(JSON.parse(normalizeStoredParticipants(wrapped, LINE)!), roster);

  assert.deepEqual(flattenParticipantValues(["+15551112222", ["+15553334444", ["+15551112222"]]]), [
    "+15551112222",
    "+15553334444",
    "+15551112222",
  ]);

  const flat = JSON.stringify(["+15551112222", "solomonnassa@icloud.com"]);
  assert.equal(storedParticipantsLookNested(flat), false);
  assert.equal(normalizeStoredParticipants(flat, LINE), flat);
  assert.equal(normalizeStoredParticipants(null, LINE), null);

  const doubledFlat = JSON.stringify(JSON.stringify(["+15551112222", "+15553334444"]));
  assert.equal(storedParticipantsLookNested(doubledFlat), true);
  assert.deepEqual(JSON.parse(normalizeStoredParticipants(doubledFlat, LINE)!), roster);

  const groups = parseInternalGroups(REAL_GROUPS).groups;
  assert.equal(
    originationInternalBlock({
      internal: false,
      groupId: "grp_nested",
      participants: JSON.stringify(["+15559990000", ["+14049835597", "+15559990000"]]),
      groups,
      teamMemberEmails: [],
      lineNumber: LINE,
    }),
    "internal_handle"
  );
});

test("origination is refused for any internal handle, without marking a partial roster internal", () => {
  const groups = parseInternalGroups(REAL_GROUPS).groups;
  const prospectWithSetter = ["+14049835597", PROSPECT, LINE];
  assert.deepEqual(
    classifyInboundGroup({
      groupId: "grp_prospect",
      participants: prospectWithSetter,
      participantsExplicit: true,
      lineNumber: LINE,
      groups,
    }),
    { internal: false, name: null }
  );
  assert.equal(
    originationInternalBlock({
      internal: false,
      groupId: "grp_prospect",
      participants: JSON.stringify(prospectWithSetter),
      groups,
      teamMemberEmails: ["colin@grsfd.co"],
      lineNumber: LINE,
    }),
    "internal_handle"
  );
  assert.equal(
    originationInternalBlock({
      internal: false,
      groupId: "grp_email",
      participants: ["Solomon Nassa <SolomonNassa@iCloud.com>", PROSPECT],
      groups,
      teamMemberEmails: [],
      lineNumber: LINE,
    }),
    "internal_handle"
  );
  assert.equal(
    originationInternalBlock({
      internal: false,
      groupId: "grp_work_email",
      participants: [PROSPECT, "Colin@GRSFD.co"],
      groups: [],
      teamMemberEmails: [" colin@grsfd.co "],
      lineNumber: LINE,
    }),
    "internal_handle"
  );
  assert.equal(
    originationInternalBlock({
      internal: true,
      groupId: "grp_setters",
      participants: prospectWithSetter,
      groups,
      teamMemberEmails: [],
      lineNumber: LINE,
    }),
    "internal_group"
  );
  const pinned = groups.map((g) =>
    g.name === "closers" ? { ...g, groupIds: ["grp_closers"] } : g
  );
  assert.equal(
    originationInternalBlock({
      internal: false,
      groupId: "grp_closers",
      participants: [PROSPECT],
      groups: pinned,
      teamMemberEmails: [],
      lineNumber: LINE,
    }),
    "internal_group"
  );
  assert.equal(
    originationInternalBlock({
      internal: false,
      groupId: "grp_prospect",
      participants: [PROSPECT, LINE],
      groups,
      teamMemberEmails: [],
      lineNumber: LINE,
    }),
    null
  );
  assert.equal(
    originationInternalBlock({
      internal: false,
      groupId: "grp_prospect",
      participants: [PROSPECT, LINE],
      groups: [{ name: "setters", phones: [LINE, SETTER_A, SETTER_B], groupIds: [] }],
      teamMemberEmails: [null, ""],
      lineNumber: LINE,
    }),
    null
  );
});
