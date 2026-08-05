// Confirmation copy + classification engine.
//
// The T-1 text leads with the setter-captured listing address/zips (so it's the
// inbox preview), and its count language branches on what the setter gave us:
//   - one address        -> "We have about {count} valid emails, and 500+..."
//   - multiple addresses  -> "average of about {count} valid emails around each one..."
//   - zip codes / area    -> no number: "There's a solid amount of valid emails..."
// When the Calendly field is blank we fall back to the prospect's metro from our
// DB, which reads as an area (no number, same reasoning as a zip).
//
// All copy here is Colin's locked wording (2026-08-04). Keep it exact.

export type CaseType = "single" | "multiple" | "zip" | "area";
export type AddressSource = "calendly" | "db_fallback" | "none";

export interface ClassifiedInput {
  caseType: CaseType;
  addressVariable: string | null;
  addressSource: AddressSource;
  ambiguous: boolean; // parse was uncertain — surface in the QA row
}

const STREET_START = /\b\d{1,6}\s+[A-Za-z]/; // "1442 Filbert", "88 Oak"
const ZIP = /\b\d{5}\b/g;

/**
 * Classify the setter's free-text listing field, with a DB area fallback.
 */
export function classifyListingInput(
  rawInput: string | null | undefined,
  fallbackArea?: string | null
): ClassifiedInput {
  const raw = (rawInput || "").trim();

  if (raw) {
    const streets = raw.match(new RegExp(STREET_START, "g")) || [];
    const zips = raw.match(ZIP) || [];

    if (streets.length >= 1) {
      // Split into address segments. Split on newline/semicolon/pipe/&/"and",
      // and on a comma only when it's immediately followed by a house number
      // (so "1442 Filbert St, San Francisco" stays one segment, but
      // "88 Oak Dr, 12 Birch Ln" splits).
      const segments = raw
        .split(/\s*(?:\r?\n|;|\||&|\band\b|,\s*(?=\d))\s*/i)
        .map((s) => s.trim())
        .filter(Boolean);
      const addrSegs = segments.filter((s) => STREET_START.test(s));
      const count = addrSegs.length || streets.length;
      const addressVariable = (addrSegs.length ? addrSegs : [raw]).join(", ");
      return {
        caseType: count >= 2 ? "multiple" : "single",
        addressVariable,
        addressSource: "calendly",
        ambiguous: addrSegs.length > 0 && addrSegs.length !== streets.length,
      };
    }

    if (zips.length >= 1) {
      return {
        caseType: "zip",
        addressVariable: zips.join(", "),
        addressSource: "calendly",
        ambiguous: false,
      };
    }

    // Something typed, but not a recognizable address or zip (e.g. a city name).
    return {
      caseType: "area",
      addressVariable: raw,
      addressSource: "calendly",
      ambiguous: true,
    };
  }

  // Blank field -> fall back to the prospect's metro from our DB.
  if (fallbackArea && fallbackArea.trim()) {
    return {
      caseType: "area",
      addressVariable: fallbackArea.trim(),
      addressSource: "db_fallback",
      ambiguous: false,
    };
  }

  return { caseType: "area", addressVariable: null, addressSource: "none", ambiguous: false };
}

/**
 * Deterministic "random" valid-email count in [250, 300], frozen per booking.
 * Seeded off the booking id so the number the rep QAs is exactly what sends,
 * and re-renders never drift. Only used for single/multiple address cases.
 */
export function frozenCount(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 250 + (Math.abs(h) % 51); // 250..300 inclusive
}

/** Whether this case uses a numeric count at all. */
export function usesCount(caseType: CaseType): boolean {
  return caseType === "single" || caseType === "multiple";
}

const CTA =
  "Are there any other active listings/sales or zip codes you want us to do beforehand? We might as well — happy to do it.";
const TAIL = "We can show you this more visually tomorrow.";

export interface T1Args {
  caseType: CaseType;
  addressVariable: string | null;
  count?: number | null;
}

/**
 * Render the T-1 confirmation text. Leads with the address variable.
 */
export function renderT1({ caseType, addressVariable, count }: T1Args): string {
  const lead = addressVariable && addressVariable.trim() ? addressVariable.trim() : "The area we looked at";

  let countSentence: string;
  switch (caseType) {
    case "single":
      countSentence = `We have about ${count} valid emails, and 500+ if we expand the radius further.`;
      break;
    case "multiple":
      countSentence = `We have an average of about ${count} valid emails around each one, and 500+ if we expand the radius further.`;
      break;
    case "zip":
    case "area":
    default:
      countSentence = `There's a solid amount of valid emails we can hit.`;
      break;
  }

  return `${lead} email counts are done. ${countSentence} ${TAIL} ${CTA}`;
}

export type DayOfVariant = "standard" | "again";

export interface DayOfArgs {
  variant: DayOfVariant;
  demoTimeLabel: string; // e.g. "10:00 AM PST"
  firstName: string;
}

/**
 * Render the day-of testimonial text. The testimonial video is attached
 * separately via media_url — the copy just references it.
 */
export function renderDayOf({ variant, demoTimeLabel, firstName }: DayOfArgs): string {
  if (variant === "again") {
    return `Dropping this again if you missed it last time — talk at ${demoTimeLabel}! Let me know you got the invite. Thanks.`;
  }
  return `Meant to send this yesterday — here's our Grassfed testimonial. Let me know you've got that invite for ${demoTimeLabel}! Thanks ${firstName}.`;
}

/** First name for the {first_name} variable. */
export function firstNameOf(prospectName: string): string {
  const n = (prospectName || "").trim().split(/\s+/)[0];
  return n || "there";
}

/**
 * Format a demo time in the prospect's local timezone, e.g. "10:00 AM PST".
 * Falls back to ET (the app's default) when no prospect timezone is known.
 */
export function formatDemoTime(demoDate: Date, timezone?: string | null): string {
  const tz = timezone && timezone.trim() ? timezone : "America/New_York";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
      timeZoneName: "short",
    }).format(demoDate);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      timeZoneName: "short",
    }).format(demoDate);
  }
}
