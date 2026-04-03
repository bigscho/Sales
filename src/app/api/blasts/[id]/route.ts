import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
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

// GET /api/blasts/[id] — blast detail with push results
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;

  const blast = await prisma.textBlast.findUnique({
    where: { id },
    include: {
      setter: { select: { id: true, name: true } },
      pushes: {
        include: {
          agent: { select: { id: true, firstName: true, lastName: true, phone: true, state: true, city: true } },
        },
        orderBy: { pushedAt: "desc" },
        take: 100,
      },
      creditTx: {
        select: { id: true, amount: true, type: true, description: true, createdAt: true },
      },
    },
  });

  if (!blast) return NextResponse.json({ error: "Blast not found" }, { status: 404 });

  // Setters can only see their own blasts
  if (!session.isAdmin && blast.setterId !== session.memberId) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  return NextResponse.json({ blast });
}
