import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { sanitizeTeamWrite } from "@/lib/team-write";
import { buildUnmappedSeats, loadTrellusRoster, parseUnmappedResourceIds } from "@/lib/trellus-roster";

async function requireAdmin() {
  const session = await getSession();
  if (!session) {
    return { session: null, error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  if (!session.isAdmin) {
    return { session: null, error: NextResponse.json({ error: "Admin only" }, { status: 403 }) };
  }
  return { session, error: null };
}

function withoutPin<T extends { pin: string | null }>(member: T): Omit<T, "pin"> {
  const { pin, ...rest } = member;
  void pin;
  return rest;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002";
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const members = await prisma.teamMember.findMany({
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });

  // PINs are credentials. Dropdown callers (setters, closers) get the roster
  // without them; the team admin page is the only surface that needs the flag.
  const visible = session.isAdmin ? members : members.map(withoutPin);

  if (!session.isAdmin) {
    return NextResponse.json({ members: visible });
  }

  const latest = await prisma.syncLog.findFirst({
    where: { source: "trellus", status: "success" },
    orderBy: { startedAt: "desc" },
  });
  const roster = await loadTrellusRoster(process.env.TRELLUS_API_KEY);
  const unmapped = buildUnmappedSeats(
    parseUnmappedResourceIds(latest?.errorMessage),
    roster.users,
    members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      isActive: m.isActive,
      trellusUserId: m.trellusUserId,
    })),
  );

  const unattributedBookings = await prisma.booking.findMany({
    where: { setterId: null, unmatchedBookedBy: { not: null }, supersededAt: null },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      prospectName: true,
      demoDate: true,
      unmatchedBookedBy: true,
      createdAt: true,
      demo: { select: { id: true } },
    },
  });

  return NextResponse.json({
    members: visible,
    trellus: {
      rosterAvailable: roster.available,
      syncedAt: latest?.completedAt ?? latest?.startedAt ?? null,
      unmapped,
    },
    unattributedBookings,
  });
}

export async function POST(request: NextRequest) {
  const { error: authError } = await requireAdmin();
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const parsed = sanitizeTeamWrite(body, "create");
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const member = await prisma.teamMember.create({
      data: {
        name: parsed.data.name!,
        role: parsed.data.role!,
        tier: parsed.data.tier ?? 1,
        slackUserId: parsed.data.slackUserId ?? null,
        email: parsed.data.email ?? null,
        excludeFromLeaderboard: parsed.data.excludeFromLeaderboard ?? false,
        trellusUserId: parsed.data.trellusUserId ?? null,
      },
    });
    return NextResponse.json({ member });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "That Trellus ID is already linked to someone else" }, { status: 409 });
    }
    throw error;
  }
}

export async function PATCH(request: NextRequest) {
  const { session, error: authError } = await requireAdmin();
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const parsed = sanitizeTeamWrite(body, "update");
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const existing = await prisma.teamMember.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Team member not found" }, { status: 404 });

  try {
    const member = await prisma.teamMember.update({
      where: { id },
      data: parsed.data,
    });
    await prisma.auditLog.create({
      data: {
        entityType: "team_member",
        entityId: id,
        action: "team_member_updated",
        newValue: JSON.stringify(parsed.data),
        performedBy: session!.name,
      },
    });
    return NextResponse.json({ member });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "That Trellus ID is already linked to someone else" }, { status: 409 });
    }
    throw error;
  }
}
