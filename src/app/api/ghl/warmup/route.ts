import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAvailableCapacity } from "@/lib/ghl";
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

// GET /api/ghl/warmup — view current warm-up status
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const capacity = await getAvailableCapacity();

  // Get recent history (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const history = await prisma.ghlWarmupTracker.findMany({
    where: { date: { gte: sevenDaysAgo } },
    orderBy: [{ subAccountId: "asc" }, { date: "desc" }],
  });

  return NextResponse.json({ capacity, history });
}

// POST /api/ghl/warmup — manually set daily limit for a sub-account
export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = await request.json();
  const { subAccountId, dailyLimit } = body;

  if (!subAccountId || !["1", "2"].includes(subAccountId)) {
    return NextResponse.json({ error: "subAccountId must be '1' or '2'" }, { status: 400 });
  }
  if (!dailyLimit || dailyLimit < 0) {
    return NextResponse.json({ error: "dailyLimit must be a positive number" }, { status: 400 });
  }

  const today = new Date();
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const tracker = await prisma.ghlWarmupTracker.upsert({
    where: { subAccountId_date: { subAccountId, date } },
    create: { subAccountId, date, dailyLimit, sentCount: 0 },
    update: { dailyLimit },
  });

  return NextResponse.json({ tracker });
}
