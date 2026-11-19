import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeCloserFromTranscript,
  CLOSER_SOURCE_CALENDAR,
  CLOSER_SOURCE_MANUAL,
  CLOSER_SOURCE_TRANSCRIPT,
  decideCloserUpdate,
  REVIEW_BOTH_ON_CALL,
  REVIEW_DAY_LOCKED,
  REVIEW_MANUAL_OVERRIDE,
  REVIEW_SILENT_OR_SHORT,
  REVIEW_UNIDENTIFIED,
  type CloserCandidate,
  type TranscriptForCloser,
} from "./closer-from-transcript";
import {
  COLD_EMAIL_EVENT_NAME,
  eventBelongsToOtherDemoCalendar,
  isColdEmailDemoEvent,
  isDemoEventType,
  provisionalCloserFirstName,
  provisionalCloserFromHost,
} from "./demo-calendars";

const COLIN: CloserCandidate = { id: "closer-colin", name: "Colin", email: "colin@grsfd.co" };
const MATTHEW: CloserCandidate = { id: "closer-matthew", name: "Matthew", email: "matthew@grsfd.co" };
const CLOSERS = [COLIN, MATTHEW];

function talk(
  speaker: string,
  seconds: number,
  text = "Let me walk you through the cold email."
): TranscriptForCloser["sentences"] {
  return [
    {
      speaker_name: speaker,
      text,
      start_time: 0,
      end_time: seconds,
    },
  ];
}

function transcript(partial: TranscriptForCloser): TranscriptForCloser {
  return {
    duration: 32,
    organizer_email: "colin@grassfed.tech",
    participants: ["prospect@example.com"],
    sentences: [],
    meeting_info: { silent_meeting: false },
    ...partial,
  };
}

test("cold-email calendar event is a demo and onboarding is not", () => {
  assert.equal(isDemoEventType(COLD_EMAIL_EVENT_NAME), true);
  assert.equal(isColdEmailDemoEvent(COLD_EMAIL_EVENT_NAME), true);
  assert.equal(isDemoEventType("Grassfed Cold Email: Just Listed/Sold/Closed"), true);
  assert.equal(isDemoEventType("Onboarding"), false);
  assert.equal(isDemoEventType("Client Onboarding — Just Listed"), false);
  assert.equal(isDemoEventType("Launch call"), false);
  assert.equal(isDemoEventType("Quick call"), false);
  assert.equal(isDemoEventType("Grassfed Reconnect"), false);
  assert.equal(isDemoEventType("Just Listed"), true);
  assert.equal(isDemoEventType("Farm Demo"), true);
  assert.equal(isDemoEventType(null), true);
});

test("shared calendars are not credited from the owner's name", () => {
  assert.equal(provisionalCloserFirstName("colin@grsfd.co"), "Colin");
  assert.equal(provisionalCloserFirstName("matthew@grsfd.co"), "Matthew");
  assert.equal(provisionalCloserFirstName("colin@grassfed.tech"), null);
  assert.equal(provisionalCloserFirstName("admin@grassfed.tech"), null);
  assert.equal(provisionalCloserFirstName("Colin Schofield"), null);

  assert.equal(
    provisionalCloserFromHost({
      eventTypeOwnerEmail: "colin@grassfed.tech",
      poolingType: null,
      membershipEmails: ["colin@grassfed.tech"],
    }),
    null
  );
  assert.equal(
    provisionalCloserFromHost({
      eventTypeOwnerEmail: "admin@grassfed.tech",
      poolingType: null,
      membershipEmails: ["admin@grassfed.tech"],
    }),
    null
  );
  assert.equal(
    provisionalCloserFromHost({
      eventTypeOwnerEmail: "colin@grsfd.co",
      poolingType: null,
      membershipEmails: ["matthew@grsfd.co", "colin@grsfd.co"],
    }),
    "Colin",
    "a shadower on the invite does not replace the event-type owner"
  );
});

test("round robin uses the assigned host email, not the profile name", () => {
  assert.equal(
    provisionalCloserFromHost({
      eventTypeOwnerEmail: "admin@grassfed.tech",
      poolingType: "round_robin",
      membershipEmails: ["matthew@grsfd.co"],
    }),
    "Matthew"
  );
  assert.equal(
    provisionalCloserFromHost({
      eventTypeOwnerEmail: "colin@grassfed.tech",
      poolingType: "round_robin",
      membershipEmails: ["colin@grsfd.co", "matthew@grsfd.co"],
    }),
    null
  );
});

test("a cold-email event on Colin's personal calendar is the other calendar's booking", () => {
  assert.equal(
    eventBelongsToOtherDemoCalendar({
      organizerEmail: "colin@grassfed.tech",
      summary: "Jane Agent and Colin Schofield",
      calendarEmail: "colin@grsfd.co",
    }),
    true
  );
  assert.equal(
    eventBelongsToOtherDemoCalendar({
      organizerEmail: "colin@grassfed.tech",
      summary: "Jane Agent and Colin Schofield",
      calendarEmail: "colin@grassfed.tech",
    }),
    false
  );
});

test("the closer who spoke is credited even when the calendar is named Colin", () => {
  const result = attributeCloserFromTranscript(
    transcript({
      organizer_email: "colin@grassfed.tech",
      participants: ["colin@grassfed.tech", "matthew@grsfd.co", "prospect@example.com"],
      sentences: [
        ...talk("Matthew Schofield", 400)!,
        ...talk("Jane Agent", 200, "We have twelve listings in that zip.")!,
      ],
    }),
    CLOSERS
  );
  assert.deepEqual(result, { kind: "assigned", closerId: "closer-matthew", share: 1 });
});

test("Colin is credited when he is the one who spoke", () => {
  const result = attributeCloserFromTranscript(
    transcript({
      organizer_email: "matthew@grsfd.co",
      sentences: talk("Colin", 600),
    }),
    CLOSERS
  );
  assert.equal(result.kind, "assigned");
  if (result.kind === "assigned") assert.equal(result.closerId, "closer-colin");
});

test("both closers on the call are not guessed", () => {
  const result = attributeCloserFromTranscript(
    transcript({
      sentences: [
        { speaker_name: "Colin Schofield", text: "I'll start with the offer.", start_time: 0, end_time: 80 },
        { speaker_name: "Matthew Schofield", text: "And I'll cover the inboxes.", start_time: 80, end_time: 200 },
        { speaker_name: "Jane Agent", text: "That makes sense for our team.", start_time: 200, end_time: 260 },
      ],
    }),
    CLOSERS
  );
  assert.deepEqual(result, { kind: "ambiguous", reason: REVIEW_BOTH_ON_CALL });
});

test("a one-word cameo does not count as both on the call", () => {
  const result = attributeCloserFromTranscript(
    transcript({
      sentences: [
        { speaker_name: "Colin", text: "Hey.", start_time: 0, end_time: 1 },
        { speaker_name: "Matthew Schofield", text: "Here is how the campaign works.", start_time: 1, end_time: 400 },
      ],
    }),
    CLOSERS
  );
  assert.equal(result.kind, "assigned");
  if (result.kind === "assigned") assert.equal(result.closerId, "closer-matthew");
});

test("silent and one-minute recordings are flagged and not credited", () => {
  assert.deepEqual(
    attributeCloserFromTranscript(
      transcript({ duration: 1, meeting_info: { silent_meeting: false }, sentences: talk("Matthew", 50) }),
      CLOSERS
    ),
    { kind: "ambiguous", reason: REVIEW_SILENT_OR_SHORT }
  );
  assert.deepEqual(
    attributeCloserFromTranscript(
      transcript({
        duration: 20,
        meeting_info: { silent_meeting: true },
        sentences: talk("Colin Schofield", 100),
      }),
      CLOSERS
    ),
    { kind: "ambiguous", reason: REVIEW_SILENT_OR_SHORT }
  );
});

test("unlabeled speech with one personal closer email credits that closer", () => {
  const result = attributeCloserFromTranscript(
    transcript({
      organizer_email: "admin@grassfed.tech",
      participants: ["Speaker <matthew@grsfd.co>", "prospect@example.com"],
      duration: 18,
      sentences: [
        { speaker_name: "Speaker 1", text: "Let me show you the inbox setup.", start_time: 0, end_time: 40 },
        { speaker_name: "Speaker 2", text: "We close about four listings a month.", start_time: 40, end_time: 70 },
        { speaker_name: "Speaker 1", text: "The campaign would cover those zips.", start_time: 70, end_time: 110 },
        { speaker_name: "Speaker 2", text: "What does the first month look like?", start_time: 110, end_time: 140 },
        { speaker_name: "Speaker 1", text: "It is a subscription, month to month.", start_time: 140, end_time: 180 },
        { speaker_name: "Speaker 2", text: "Okay, send me the agreement.", start_time: 180, end_time: 200 },
      ],
    }),
    CLOSERS
  );
  assert.deepEqual(result, { kind: "assigned", closerId: "closer-matthew", share: 1 });
});

test("two closer emails and no speaker labels are not guessed", () => {
  const result = attributeCloserFromTranscript(
    transcript({
      organizer_email: "colin@grsfd.co",
      participants: ["matthew@grsfd.co", "prospect@example.com"],
      sentences: [
        { speaker_name: null, text: "Walking through pricing now for the team.", start_time: 0, end_time: 30 },
        { speaker_name: "Jane", text: "We want help with the just listed emails.", start_time: 30, end_time: 50 },
      ],
    }),
    CLOSERS
  );
  assert.deepEqual(result, { kind: "ambiguous", reason: REVIEW_BOTH_ON_CALL });
});

test("a shared calendar address alone does not identify a closer", () => {
  const result = attributeCloserFromTranscript(
    transcript({
      organizer_email: "colin@grassfed.tech",
      participants: ["colin@grassfed.tech", "prospect@example.com"],
      sentences: [
        { speaker_name: "Speaker 1", text: "This is the cold email walkthrough.", start_time: 0, end_time: 40 },
        { speaker_name: "Jane", text: "Tell me about the just sold campaign.", start_time: 40, end_time: 70 },
      ],
    }),
    CLOSERS
  );
  assert.deepEqual(result, { kind: "ambiguous", reason: REVIEW_UNIDENTIFIED });
});

test("sentence counts are used when Fireflies has no talk timestamps", () => {
  const sentences = [];
  for (let i = 0; i < 5; i++) {
    sentences.push({ speaker_name: "Matthew", text: "Here is the next part of the demo." });
  }
  sentences.push({ speaker_name: "Jane Agent", text: "We like that." });
  const result = attributeCloserFromTranscript(transcript({ sentences }), CLOSERS);
  assert.equal(result.kind, "assigned");
  if (result.kind === "assigned") assert.equal(result.closerId, "closer-matthew");
});

test("a clear recording replaces a provisional calendar closer", () => {
  const decision = decideCloserUpdate({
    currentCloserId: "closer-colin",
    closerSource: CLOSER_SOURCE_CALENDAR,
    humanReassigned: false,
    dayLocked: false,
    attribution: { kind: "assigned", closerId: "closer-matthew", share: 1 },
  });
  assert.equal(decision.closerId, "closer-matthew");
  assert.equal(decision.closerSource, CLOSER_SOURCE_TRANSCRIPT);
  assert.equal(decision.closerReviewReason, null);
  assert.equal(decision.changeCloser, true);
});

test("ambiguous recordings leave the closer and flag review", () => {
  for (const reason of [REVIEW_BOTH_ON_CALL, REVIEW_UNIDENTIFIED, REVIEW_SILENT_OR_SHORT] as const) {
    const decision = decideCloserUpdate({
      currentCloserId: "closer-colin",
      closerSource: CLOSER_SOURCE_CALENDAR,
      humanReassigned: false,
      dayLocked: false,
      attribution: { kind: "ambiguous", reason },
    });
    assert.equal(decision.closerId, "closer-colin");
    assert.equal(decision.changeCloser, false);
    assert.equal(decision.closerReviewReason, reason);
    assert.equal(decision.detectedCloserId, null);
  }
});

test("manual credit and a locked day are not overwritten", () => {
  const manual = decideCloserUpdate({
    currentCloserId: "closer-colin",
    closerSource: CLOSER_SOURCE_MANUAL,
    humanReassigned: false,
    dayLocked: false,
    attribution: { kind: "assigned", closerId: "closer-matthew", share: 0.9 },
  });
  assert.equal(manual.closerId, "closer-colin");
  assert.equal(manual.closerSource, CLOSER_SOURCE_MANUAL);
  assert.equal(manual.closerReviewReason, REVIEW_MANUAL_OVERRIDE);
  assert.equal(manual.changeCloser, false);

  const locked = decideCloserUpdate({
    currentCloserId: "closer-colin",
    closerSource: CLOSER_SOURCE_CALENDAR,
    humanReassigned: false,
    dayLocked: true,
    attribution: { kind: "assigned", closerId: "closer-matthew", share: 1 },
  });
  assert.equal(locked.closerId, "closer-colin");
  assert.equal(locked.closerReviewReason, REVIEW_DAY_LOCKED);
  assert.equal(locked.detectedCloserId, "closer-matthew");
  assert.equal(locked.changeCloser, false);
});

test("a departed closer's name is not a candidate", () => {
  const result = attributeCloserFromTranscript(
    transcript({ sentences: talk("Mark Whittelsey", 300) }),
    [...CLOSERS, { id: "closer-mark", name: "Mark", email: "mark@grsfd.co" }]
  );
  assert.equal(result.kind, "ambiguous");
});
