// Allowlist for POST/PATCH /api/team. The previous handler spread the request
// body straight into Prisma, so any authenticated caller (the middleware treats
// /api/team as a read-only dropdown route) could write pin, isAdmin, creditBalance.

export const TEAM_ROLES = ["setter", "closer", "show_rate_rep"] as const;
export const ACCESS_ROLES = ["setter", "closer", "show_rate_rep", "confirmations_rep"] as const;

export interface TeamWriteData {
  name?: string;
  role?: (typeof TEAM_ROLES)[number];
  tier?: number;
  slackUserId?: string | null;
  email?: string | null;
  pin?: string | null;
  excludeFromLeaderboard?: boolean;
  isActive?: boolean;
  isAdmin?: boolean;
  accessRole?: (typeof ACCESS_ROLES)[number] | null;
  blastZones?: string | null;
  trellusUserId?: string | null;
}

export type TeamWriteResult =
  | { ok: true; data: TeamWriteData }
  | { ok: false; error: string };

function optionalString(value: unknown, field: string, max: number): string | null | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) return { error: `${field} is too long` };
  return trimmed;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return { error: `${field} must be a boolean` };
  return value;
}

export function sanitizeTeamWrite(input: unknown, mode: "create" | "update"): TeamWriteResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid body" };
  }
  const body = input as Record<string, unknown>;
  const data: TeamWriteData = {};

  if (body.name !== undefined || mode === "create") {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return { ok: false, error: "Name is required" };
    }
    if (body.name.trim().length > 80) return { ok: false, error: "Name is too long" };
    data.name = body.name.trim();
  }

  if (body.role !== undefined || mode === "create") {
    if (typeof body.role !== "string" || !(TEAM_ROLES as readonly string[]).includes(body.role)) {
      return { ok: false, error: "Role must be setter, closer, or show_rate_rep" };
    }
    data.role = body.role as TeamWriteData["role"];
  }

  if (body.tier !== undefined && body.tier !== null && body.tier !== "") {
    const tier = typeof body.tier === "number" ? body.tier : Number(body.tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 4) {
      return { ok: false, error: "Tier must be 1-4" };
    }
    data.tier = tier;
  }

  const slackUserId = optionalString(body.slackUserId, "Slack ID", 32);
  if (slackUserId && typeof slackUserId === "object") return { ok: false, error: slackUserId.error };
  if (slackUserId !== undefined) data.slackUserId = slackUserId;

  const email = optionalString(body.email, "Email", 200);
  if (email && typeof email === "object") return { ok: false, error: email.error };
  if (email !== undefined) data.email = email;

  if (body.pin !== undefined) {
    if (body.pin === null || body.pin === "") {
      data.pin = null;
    } else if (typeof body.pin !== "string" || !/^\d{4,6}$/.test(body.pin)) {
      return { ok: false, error: "PIN must be 4-6 digits" };
    } else {
      data.pin = body.pin;
    }
  }

  for (const field of ["excludeFromLeaderboard", "isActive", "isAdmin"] as const) {
    const parsed = optionalBoolean(body[field], field);
    if (parsed && typeof parsed === "object") return { ok: false, error: parsed.error };
    if (parsed !== undefined) data[field] = parsed;
  }

  if (body.accessRole !== undefined) {
    if (body.accessRole === null || body.accessRole === "") {
      data.accessRole = null;
    } else if (
      typeof body.accessRole !== "string" ||
      !(ACCESS_ROLES as readonly string[]).includes(body.accessRole)
    ) {
      return { ok: false, error: "Invalid access role" };
    } else {
      data.accessRole = body.accessRole as TeamWriteData["accessRole"];
    }
  }

  if (body.blastZones !== undefined) {
    if (body.blastZones === null || body.blastZones === "") {
      data.blastZones = null;
    } else if (typeof body.blastZones !== "string") {
      return { ok: false, error: "blastZones must be a string" };
    } else if (body.blastZones.length > 20000) {
      return { ok: false, error: "blastZones is too long" };
    } else {
      data.blastZones = body.blastZones;
    }
  }

  if (body.trellusUserId !== undefined) {
    if (body.trellusUserId === null || body.trellusUserId === "") {
      data.trellusUserId = null;
    } else if (typeof body.trellusUserId !== "string") {
      return { ok: false, error: "Trellus ID must be a string" };
    } else {
      const id = body.trellusUserId.trim();
      if (!id) data.trellusUserId = null;
      else if (id.length > 128) return { ok: false, error: "Trellus ID is too long" };
      else data.trellusUserId = id;
    }
  }

  if (mode === "update" && Object.keys(data).length === 0) {
    return { ok: false, error: "No editable fields" };
  }

  return { ok: true, data };
}
