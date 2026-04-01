import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const page = parseInt(params.get("page") || "1");
  const limit = Math.min(parseInt(params.get("limit") || "50"), 100);
  const search = params.get("search");
  const state = params.get("state");
  const city = params.get("city");
  const minProd = params.get("minProd") ? parseInt(params.get("minProd")!) : null;
  const maxProd = params.get("maxProd") ? parseInt(params.get("maxProd")!) : null;
  const contacted = params.get("contacted"); // "true" | "false" | null (any)
  const sortBy = params.get("sortBy") || "lastName";
  const sortDir = (params.get("sortDir") || "asc") as "asc" | "desc";

  // Build where clause
  const where: Record<string, unknown> = {};

  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { brokerage: { contains: search, mode: "insensitive" } },
    ];
  }

  if (state) where.state = { equals: state, mode: "insensitive" };
  if (city) where.city = { contains: city, mode: "insensitive" };

  if (minProd !== null || maxProd !== null) {
    where.avgTransactions = {};
    if (minProd !== null) (where.avgTransactions as Record<string, unknown>).gte = minProd;
    if (maxProd !== null) (where.avgTransactions as Record<string, unknown>).lte = maxProd;
  }

  if (contacted === "true") {
    where.outboundPushes = { some: {} };
  } else if (contacted === "false") {
    where.outboundPushes = { none: {} };
  }

  const [agents, total] = await Promise.all([
    prisma.agent.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        outboundPushes: {
          select: { channel: true, campaignId: true, pushedAt: true },
          orderBy: { pushedAt: "desc" },
          take: 5,
        },
      },
    }),
    prisma.agent.count({ where }),
  ]);

  // BigInt can't be serialized by JSON.stringify — convert to string
  const serialized = agents.map((a) => ({
    ...a,
    totalVolumeCents: a.totalVolumeCents?.toString() || null,
    avgVolumeCents: a.avgVolumeCents?.toString() || null,
  }));

  return NextResponse.json({
    agents: serialized,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { firstName, lastName, email, phone, state, city, zip, brokerage, totalTransactions, totalVolumeCents } = body;

  const agent = await prisma.agent.create({
    data: {
      firstName,
      lastName,
      email,
      phone,
      state,
      city,
      zip,
      brokerage,
      totalTransactions,
      totalVolumeCents: totalVolumeCents ? BigInt(totalVolumeCents) : null,
      avgTransactions: totalTransactions ? Math.round(totalTransactions / 5) : null,
      avgVolumeCents: totalVolumeCents ? BigInt(Math.round(Number(totalVolumeCents) / 5)) : null,
      source: "manual",
    },
  });

  return NextResponse.json({ agent });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { agentId, ...updates } = body;

  if (!agentId) {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }

  const agent = await prisma.agent.update({
    where: { id: agentId },
    data: updates,
  });

  return NextResponse.json({ agent });
}
