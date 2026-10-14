import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildUnmappedSeats, loadTrellusRoster, parseUnmappedResourceIds } from "@/lib/trellus-roster";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002";
}

/** Empty or whitespace clears the link. Omitted on create becomes null. */
function readTrellusUserId(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "Trellus ID must be a string" };
  const id = value.trim();
  if (!id) return { ok: true, value: null };
  if (id.length > 128) return { ok: false, error: "Trellus ID is too long" };
  return { ok: true, value: id };
}

export async function GET(request: NextRequest) {
  const members = await prisma.teamMember.findMany({
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });

  // Dropdown callers stay on the plain roster. The team page asks for seats.
  if (request.nextUrl.searchParams.get("trellus") !== "1") {
    return NextResponse.json({ members });
  }

  const latest = await prisma.syncLog.findFirst({
    where: { source: "trellus", status: "success" },
    orderBy: { startedAt: "desc" },
  });
  const roster = await loadTrellusRoster(process.env.TRELLUS_API_KEY);
  const dialsById = parseUnmappedResourceIds(latest?.errorMessage);
  for (const member of members) {
    if (member.trellusUserId) delete dialsById[member.trellusUserId];
  }
  const unmapped = buildUnmappedSeats(
    dialsById,
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

  return NextResponse.json({
    members,
    trellus: {
      rosterAvailable: roster.available,
      syncedAt: latest?.completedAt ?? latest?.startedAt ?? null,
      unmapped,
    },
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, role, tier, slackUserId, excludeFromLeaderboard, trellusUserId } = body;
  const trellus = readTrellusUserId(trellusUserId);
  if (!trellus.ok) return NextResponse.json({ error: trellus.error }, { status: 400 });

  try {
    const member = await prisma.teamMember.create({
      data: {
        name,
        role,
        tier: tier || 1,
        slackUserId: slackUserId || null,
        excludeFromLeaderboard: excludeFromLeaderboard || false,
        trellusUserId: trellus.value,
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
  const body = await request.json();
  const { id, ...updateData } = body;

  if ("trellusUserId" in updateData) {
    const trellus = readTrellusUserId(updateData.trellusUserId);
    if (!trellus.ok) return NextResponse.json({ error: trellus.error }, { status: 400 });
    updateData.trellusUserId = trellus.value;
  }

  try {
    const member = await prisma.teamMember.update({
      where: { id },
      data: updateData,
    });
    return NextResponse.json({ member });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "That Trellus ID is already linked to someone else" }, { status: 409 });
    }
    throw error;
  }
}
