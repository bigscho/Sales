// Confirmations worklist builder — computes the T-1 and day-of lists live from
// Booking/Demo + the ConfirmationSend log. Nothing here is cached: the case
// type, address variable and frozen count derive deterministically from the
// booking row, so what the rep sees is always current and exactly what sends.
import { prisma } from "@/lib/db";
import {
  classifyListingInput,
  frozenCount,
  usesCount,
  renderT1,
  renderDayOf,
  firstNameOf,
  formatDemoTime,
  type CaseType,
  type AddressSource,
  type DayOfVariant,
} from "./copy";

// === PHONE NORMALIZATION ===

/** Last 10 digits — good enough to match US numbers across formats. */
export function normalizePhone(p: string | number | null | undefined): string | null {
  // SendBlue returns some phone fields as numbers, not strings — coerce before
  // .replace or the whole group sync throws and silently persists nothing.
  const digits = String(p ?? "").replace(/\D/g, "");
  if (digits.length < 10) return digits || null;
  return digits.slice(-10);
}

// === ET DAY BOUNDARIES (mirrors api/demos/today) ===

export function etDayRange(offsetDays: number): { start: Date; end: Date } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === "year")!.value);
  const month = parseInt(parts.find((p) => p.type === "month")!.value) - 1;
  const day = parseInt(parts.find((p) => p.type === "day")!.value);

  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const diffMs = now.getTime() - new Date(etString).getTime();

  const start = new Date(Date.UTC(year, month, day + offsetDays) + diffMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

// === ROW SHAPE ===

export interface WorklistRow {
  bookingId: string;
  prospectName: string;
  prospectFirstName: string;
  prospectPhone: string | null;
  prospectEmail: string | null;
  demoDate: string; // ISO
  demoTimeLabel: string; // prospect-local, e.g. "10:00 AM PDT"
  closerName: string | null;
  setterName: string | null;
  // T-1 variable resolution
  caseType: CaseType;
  addressVariable: string | null;
  addressSource: AddressSource;
  ambiguous: boolean;
  emailCount: number | null;
  // Message
  body: string;
  variant?: DayOfVariant; // day-of only
  // Send routing
  groupId: string | null;
  // State
  sendable: boolean;
  skipReason: string | null; // already_contacted | rescheduled_in | cancelled | no_phone
  blockReason: string | null; // no_group
  sendStatus: "not_sent" | "sent" | "failed";
  sentDryRun: boolean;
  sentAt: string | null;
}

export interface ReadinessMetrics {
  windowDays: number;
  totalSent: number;
  editedCount: number;
  editRate: number | null;
  skippedCount: number;
  fallbackEdited: number;
  autoSentShare: number | null;
}

// === HELPERS ===

type BookingWithRels = Awaited<ReturnType<typeof fetchBookingsInRange>>[number];

async function fetchBookingsInRange(start: Date, end: Date) {
  return prisma.booking.findMany({
    where: {
      demoDate: { gte: start, lt: end },
      supersededAt: null,
    },
    include: {
      demo: { include: { closer: true } },
      setter: true,
    },
    orderBy: { demoDate: "asc" },
  });
}

/** DB area fallback: prospect's city from the Agent table, matched by email. */
async function lookupFallbackArea(email: string | null): Promise<string | null> {
  if (!email) return null;
  const agent = await prisma.agent.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { city: true, state: true },
  });
  return agent?.city || agent?.state || null;
}

/** Find the SendBlue group for a booking (by explicit match or phone). */
async function lookupGroup(bookingId: string, phone: string | null): Promise<string | null> {
  const norm = normalizePhone(phone);
  const group = await prisma.sendblueGroup.findFirst({
    where: {
      OR: [
        { bookingId },
        ...(norm
          ? [{ prospectPhone: { contains: norm } }, { participants: { contains: norm } }]
          : []),
      ],
    },
    orderBy: { lastInboundAt: "desc" },
  });
  return group?.groupId || null;
}

/**
 * Discover groups by polling SendBlue's message history (no webhook needed).
 * Runs before each worklist build; the inbound webhook, if configured, just
 * makes the same data arrive sooner. Never throws — a SendBlue hiccup
 * shouldn't take down the worklist.
 */
export async function syncGroupsFromApi(): Promise<void> {
  try {
    const { listMessages, SENDBLUE_LINE } = await import("@/lib/sendblue");
    const msgs = await listMessages(500);
    const lineNorm = normalizePhone(SENDBLUE_LINE);

    // group_id -> set of participant numbers seen (excluding our line)
    const groups = new Map<string, { numbers: Set<string>; lastInbound: string | null }>();
    for (const m of msgs) {
      if (!m.group_id) continue;
      const entry = groups.get(m.group_id) || { numbers: new Set<string>(), lastInbound: null };
      // Capture the WHOLE group roster, not just the sender. SendBlue's message
      // object carries a `participants` array of every member; from_number is
      // only whoever sent this one message (usually the setter or our line), so
      // matching a booking by the prospect's phone fails if we store just that.
      const candidates = [
        ...(Array.isArray(m.participants) ? m.participants : []),
        m.from_number,
        m.number,
        m.to_number,
      ];
      for (const c of candidates) {
        if (c && normalizePhone(c) !== lineNorm) entry.numbers.add(c);
      }
      if (!m.is_outbound && m.date_sent && (!entry.lastInbound || m.date_sent > entry.lastInbound)) {
        entry.lastInbound = m.date_sent;
      }
      groups.set(m.group_id, entry);
    }

    for (const [groupId, entry] of groups) {
      const numbers = Array.from(entry.numbers);
      const existing = await prisma.sendblueGroup.findUnique({ where: { groupId } });
      if (existing) {
        const merged = Array.from(
          new Set([
            ...(existing.participants ? (JSON.parse(existing.participants) as string[]) : []),
            ...numbers,
          ])
        );
        await prisma.sendblueGroup.update({
          where: { groupId },
          data: {
            participants: JSON.stringify(merged),
            ...(entry.lastInbound ? { lastInboundAt: new Date(entry.lastInbound) } : {}),
          },
        });
      } else {
        await prisma.sendblueGroup.create({
          data: {
            groupId,
            participants: JSON.stringify(numbers),
            prospectPhone: numbers[0] || null,
            lastInboundAt: entry.lastInbound ? new Date(entry.lastInbound) : null,
          },
        });
      }
    }
  } catch (err) {
    console.error("SendBlue group sync failed (worklist continues):", err);
  }
}

/**
 * "Ever texted this prospect this touchpoint" — the hard dedup gate. Counts
 * REAL sends only (dry runs don't mark a prospect as contacted).
 */
async function everSent(
  touchpoint: "t1" | "day_of",
  email: string | null,
  phone: string | null
): Promise<boolean> {
  const norm = normalizePhone(phone);
  const conds: object[] = [];
  if (email) conds.push({ prospectEmail: { equals: email, mode: "insensitive" } });
  if (norm) conds.push({ prospectPhone: { contains: norm } });
  if (conds.length === 0) return false;
  const hit = await prisma.confirmationSend.findFirst({
    where: { touchpoint, status: "sent", dryRun: false, OR: conds },
    select: { id: true },
  });
  return !!hit;
}

/** Latest send for this booking+touchpoint — drives row status display. */
async function latestSend(bookingId: string, touchpoint: "t1" | "day_of") {
  return prisma.confirmationSend.findFirst({
    where: { bookingId, touchpoint, status: { in: ["sent", "failed"] } },
    orderBy: { createdAt: "desc" },
  });
}

// === T-1 WORKLIST (tomorrow's brand-new demos) ===

export async function buildT1Worklist(): Promise<WorklistRow[]> {
  await syncGroupsFromApi(); // learn any new setter-created groups first
  const { start, end } = etDayRange(1); // tomorrow ET
  const bookings = await fetchBookingsInRange(start, end);
  const rows: WorklistRow[] = [];
  for (const b of bookings) {
    rows.push(await buildT1Row(b));
  }
  return rows;
}

async function buildT1Row(b: BookingWithRels): Promise<WorklistRow> {
  const fallbackArea = b.listingAddress ? null : await lookupFallbackArea(b.prospectEmail);
  const cls = classifyListingInput(b.listingAddress, fallbackArea);
  const count = usesCount(cls.caseType) ? frozenCount(b.id) : null;
  const body = renderT1({ caseType: cls.caseType, addressVariable: cls.addressVariable, count });

  const groupId = await lookupGroup(b.id, b.prospectPhone);
  const send = await latestSend(b.id, "t1");

  // Brand-new-only rule, layered:
  //  1. send-log (primary): ever really texted this prospect the T-1 ask -> skip
  //  2. reschedule flag (secondary): row exists because a demo moved -> skip
  //  3. cancelled -> skip
  let skipReason: string | null = null;
  const demoStatus = b.demo?.status || "pending";
  if (demoStatus === "cancelled") skipReason = "cancelled";
  else if (!send && (await everSent("t1", b.prospectEmail, b.prospectPhone))) skipReason = "already_contacted";
  else if (b.rescheduledFromId) skipReason = "rescheduled_in";
  else if (!b.prospectPhone) skipReason = "no_phone";

  const blockReason = !skipReason && !groupId ? "no_group" : null;

  return {
    bookingId: b.id,
    prospectName: b.prospectName,
    prospectFirstName: firstNameOf(b.prospectName),
    prospectPhone: b.prospectPhone,
    prospectEmail: b.prospectEmail,
    demoDate: b.demoDate.toISOString(),
    demoTimeLabel: formatDemoTime(b.demoDate, b.prospectTimezone),
    closerName: b.demo?.closer?.name || null,
    setterName: b.setter?.name || null,
    caseType: cls.caseType,
    addressVariable: cls.addressVariable,
    addressSource: cls.addressSource,
    ambiguous: cls.ambiguous,
    emailCount: count,
    body,
    groupId,
    sendable: !skipReason && !blockReason && !send,
    skipReason,
    blockReason,
    sendStatus: send ? (send.status as "sent" | "failed") : "not_sent",
    sentDryRun: send?.dryRun ?? false,
    sentAt: send?.sentAt?.toISOString() || null,
  };
}

// === DAY-OF WORKLIST (everyone with a pending demo today) ===

export async function buildDayOfWorklist(): Promise<WorklistRow[]> {
  await syncGroupsFromApi(); // learn any new setter-created groups first
  const { start, end } = etDayRange(0); // today ET
  const bookings = await fetchBookingsInRange(start, end);
  const rows: WorklistRow[] = [];
  for (const b of bookings) {
    const demoStatus = b.demo?.status || "pending";
    if (demoStatus !== "pending") continue; // cancelled/showed/etc drop off
    rows.push(await buildDayOfRow(b));
  }
  return rows;
}

async function buildDayOfRow(b: BookingWithRels): Promise<WorklistRow> {
  // Variant keys off the send-log, not the reschedule flag: only someone who
  // actually RECEIVED a day-of before gets the "again" copy.
  const gotOneBefore = await everSent("day_of", b.prospectEmail, b.prospectPhone);
  const variant: DayOfVariant = gotOneBefore ? "again" : "standard";
  const demoTimeLabel = formatDemoTime(b.demoDate, b.prospectTimezone);
  const body = renderDayOf({ variant, demoTimeLabel, firstName: firstNameOf(b.prospectName) });

  const groupId = await lookupGroup(b.id, b.prospectPhone);
  const send = await latestSend(b.id, "day_of");

  const skipReason = !b.prospectPhone ? "no_phone" : null;
  const blockReason = !skipReason && !groupId ? "no_group" : null;

  // No listing classification needed day-of, but keep the shape consistent.
  return {
    bookingId: b.id,
    prospectName: b.prospectName,
    prospectFirstName: firstNameOf(b.prospectName),
    prospectPhone: b.prospectPhone,
    prospectEmail: b.prospectEmail,
    demoDate: b.demoDate.toISOString(),
    demoTimeLabel,
    closerName: b.demo?.closer?.name || null,
    setterName: b.setter?.name || null,
    caseType: "area",
    addressVariable: null,
    addressSource: "none",
    ambiguous: false,
    emailCount: null,
    body,
    variant,
    groupId,
    sendable: !skipReason && !blockReason && !send,
    skipReason,
    blockReason,
    sendStatus: send ? (send.status as "sent" | "failed") : "not_sent",
    sentDryRun: send?.dryRun ?? false,
    sentAt: send?.sentAt?.toISOString() || null,
  };
}

// === AUTOMATION READINESS (trailing window over real approvals) ===

export async function readinessMetrics(windowDays = 14): Promise<ReadinessMetrics> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const sends = await prisma.confirmationSend.findMany({
    where: { touchpoint: "t1", createdAt: { gte: since } },
    select: { status: true, edited: true, autoSent: true, dryRun: true, addressSource: true },
  });
  const sent = sends.filter((s) => s.status === "sent");
  const skipped = sends.filter((s) => s.status === "skipped");
  const edited = sent.filter((s) => s.edited);
  const auto = sent.filter((s) => s.autoSent);
  return {
    windowDays,
    totalSent: sent.length,
    editedCount: edited.length,
    editRate: sent.length ? edited.length / sent.length : null,
    skippedCount: skipped.length,
    fallbackEdited: edited.filter((s) => s.addressSource === "db_fallback").length,
    autoSentShare: sent.length ? auto.length / sent.length : null,
  };
}
