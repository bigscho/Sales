import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const weekId = request.nextUrl.searchParams.get("weekId");
  if (!weekId) {
    return NextResponse.json({ error: "weekId required" }, { status: 400 });
  }

  // Non-admin closers see only their own deals — and not the company-wide
  // unlinked Stripe feed.
  const session = await getSession();
  const isScopedCloser = session && session.role === "closer" && !session.isAdmin;

  const deals = await prisma.deal.findMany({
    where: { weekId, ...(isScopedCloser ? { closerId: session.memberId } : {}) },
    include: {
      demo: { include: { booking: { include: { setter: true } } } },
      closer: true,
      payments: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // Also return unlinked payments (not associated with any deal)
  const unlinkedPayments = isScopedCloser
    ? []
    : await prisma.payment.findMany({
        where: { dealId: null },
        orderBy: { paidAt: "desc" },
      });

  return NextResponse.json({ deals, unlinkedPayments });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    weekId, demoId, closerId, prospectName, prospectEmail,
    stripeCustomerId, stripeSubscriptionId, dealType, status, month1Cash, notes, leadSource,
  } = body;

  // Fed vs self-sourced: explicit value wins, else inherit from the linked
  // demo's booking (where it was fixed at booking time), else fed.
  let resolvedLeadSource = leadSource;
  if (!resolvedLeadSource && demoId) {
    const demo = await prisma.demo.findUnique({ where: { id: demoId }, include: { booking: true } });
    resolvedLeadSource = demo?.booking.leadSource;
  }

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
      leadSource: resolvedLeadSource || "fed",
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

  const before = await prisma.deal.findUnique({ where: { id: dealId } });

  const deal = await prisma.deal.update({
    where: { id: dealId },
    data: updateData,
    include: {
      closer: true,
      payments: true,
    },
  });

  // Audit comp-relevant edits with WHO made them — leadSource and status drive
  // commission (§4.11c: company records are the authoritative comp source).
  if (before && (updateData.leadSource !== undefined || updateData.status !== undefined || updateData.closerId !== undefined)) {
    const session = await getSession();
    await prisma.auditLog.create({
      data: {
        entityType: "deal",
        entityId: dealId,
        action: "deal_update",
        oldValue: JSON.stringify({ leadSource: before.leadSource, status: before.status, closerId: before.closerId }),
        newValue: JSON.stringify({ leadSource: deal.leadSource, status: deal.status, closerId: deal.closerId }),
        performedBy: session?.name || "admin",
      },
    });
  }

  return NextResponse.json({ deal });
}
