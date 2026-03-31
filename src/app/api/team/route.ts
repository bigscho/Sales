import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const members = await prisma.teamMember.findMany({
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ members });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, role, tier, slackUserId } = body;

  const member = await prisma.teamMember.create({
    data: { name, role, tier: tier || 1, slackUserId: slackUserId || null },
  });

  return NextResponse.json({ member });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, ...updateData } = body;

  const member = await prisma.teamMember.update({
    where: { id },
    data: updateData,
  });

  return NextResponse.json({ member });
}
