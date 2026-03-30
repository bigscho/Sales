import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  const deals = await prisma.deal.findMany({
    where: { weekId },
    include: {
      demo: { include: { booking: { include: { setter: true } } } },
      closer: true,
      payments: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ deals });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    weekId, demoId, closerId, prospectName, prospectEmail,
    stripeCustomerId, stripeSubscriptionId, dealType, status, month1Cash, notes,
  } = body;

  const deal = await prisma.deal.create({
    data: {
      weekId,
      demoId,
      closerId,
      prospectName,
      prospectEmail,
      stripeCustomerId,
      stripeSubscriptionId,
      dealType: dealType || "subscription",
      status: status || "pending",
      month1Cash: month1Cash || 0,
      notes,
      closedAt: status === "closed_won" ? new Date() : null,
    },
    include: {
      closer: true,
      payments: true,
    },
  });

  return NextResponse.json({ deal });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { dealId, ...updateData } = body;

  if (updateData.status === "closed_won" && !updateData.closedAt) {
    updateData.closedAt = new Date();
  }

  const deal = await prisma.deal.update({
    where: { id: dealId },
    data: updateData,
    include: {
      closer: true,
      payments: true,
    },
  });

  return NextResponse.json({ deal });
}
