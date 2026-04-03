import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getBalance, getCreditHistory } from "@/lib/credits";
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

// GET /api/credits?setterId=X&page=1&limit=20
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  let setterId = searchParams.get("setterId") || session.memberId;

  // Setters can only query their own credits
  if (!session.isAdmin && setterId !== session.memberId) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const page = parseInt(searchParams.get("page") || "1");
  const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

  const [balance, history] = await Promise.all([
    getBalance(setterId),
    getCreditHistory(setterId, page, limit),
  ]);

  return NextResponse.json({
    balance,
    transactions: history.transactions,
    totalTransactions: history.total,
    page,
    totalPages: Math.ceil(history.total / limit),
  });
}

// POST /api/credits — admin manual adjustment
export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = await request.json();
  const { setterId, amount, description } = body;

  if (!setterId || !amount || !description) {
    return NextResponse.json({ error: "setterId, amount, and description are required" }, { status: 400 });
  }

  const result = await prisma.$transaction(async (tx) => {
    const member = await tx.teamMember.update({
      where: { id: setterId },
      data: { creditBalance: { increment: amount } },
    });

    await tx.creditTransaction.create({
      data: {
        setterId,
        amount,
        balance: member.creditBalance,
        type: "admin_adjust",
        description,
      },
    });

    return member.creditBalance;
  });

  return NextResponse.json({ balance: result });
}
