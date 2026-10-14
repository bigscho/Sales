// Setters sometimes type shorthand initials into the Calendly "Booked by"
// field instead of their name (e.g. Solomon types "SG"). The TeamMember
// lookup used to require the stored name to contain the typed string, so
// shorthand never matched and the webhook spawned a junk TeamMember. Resolve
// known shorthand to the canonical TeamMember.name before any lookup. A miss
// stays unattributed — it does not create a setter.
//
// Keys: the shorthand, lowercase. Values: the EXACT TeamMember.name in the DB.
// Matching is whole-string (trimmed, case-insensitive) — "SG" resolves,
// "sgt pepper" does not.
const SETTER_ALIASES: Record<string, string> = {
  sg: "Solomon Gerges",
  // Known self-typos of Solomon's last name (each once auto-created a junk
  // excludeFromLeaderboard row that silently absorbed his bookings).
  "solomon gergs": "Solomon Gerges",
  "solomon gerget": "Solomon Gerges",
  // Athan Pohlman — bare first name & initials. "Athan" also matches via the
  // contains lookup; the alias makes it explicit. "AP"/"ap" would NOT (no "ap"
  // substring in "athan pohlman"), so the alias is the only way those resolve.
  athan: "Athan Pohlman",
  ap: "Athan Pohlman",
  // Chris Carr — name + initials. Without "chris", the contains lookup would
  // match the active setter "Christian" (and "Chriszel"), so the alias is
  // required to disambiguate, not just explicit. "cc" has no substring in
  // "chris carr", so it only resolves via the alias. Keys are whole-string,
  // lowercased — "CC"/"Chris C" fold to "cc"/"chris c".
  chris: "Chris Carr",
  "chris c": "Chris Carr",
  "chris carr": "Chris Carr",
  cc: "Chris Carr",
};

export function resolveSetterAlias(name: string | null): string | null {
  if (!name) return name;
  return SETTER_ALIASES[name.trim().toLowerCase()] ?? name;
}
