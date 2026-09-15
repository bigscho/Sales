// Setters sometimes type shorthand initials into the Calendly "Booked by"
// field instead of their name (e.g. Solomon types "SG"). The TeamMember
// lookup requires the stored name to contain the typed string, so shorthand
// never matches and the booking either goes unattributed or spawns a junk
// excludeFromLeaderboard row. Resolve known shorthand to the canonical
// TeamMember.name before any lookup.
//
// Keys: the shorthand, lowercase. Values: the EXACT TeamMember.name in the DB.
// Matching is whole-string (trimmed, case-insensitive) — "SG" resolves,
// "sgt pepper" does not.
const SETTER_ALIASES: Record<string, string> = {
  sg: "Solomon Gerges",
};

export function resolveSetterAlias(name: string | null): string | null {
  if (!name) return name;
  return SETTER_ALIASES[name.trim().toLowerCase()] ?? name;
}
