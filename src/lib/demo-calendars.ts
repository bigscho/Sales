// Demo calendars and the provisional closer guess.
//
// The credited closer comes from the Fireflies recording once it exists.
// Until then, a personal closer calendar (Colin or Matthew at grsfd.co) may
// stamp a provisional closer. Shared calendars must not: the cold-email
// calendar's Calendly user is named "Colin Schofield" (colin@grassfed.tech)
// and the admin calendar is admin@grassfed.tech, but either closer may run
// the call. A display name is never enough to credit someone.

export const COLIN_PERSONAL_EMAIL = "colin@grsfd.co";
export const MATTHEW_PERSONAL_EMAIL = "matthew@grsfd.co";
export const COLD_EMAIL_CALENDAR_EMAIL = "colin@grassfed.tech";
export const ADMIN_CALENDAR_EMAIL = "admin@grassfed.tech";

export const COLD_EMAIL_EVENT_NAME = "Grassfed Cold Email: Just Listed/Sold/Closed";

const PERSONAL_CLOSER_BY_EMAIL: Record<string, "Colin" | "Matthew"> = {
  [COLIN_PERSONAL_EMAIL]: "Colin",
  [MATTHEW_PERSONAL_EMAIL]: "Matthew",
};

// Emails that belong to a demo calendar but are not a closer identity.
const SHARED_CALENDAR_EMAILS = new Set([COLD_EMAIL_CALENDAR_EMAIL, ADMIN_CALENDAR_EMAIL]);

export type DemoCalendarSync = {
  email: string;
  /** Composite calendarEventId suffix. Colin/Matthew stay unchanged so existing rows still match. */
  idSuffix: string;
  /** Set only for a personal closer calendar. */
  provisionalCloserName: "Colin" | "Matthew" | null;
};

export function demoCalendarsForSync(): DemoCalendarSync[] {
  return [
    { email: COLIN_PERSONAL_EMAIL, idSuffix: "Colin", provisionalCloserName: "Colin" },
    { email: MATTHEW_PERSONAL_EMAIL, idSuffix: "Matthew", provisionalCloserName: "Matthew" },
    { email: ADMIN_CALENDAR_EMAIL, idSuffix: "Admin", provisionalCloserName: null },
    { email: COLD_EMAIL_CALENDAR_EMAIL, idSuffix: "ColdEmail", provisionalCloserName: null },
  ];
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

export function isSharedDemoCalendarEmail(email: string | null | undefined): boolean {
  const n = normalizeEmail(email);
  return !!n && SHARED_CALENDAR_EMAILS.has(n);
}

export function isKnownDemoCalendarEmail(email: string | null | undefined): boolean {
  const n = normalizeEmail(email);
  if (!n) return false;
  return n in PERSONAL_CLOSER_BY_EMAIL || SHARED_CALENDAR_EMAILS.has(n);
}

/** Personal closer calendars only. Shared calendars and unknown addresses return null. */
export function provisionalCloserFirstName(hostEmail: string | null | undefined): "Colin" | "Matthew" | null {
  const n = normalizeEmail(hostEmail);
  if (!n) return null;
  return PERSONAL_CLOSER_BY_EMAIL[n] ?? null;
}

/**
 * Provisional closer for one Calendly booking.
 * Round robin uses the assigned host's email (the calendar the meeting landed on).
 * Every other event uses the event-type owner, not co-host memberships — a
 * shadower on the invite must not take the provisional credit.
 * colin@grassfed.tech and admin@grassfed.tech never resolve, even though the
 * cold-email profile is named Colin Schofield.
 */
export function provisionalCloserFromHost(opts: {
  eventTypeOwnerEmail: string | null | undefined;
  poolingType: string | null | undefined;
  membershipEmails: (string | null | undefined)[];
}): "Colin" | "Matthew" | null {
  const pooling = (opts.poolingType || "").toLowerCase();
  const memberships = opts.membershipEmails
    .map((e) => normalizeEmail(e))
    .filter((e): e is string => !!e);

  if (pooling === "round_robin" || pooling === "multi_pool") {
    const personal = uniquePersonal(memberships);
    return personal.length === 1 ? personal[0] : null;
  }

  const fromOwner = provisionalCloserFirstName(opts.eventTypeOwnerEmail);
  if (fromOwner) return fromOwner;
  if (isSharedDemoCalendarEmail(opts.eventTypeOwnerEmail)) return null;

  // Owner email missing. A single personal-closer membership is the host.
  // More than one membership is a shadow / co-host — leave it for the recording.
  if (memberships.length === 1) {
    const personal = uniquePersonal(memberships);
    return personal.length === 1 ? personal[0] : null;
  }
  return null;
}

function uniquePersonal(emails: string[]): ("Colin" | "Matthew")[] {
  const names = new Set<"Colin" | "Matthew">();
  for (const email of emails) {
    const name = provisionalCloserFirstName(email);
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * Sales-demo event types only. Onboarding, launch, quick calls, and reconnects
 * are not demos. The cold-email calendar's event is a demo even though the
 * Calendly user is named Colin.
 * Unknown names stay included (same permissive behavior as before) so a
 * missing "Event Name" line does not drop a real booking.
 */
export function isDemoEventType(eventTypeName: string | null | undefined): boolean {
  if (!eventTypeName || !eventTypeName.trim()) return true;
  const n = eventTypeName.toLowerCase();
  if (n.includes("reconnect")) return false;
  if (isColdEmailDemoEvent(n)) return true;
  if (/\bonboarding\b/.test(n) || n.includes("launch call") || n.includes("quick call")) return false;
  return (
    n.includes("farm") ||
    n.includes("just") ||
    n.includes("demo") ||
    n.includes("e-mailers") ||
    n.includes("setup") ||
    n.includes("cold email")
  );
}

export function isColdEmailDemoEvent(eventTypeName: string | null | undefined): boolean {
  if (!eventTypeName) return false;
  const n = eventTypeName.toLowerCase();
  if (!n.includes("cold email")) return false;
  return n.includes("just listed") || n.includes("just sold") || n.includes("just closed") || n.includes("listed/sold");
}

/**
 * Guest copy of a demo that another calendar owns. Shared calendars do not
 * use the summary name: "Prospect and Colin Schofield" is the cold-email
 * calendar's title, not proof Colin is hosting.
 */
export function eventBelongsToOtherDemoCalendar(args: {
  organizerEmail: string | null | undefined;
  summary: string | null | undefined;
  calendarEmail: string;
}): boolean {
  const organizer = normalizeEmail(args.organizerEmail);
  const self = normalizeEmail(args.calendarEmail);
  if (organizer && self && organizer !== self && isKnownDemoCalendarEmail(organizer)) {
    return true;
  }
  const personal = provisionalCloserFirstName(self);
  if (!personal) return false;
  const summaryCloser = (args.summary || "").match(/\s+and\s+(Colin|Will|Matthew|Mark)(\s+\w+)?\s*$/i)?.[1];
  if (summaryCloser && summaryCloser.toLowerCase() !== personal.toLowerCase()) return true;
  return false;
}
