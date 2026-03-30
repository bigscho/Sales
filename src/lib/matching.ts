import { prisma } from "./db";

/**
 * Normalize a name for fuzzy matching.
 * "Rebecca Norris DiNapoli Norris DiNapoli" → "rebecca norris dinapoli"
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((w, i, arr) => arr.indexOf(w) === i) // dedupe words
    .join(" ")
    .trim();
}

/**
 * Check if two names likely refer to the same person.
 * Uses first+last name matching with fuzzy tolerance.
 */
function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);

  if (na === nb) return true;

  // Check if first and last names match
  const partsA = na.split(" ");
  const partsB = nb.split(" ");

  if (partsA.length === 0 || partsB.length === 0) return false;

  // First name match + any last name word match
  if (partsA[0] === partsB[0]) {
    const lastWordsA = new Set(partsA.slice(1));
    const lastWordsB = new Set(partsB.slice(1));
    for (const w of lastWordsA) {
      if (lastWordsB.has(w)) return true;
    }
  }

  // One name contains the other
  if (na.includes(nb) || nb.includes(na)) return true;

  return false;
}

interface MatchResult {
  type: "auto_matched" | "needs_review";
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * Try to match a Stripe payment to a demo booking by customer name/email.
 */
export async function matchPaymentToDemo(payment: {
  customerName?: string | null;
  customerEmail?: string | null;
}): Promise<{ bookingId: string | null; demoId: string | null; result: MatchResult }> {
  if (!payment.customerName && !payment.customerEmail) {
    return {
      bookingId: null,
      demoId: null,
      result: { type: "needs_review", confidence: "low", reason: "No customer name or email on payment" },
    };
  }

  // Try exact email match first
  if (payment.customerEmail) {
    const booking = await prisma.booking.findFirst({
      where: { prospectEmail: { equals: payment.customerEmail, mode: "insensitive" } },
      include: { demo: true },
      orderBy: { demoDate: "desc" },
    });
    if (booking) {
      return {
        bookingId: booking.id,
        demoId: booking.demo?.id || null,
        result: { type: "auto_matched", confidence: "high", reason: `Email match: ${payment.customerEmail}` },
      };
    }
  }

  // Try name match
  if (payment.customerName) {
    const allBookings = await prisma.booking.findMany({
      include: { demo: true },
      orderBy: { demoDate: "desc" },
    });

    for (const booking of allBookings) {
      if (namesMatch(payment.customerName, booking.prospectName)) {
        return {
          bookingId: booking.id,
          demoId: booking.demo?.id || null,
          result: {
            type: "auto_matched",
            confidence: "medium",
            reason: `Name match: "${payment.customerName}" ≈ "${booking.prospectName}"`,
          },
        };
      }
    }
  }

  return {
    bookingId: null,
    demoId: null,
    result: {
      type: "needs_review",
      confidence: "low",
      reason: `No match found for "${payment.customerName || payment.customerEmail}"`,
    },
  };
}

/**
 * Match a Fireflies transcript to a demo by title pattern.
 * Fireflies titles: "Tony Lee and Mark Whittelsey"
 * Calendar events: "Tony Lee and Colin Schofield"
 */
export function matchTranscriptToDemo(
  transcriptTitle: string,
  transcriptDate: string,
  bookings: { id: string; prospectName: string; demoDate: Date }[]
): { bookingId: string | null; confidence: "high" | "medium" | "low"; reason: string } {
  // Extract prospect name from transcript title
  // Pattern: "Prospect Name and Closer Name"
  const andMatch = transcriptTitle.match(/^(.+?)\s+and\s+/i);
  const prospectFromTitle = andMatch ? andMatch[1].trim() : transcriptTitle;

  // Also handle "Prospect // Grassfed Next Steps" pattern
  const slashMatch = transcriptTitle.match(/^(.+?)\s*\/\//);
  const prospectFromSlash = slashMatch ? slashMatch[1].trim() : null;

  const prospectName = prospectFromSlash || prospectFromTitle;
  const transcriptDateStr = transcriptDate.slice(0, 10);

  // Try to match by name + date
  for (const booking of bookings) {
    const bookingDateStr = booking.demoDate.toISOString().slice(0, 10);

    // Same day + name match = high confidence
    if (bookingDateStr === transcriptDateStr && namesMatch(prospectName, booking.prospectName)) {
      return {
        bookingId: booking.id,
        confidence: "high",
        reason: `Name + date match: "${prospectName}" on ${transcriptDateStr}`,
      };
    }
  }

  // Try name only (within 2 days) for medium confidence
  for (const booking of bookings) {
    const bookingDate = new Date(booking.demoDate).getTime();
    const tDate = new Date(transcriptDate).getTime();
    const daysDiff = Math.abs(bookingDate - tDate) / (1000 * 60 * 60 * 24);

    if (daysDiff <= 2 && namesMatch(prospectName, booking.prospectName)) {
      return {
        bookingId: booking.id,
        confidence: "medium",
        reason: `Name match within ${Math.round(daysDiff)}d: "${prospectName}" ≈ "${booking.prospectName}"`,
      };
    }
  }

  return {
    bookingId: null,
    confidence: "low",
    reason: `No booking match for transcript: "${prospectName}"`,
  };
}

/**
 * Auto-detect show/no-show for demos using Fireflies transcripts.
 * Returns list of demos with detection results.
 */
export async function autoDetectShows(
  weekId: string,
  transcripts: { id: string; title: string; dateString: string; duration: number }[]
): Promise<{
  autoMarked: { demoId: string; prospectName: string; status: string; reason: string }[];
  needsReview: { demoId: string; prospectName: string; reason: string }[];
}> {
  const demos = await prisma.demo.findMany({
    where: { weekId, status: "pending" },
    include: { booking: true },
  });

  const bookings = demos.map((d) => ({
    id: d.booking.id,
    demoId: d.id,
    prospectName: d.booking.prospectName,
    demoDate: d.booking.demoDate,
  }));

  const autoMarked: { demoId: string; prospectName: string; status: string; reason: string }[] = [];
  const needsReview: { demoId: string; prospectName: string; reason: string }[] = [];
  const matchedDemoIds = new Set<string>();

  // For each transcript, try to match to a demo
  for (const transcript of transcripts) {
    // Skip very short recordings (< 30 seconds) — likely no real meeting
    if (transcript.duration < 0.5) continue;

    const match = matchTranscriptToDemo(
      transcript.title,
      transcript.dateString,
      bookings.map((b) => ({ id: b.id, prospectName: b.prospectName, demoDate: b.demoDate }))
    );

    if (match.bookingId && match.confidence !== "low") {
      const booking = bookings.find((b) => b.id === match.bookingId);
      if (booking && !matchedDemoIds.has(booking.demoId)) {
        matchedDemoIds.add(booking.demoId);
        autoMarked.push({
          demoId: booking.demoId,
          prospectName: booking.prospectName,
          status: "showed",
          reason: `Fireflies recording found (${match.confidence}): ${match.reason}`,
        });
      }
    }
  }

  // Demos with no transcript match need review
  for (const booking of bookings) {
    if (!matchedDemoIds.has(booking.demoId)) {
      // Check if demo date is in the past
      const now = new Date();
      if (booking.demoDate < now) {
        needsReview.push({
          demoId: booking.demoId,
          prospectName: booking.prospectName,
          reason: "No Fireflies recording found — confirm manually",
        });
      }
    }
  }

  return { autoMarked, needsReview };
}
