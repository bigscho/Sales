import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { autoDetectShows, matchPaymentToDemo } from "@/lib/matching";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { weekId, action } = body;

  // Auto-detect shows using Fireflies transcripts
  if (action === "auto_detect_shows") {
    const { transcripts } = body; // passed from client or fetched server-side

    if (!transcripts || !weekId) {
      return NextResponse.json({ error: "weekId and transcripts required" }, { status: 400 });
    }

    const results = await autoDetectShows(weekId, transcripts);

    // Auto-mark high-confidence matches
    for (const match of results.autoMarked) {
      await prisma.demo.update({
        where: { id: match.demoId },
        data: {
          status: match.status,
          confirmedBy: "fireflies_auto",
          confirmedAt: new Date(),
          notes: match.reason,
        },
      });

      await prisma.auditLog.create({
        data: {
          entityType: "demo",
          entityId: match.demoId,
          action: "auto_detect_show",
          newValue: JSON.stringify({ status: match.status, reason: match.reason }),
          performedBy: "system",
        },
      });
    }

    return NextResponse.json({
      autoMarked: results.autoMarked,
      needsReview: results.needsReview,
      message: `Auto-marked ${results.autoMarked.length} demos as showed, ${results.needsReview.length} need manual review`,
    });
  }

  // Auto-match payments to demos/deals
  if (action === "auto_match_payments") {
    const unlinkedPayments = await prisma.payment.findMany({
      where: { dealId: null },
    });

    const matched: { paymentId: string; customerName: string; dealId: string; reason: string }[] = [];
    const unmatched: { paymentId: string; customerName: string; amount: number; reason: string }[] = [];

    for (const payment of unlinkedPayments) {
      const result = await matchPaymentToDemo({
        customerName: payment.customerName,
        customerEmail: payment.customerEmail,
      });

      if (result.result.type === "auto_matched" && result.demoId) {
        // Find or create a deal for this demo
        let deal = await prisma.deal.findFirst({
          where: { demoId: result.demoId },
        });

        if (!deal) {
          // Get the demo's week and closer info
          const demo = await prisma.demo.findUnique({
            where: { id: result.demoId },
            include: { booking: true },
          });

          if (demo) {
            deal = await prisma.deal.create({
              data: {
                weekId: demo.weekId,
                demoId: result.demoId,
                closerId: demo.closerId,
                prospectName: demo.booking.prospectName,
                prospectEmail: demo.booking.prospectEmail,
                dealType: "subscription",
                status: "closed_won",
                month1Cash: payment.amountCents,
                closedAt: payment.paidAt,
              },
            });

            // Also mark the demo as showed if it's still pending
            if (demo.status === "pending") {
              await prisma.demo.update({
                where: { id: demo.id },
                data: {
                  status: "showed",
                  confirmedBy: "payment_auto",
                  confirmedAt: new Date(),
                  notes: "Auto-confirmed: Stripe payment found",
                },
              });
            }
          }
        }

        if (deal) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: { dealId: deal.id, isMonth1: true },
          });

          matched.push({
            paymentId: payment.id,
            customerName: payment.customerName || "Unknown",
            dealId: deal.id,
            reason: result.result.reason,
          });
        }
      } else {
        unmatched.push({
          paymentId: payment.id,
          customerName: payment.customerName || payment.customerEmail || "Unknown",
          amount: payment.amountCents,
          reason: result.result.reason,
        });
      }
    }

    return NextResponse.json({
      matched,
      unmatched,
      message: `Matched ${matched.length} payments to deals, ${unmatched.length} need manual review`,
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
