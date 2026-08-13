import { prisma } from "./db";

// Lead-source model (closer 1099 contract §4.6): a deal is Self-Sourced only if
// the closer both originated the lead AND booked the demo. Source is fixed at
// the moment the demo is booked; reschedule successors inherit it from the
// original row. Any ambiguity resolves to "fed" (§4.12(b)).
//
// Detection: the closer books through the same Calendly flow the setters use
// and types their own name into the "Booked by" field. When that name matches
// the closer hosting the demo, the booking is self-sourced. Everything else —
// setter name, blank, mismatched host — is fed.

export const LEAD_SOURCE_FED = "fed";
export const LEAD_SOURCE_SELF = "self_sourced";

// Setter identities that are the same human as a closer (per Colin 2026-08-13:
// "Matthew is Ming"). A booking this setter makes onto their own closer
// calendar is full-cycle self-sourced (§4.6). The setter row keeps the booking
// credit on the setter scoreboard — only leadSource (and therefore the closer
// commission rate) is affected, and only when the host closer is the same person.
export const SETTER_CLOSER_IDENTITIES: Record<string, string> = {
  "setter-ming": "closer-matthew",
};

export function isSelfSourcedViaIdentity(setterId: string | null, hostCloserId: string | null): boolean {
  return !!setterId && !!hostCloserId && SETTER_CLOSER_IDENTITIES[setterId] === hostCloserId;
}

// Returns the closer TeamMember matched by a booked-by name, or null.
// Used both to detect self-sourced bookings and to avoid auto-creating a junk
// setter TeamMember when a closer's name lands in the "Booked by" field.
export async function matchCloserByName(name: string | null) {
  if (!name) return null;
  return prisma.teamMember.findFirst({
    where: { name: { contains: name, mode: "insensitive" }, role: "closer" },
  });
}

// Resolve lead source for a brand-new booking: self-sourced only when the
// booked-by name is the closer hosting the demo.
export async function resolveLeadSource(
  bookedByName: string | null,
  hostCloserId: string | null
): Promise<string> {
  if (!bookedByName || !hostCloserId) return LEAD_SOURCE_FED;
  const closer = await matchCloserByName(bookedByName);
  return closer && closer.id === hostCloserId ? LEAD_SOURCE_SELF : LEAD_SOURCE_FED;
}
