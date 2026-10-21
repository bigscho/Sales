import assert from "node:assert/strict";
import test from "node:test";
import {
  carryForwardAnswer,
  formatAttributionNote,
  parseAttributionFromText,
  parseCalendlyQuestions,
} from "./calendly-answers";

// Live Grassfed Demo questions (calendly.com/colin-grsfd/grassfed-demo),
// plus the setter form used by Colin's original demo and the just-listed
// event. Position is included because GHL prefills by position; the parser
// must ignore it.
const GRASSFED_DEMO_QNA = [
  { question: "Phone Number", answer: "+1 425-555-0100", position: 0 },
  {
    question: "Drop a listing/sale address and we'll run a free count for you.",
    answer: "  123 Main St, Seattle  ",
    position: 1,
  },
  { question: "How did you hear about us?", answer: "Instagram", position: 2 },
  { question: "If someone sent you, who?", answer: "Alex Rivera", position: 3 },
];

const SETTER_FORM_QNA = [
  { question: "Phone Number", answer: "+1 585-797-5815", position: 0 },
  { question: "Booked by", answer: "  Solomon  ", position: 1 },
  { question: "Address/Zip Code", answer: "14201", position: 2 },
];

test("grassfed demo payload stores both new answers and the existing phone and address", () => {
  const parsed = parseCalendlyQuestions(GRASSFED_DEMO_QNA);
  assert.equal(parsed.phone, "+1 425-555-0100");
  assert.equal(parsed.listingAddress, "123 Main St, Seattle");
  assert.equal(parsed.bookedBy, null);
  assert.equal(parsed.howHeard, "Instagram");
  assert.equal(parsed.referredBy, "Alex Rivera");
});

test("setter form is unchanged and the new answers are not a setter", () => {
  const parsed = parseCalendlyQuestions(SETTER_FORM_QNA);
  assert.deepEqual(parsed, {
    phone: "+1 585-797-5815",
    listingAddress: "14201",
    bookedBy: "Solomon",
    howHeard: null,
    referredBy: null,
  });
});

test("new questions keep the same phone, address, and setter in any position", () => {
  const extra = [
    { question: "How did you hear about us?", answer: "Referral", position: 0 },
    { question: "If someone sent you, who?", answer: "Ming", position: 1 },
  ];
  const orders = [
    [...extra, ...SETTER_FORM_QNA],
    [...SETTER_FORM_QNA, ...extra],
    [SETTER_FORM_QNA[0], extra[0], SETTER_FORM_QNA[1], extra[1], SETTER_FORM_QNA[2]],
  ];
  for (const qna of orders) {
    const parsed = parseCalendlyQuestions(qna);
    assert.equal(parsed.phone, "+1 585-797-5815");
    assert.equal(parsed.listingAddress, "14201");
    assert.equal(parsed.bookedBy, "Solomon");
    assert.equal(parsed.howHeard, "Referral");
    assert.equal(parsed.referredBy, "Ming");
  }
});

test("referral answer is not the setter when Booked by is absent", () => {
  const parsed = parseCalendlyQuestions([
    { question: "Phone Number", answer: "555" },
    { question: "If someone sent you, who?", answer: "Ming" },
    { question: "How did you hear about us?", answer: "AI search" },
  ]);
  assert.equal(parsed.bookedBy, null);
  assert.equal(parsed.phone, "555");
  assert.equal(parsed.howHeard, "AI search");
  assert.equal(parsed.referredBy, "Ming");
});

test("dropdown values pass through and blank optional answers stay null", () => {
  for (const choice of ["AI search", "Web search", "Instagram", "Referral", "Other"]) {
    const parsed = parseCalendlyQuestions([
      { question: "How did you hear about us?", answer: choice },
      { question: "If someone sent you, who?", answer: "   " },
    ]);
    assert.equal(parsed.howHeard, choice);
    assert.equal(parsed.referredBy, null);
    assert.equal(parsed.phone, null);
    assert.equal(parsed.listingAddress, null);
    assert.equal(parsed.bookedBy, null);
  }
});

test("wording variants match, and a phone question that says sent you stays a phone", () => {
  const parsed = parseCalendlyQuestions([
    { question: "Where did you hear about Grassfed?", answer: "Web search" },
    { question: "Who referred you?", answer: "Pat" },
    { question: "Confirm the phone number we sent you", answer: "425-555-0199" },
    { question: "Listing address / zip codes", answer: "98004" },
    { question: "Booked by:", answer: "Athan" },
  ]);
  assert.equal(parsed.howHeard, "Web search");
  assert.equal(parsed.referredBy, "Pat");
  assert.equal(parsed.phone, "425-555-0199");
  assert.equal(parsed.listingAddress, "98004");
  assert.equal(parsed.bookedBy, "Athan");
});

test("a how-heard question that mentions phone and address is not used as either", () => {
  const parsed = parseCalendlyQuestions([
    {
      question: "How did you hear about us? Include your phone and the property address",
      answer: "Instagram",
    },
    { question: "If someone sent you, who booked the intro?", answer: "Alex" },
    { question: "Phone Number", answer: "206-555-0101" },
    { question: "Address/Zip Code", answer: "98101" },
    { question: "Booked by", answer: "Logan" },
  ]);
  assert.equal(parsed.howHeard, "Instagram");
  assert.equal(parsed.referredBy, "Alex");
  assert.equal(parsed.phone, "206-555-0101");
  assert.equal(parsed.listingAddress, "98101");
  assert.equal(parsed.bookedBy, "Logan");
});

test("affiliate who-referred question is not a phone or a setter", () => {
  const parsed = parseCalendlyQuestions([
    {
      question: "Please share who referred you in order to get the 25% PROMO (First Name, Last Name)",
      answer: "Jane Doe",
    },
    { question: "Phone Number", answer: "+1 206-555-0177" },
  ]);
  assert.equal(parsed.referredBy, "Jane Doe");
  assert.equal(parsed.phone, "+1 206-555-0177");
  assert.equal(parsed.bookedBy, null);
  assert.equal(parsed.listingAddress, null);
  assert.equal(parsed.howHeard, null);
});

test("phone answer is not trimmed and a blank booked-by answer does not invent a setter", () => {
  const parsed = parseCalendlyQuestions([
    { question: "Phone number", answer: "  555  " },
    { question: "Booked by", answer: "   " },
    { question: "zip", answer: "   " },
  ]);
  assert.equal(parsed.phone, "  555  ");
  assert.equal(parsed.bookedBy, null);
  assert.equal(parsed.listingAddress, null);
});

test("carry forward keeps the prior answer when the reschedule leaves it blank", () => {
  assert.equal(carryForwardAnswer(null, "Instagram"), "Instagram");
  assert.equal(carryForwardAnswer("  ", "Referral"), "Referral");
  assert.equal(carryForwardAnswer("Web search", "Instagram"), "Web search");
  assert.equal(carryForwardAnswer(null, null), null);
  assert.equal(carryForwardAnswer("  Alex  ", null), "Alex");
});

test("slack note is empty unless an answer is present", () => {
  assert.equal(formatAttributionNote(null, null), "");
  assert.equal(formatAttributionNote("  ", ""), "");
  assert.equal(formatAttributionNote("Instagram", null), " (heard: Instagram)");
  assert.equal(formatAttributionNote(null, "Alex"), " (sent by Alex)");
  assert.equal(
    formatAttributionNote("Referral", "Alex Rivera"),
    " (heard: Referral, sent by Alex Rivera)",
  );
});

test("calendar description lines do not steal phone or booked by", () => {
  const description = [
    "Event Name",
    "Grassfed Demo",
    "",
    "Phone Number: +1 425-555-0100",
    "Booked by: Solomon",
    "Drop a listing/sale address and we'll run a free count for you.: 123 Main St",
    "How did you hear about us?: AI search",
    "If someone sent you, who?:",
    "Casey Ng",
    "Need to make changes to this event?",
    "Cancel: https://calendly.com/cancellations/abc",
    "Reschedule: https://calendly.com/reschedulings/abc",
  ].join("\n");
  assert.deepEqual(parseAttributionFromText(description), {
    howHeard: "AI search",
    referredBy: "Casey Ng",
  });
  assert.deepEqual(parseAttributionFromText("Booked by: Ming\nPhone Number: 555"), {
    howHeard: null,
    referredBy: null,
  });
  assert.deepEqual(parseAttributionFromText(null), { howHeard: null, referredBy: null });
});
