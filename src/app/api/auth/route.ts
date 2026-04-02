import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createSession, getSession, SESSION_COOKIE } from "@/lib/auth";

// GET /api/auth — return current session (or null)
export async function GET() {
  const session = await getSession();
  return NextResponse.json({ session });
}

// POST /api/auth — login with name + pin
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  if (action === "login") {
    const { memberId, pin } = body;
    if (!memberId || !pin) {
      return NextResponse.json({ error: "Member and PIN required" }, { status: 400 });
    }

    const member = await prisma.teamMember.findUnique({ where: { id: memberId } });
    if (!member || !member.pin) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    if (member.pin !== pin) {
      return NextResponse.json({ error: "Wrong PIN" }, { status: 401 });
    }

    if (!member.isActive) {
      return NextResponse.json({ error: "Account deactivated" }, { status: 403 });
    }

    const token = await createSession({
      memberId: member.id,
      name: member.name,
      role: member.role,
      isAdmin: member.isAdmin,
    });

    const response = NextResponse.json({
      success: true,
      session: { memberId: member.id, name: member.name, role: member.role, isAdmin: member.isAdmin },
    });

    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
    });

    return response;
  }

  if (action === "logout") {
    const response = NextResponse.json({ success: true });
    response.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
    return response;
  }

  // GET available members for login dropdown (names + IDs only, no PINs)
  if (action === "members") {
    const members = await prisma.teamMember.findMany({
      where: { isActive: true, pin: { not: null } },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    });
    return NextResponse.json({ members });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
