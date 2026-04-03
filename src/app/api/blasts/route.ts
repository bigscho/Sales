import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { spendCredits } from "@/lib/credits";
import { processBlast } from "@/lib/ghl";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.SESSION_SECRET || "grassfed-sales-default-secret-change-me");

async function getSession(request: NextRequest) {
  const token = request.cookies.get("grassfed_session")?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload as { memberId: string; role: string; isAdmin: boolean };
  } catch {
    return null;
  }
}

// GET /api/blasts?setterId=X&page=1
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const setterId = searchParams.get("setterId") || (session.isAdmin ? undefined : session.memberId);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = 20;

  // Setters can only see their own blasts
  if (!session.isAdmin && setterId !== session.memberId) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const where = setterId ? { setterId } : {};

  const [blasts, total] = await Promise.all([
    prisma.textBlast.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        setter: { select: { id: true, name: true } },
      },
    }),
    prisma.textBlast.count({ where }),
  ]);

  return NextResponse.json({
    blasts,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
}

// POST /api/blasts — create a new text blast
export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json();
  const { quantity, filterState, filterCity, filterMinProd, filterMaxProd, scheduledFor } = body;

  if (!quantity || quantity <= 0) {
    return NextResponse.json({ error: "quantity must be a positive number" }, { status: 400 });
  }

  const setterId = session.memberId;

  // Verify setter has blast zones if not admin
  if (!session.isAdmin) {
    const member = await prisma.teamMember.findUnique({ where: { id: setterId } });
    if (!member?.blastZones) {
      return NextResponse.json({ error: "No target zones assigned — contact admin" }, { status: 403 });
    }

    // Validate the requested filters match an assigned zone
    const zones = JSON.parse(member.blastZones) as Array<{
      state?: string;
      cities?: string[];
      minProd?: number;
      maxProd?: number;
    }>;

    const matchesZone = zones.some(zone => {
      if (zone.state && filterState && zone.state.toLowerCase() !== filterState.toLowerCase()) return false;
      if (zone.cities?.length && filterCity && !zone.cities.some(c => c.toLowerCase() === filterCity.toLowerCase())) return false;
      return true;
    });

    if (!matchesZone) {
      return NextResponse.json({ error: "Requested filters don't match your assigned zones" }, { status: 403 });
    }
  }

  // Check available agents count before spending credits
  const agentFilter: Record<string, unknown> = { phone: { not: null } };
  if (filterState) agentFilter.state = { equals: filterState, mode: "insensitive" };
  if (filterCity) agentFilter.city = { contains: filterCity, mode: "insensitive" };
  if (filterMinProd) agentFilter.avgTransactions = { ...((agentFilter.avgTransactions as Record<string, unknown>) || {}), gte: filterMinProd };
  if (filterMaxProd) agentFilter.avgTransactions = { ...((agentFilter.avgTransactions as Record<string, unknown>) || {}), lte: filterMaxProd };

  const availableAgents = await prisma.agent.count({ where: agentFilter });
  if (availableAgents === 0) {
    return NextResponse.json({ error: "No agents match these filters" }, { status: 400 });
  }

  // Create the blast record
  const blast = await prisma.textBlast.create({
    data: {
      setterId,
      creditsSpent: quantity,
      status: scheduledFor ? "scheduled" : "pending",
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      filterState: filterState || null,
      filterCity: filterCity || null,
      filterMinProd: filterMinProd || null,
      filterMaxProd: filterMaxProd || null,
    },
  });

  // Deduct credits (throws if insufficient)
  try {
    await spendCredits(setterId, quantity, blast.id);
  } catch (err) {
    // Clean up the blast record
    await prisma.textBlast.delete({ where: { id: blast.id } });
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  // If immediate, kick off processing (don't await — let it run async)
  if (!scheduledFor) {
    processBlast(blast.id).catch(err => {
      console.error(`Blast ${blast.id} processing error:`, err);
    });
  }

  const member = await prisma.teamMember.findUnique({
    where: { id: setterId },
    select: { creditBalance: true },
  });

  return NextResponse.json({
    blast,
    creditsRemaining: member?.creditBalance || 0,
  });
}
