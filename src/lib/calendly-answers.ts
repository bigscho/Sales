// Calendly custom questions, matched by question text — never by position.
// GHL links prefill answers by position (a1, a2, …) on other event types
// (setter round-robin, Colin's original demo, ~71k prefilled links). Those
// forms keep their existing keyword reads. Position is ignored on purpose.
//
// Grassfed Demo (calendly.com/colin-grsfd/grassfed-demo) adds two optional
// questions. They are identified and then removed from the phone / listing /
// "Booked by" search so a later wording tweak cannot be stored as a phone,
// an address, or a setter. utm_source is not read here; callers keep their
// own fallback.

export type CalendlyQa = { question?: string | null; answer?: string | null };

export type ParsedCalendlyAnswers = {
  // First non-attribution question whose text contains "phone". The answer is
  // NOT trimmed — same as the historical webhook assignment.
  phone: string | null;
  // First non-attribution question containing listing / address / zip, trimmed.
  // Blank answers stay null.
  listingAddress: string | null;
  // First non-attribution question containing "booked", trimmed. Null when the
  // question is absent or the answer is blank. Not a setter resolution and
  // not a utm fallback.
  bookedBy: string | null;
  howHeard: string | null;
  referredBy: string | null;
};

function questionText(question: string | null | undefined): string {
  return (question || "").toLowerCase();
}

// "How did you hear about us?" and close variants ("Where did you hear about
// Grassfed?", "How'd you hear about us?"). Not "about us" alone.
export function isHowHeardQuestion(question: string | null | undefined): boolean {
  const q = questionText(question);
  if (/\bhear(?:d|ing)? about\b/.test(q)) return true;
  if (/\bhow did you hear\b/.test(q)) return true;
  if (/\bhow(?:'d|d)? you hear\b/.test(q)) return true;
  if (/\bwhere did you hear\b/.test(q)) return true;
  return false;
}

// "If someone sent you, who?" and close variants ("Who sent you?", "Who
// referred you?"). Requires a person-word so "the phone number we sent you"
// stays a phone question.
export function isReferredByQuestion(question: string | null | undefined): boolean {
  if (isHowHeardQuestion(question)) return false;
  const q = questionText(question);
  const aboutAPerson = /\b(who|someone|somebody|whom)\b/.test(q) || /\breferr/.test(q);
  const sentOrReferred = /\bsent you\b/.test(q) || /\breferr/.test(q);
  return aboutAPerson && sentOrReferred;
}

function isAttributionQuestion(question: string | null | undefined): boolean {
  return isHowHeardQuestion(question) || isReferredByQuestion(question);
}

function cleanAnswer(answer: string | null | undefined): string | null {
  const trimmed = (answer ?? "").trim();
  return trimmed ? trimmed : null;
}

function firstMatching(list: CalendlyQa[], pred: (question: string) => boolean): CalendlyQa | undefined {
  return list.find((q) => pred(q.question || ""));
}

export function parseCalendlyQuestions(qna: CalendlyQa[] | null | undefined): ParsedCalendlyAnswers {
  const list = Array.isArray(qna) ? qna : [];
  // Attribution questions are taken out before the legacy keyword scan, even
  // when their text also contains "phone", "address", or "booked".
  const legacy = list.filter((q) => !isAttributionQuestion(q.question));

  const phoneQ = firstMatching(legacy, (question) => question.toLowerCase().includes("phone"));
  const listingQ = firstMatching(legacy, (question) => {
    const ql = question.toLowerCase();
    return ql.includes("listing") || ql.includes("address") || ql.includes("zip");
  });
  const bookedQ = firstMatching(legacy, (question) => question.toLowerCase().includes("booked"));

  const listingTrim = listingQ?.answer?.trim();

  return {
    phone: phoneQ ? (phoneQ.answer ?? null) : null,
    listingAddress: listingTrim ? listingTrim : null,
    bookedBy: bookedQ ? (bookedQ.answer?.trim() || null) : null,
    howHeard: firstNonBlank(list, isHowHeardQuestion),
    referredBy: firstNonBlank(list, isReferredByQuestion),
  };
}

function firstNonBlank(list: CalendlyQa[], pred: (question: string | null | undefined) => boolean): string | null {
  for (const q of list) {
    if (!pred(q.question)) continue;
    const cleaned = cleanAnswer(q.answer);
    if (cleaned) return cleaned;
  }
  return null;
}

// Reschedule successor: a new answer wins; a blank answer keeps the prior one.
export function carryForwardAnswer(
  incoming: string | null | undefined,
  previous: string | null | undefined,
): string | null {
  return cleanAnswer(incoming) || cleanAnswer(previous);
}

// Slack suffix. Empty string when both answers are blank so the existing
// "New demo booked" line is unchanged.
export function formatAttributionNote(
  howHeard: string | null | undefined,
  referredBy: string | null | undefined,
): string {
  const parts: string[] = [];
  const heard = cleanAnswer(howHeard);
  const sentBy = cleanAnswer(referredBy);
  if (heard) parts.push(`heard: ${heard}`);
  if (sentBy) parts.push(`sent by ${sentBy}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

// Calendly copies custom questions into the Google Calendar description as
// "Label: value" lines (same shape as "Phone Number:" / "Booked by:"). Some
// event descriptions use the label on its own line and the answer on the next.
export function parseAttributionFromText(text: string | null | undefined): {
  howHeard: string | null;
  referredBy: string | null;
} {
  if (!text) return { howHeard: null, referredBy: null };
  const lines = text.split(/\r?\n/);
  let howHeard: string | null = null;
  let referredBy: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const labeled = raw.match(/^(.+?):\s*(.*)$/);
    const label = (labeled ? labeled[1] : raw).trim();
    const inline = labeled && labeled[2].trim() ? labeled[2].trim() : null;
    const value = inline || followingValue(lines, i);
    if (!value || /^https?:\/\//i.test(value)) continue;
    if (!howHeard && isHowHeardQuestion(label)) howHeard = value;
    else if (!referredBy && isReferredByQuestion(label)) referredBy = value;
  }

  return { howHeard, referredBy };
}

function followingValue(lines: string[], index: number): string | null {
  const next = lines[index + 1]?.trim();
  if (!next) return null;
  if (/^https?:\/\//i.test(next)) return null;
  const label = next.split(":")[0] || "";
  if (
    isHowHeardQuestion(label) ||
    isReferredByQuestion(label) ||
    /phone|booked|address|zip|listing|event name|location|cancel|reschedule/i.test(label)
  ) {
    return null;
  }
  return next;
}
