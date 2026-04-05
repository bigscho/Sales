import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Reconciliation: compare what Stripe says happened vs what our DB has
// This catches dropped webhooks, missed payments, or classification errors
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const month = parseInt(searchParams.get("month") || String(new Date().getMonth() + 1));
  const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()));

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "STRIPE_SECRET_KEY not set" }, { status: 400 });
  }

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  // === Pull from Stripe: all balance transactions for the month ===
  const stripeTransactions: Array<{
    id: string;
    type: string;
    amount: number;
    net: number;
    description: string | null;
    created: number;
    source: string | null;
  }> = [];

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const params: Record<string, unknown> = {
      limit: 100,
      created: {
        gte: Math.floor(startDate.getTime() / 1000),
        lte: Math.floor(endDate.getTime() / 1000),
      },
    };
    if (startingAfter) params.starting_after = startingAfter;

    const batch = await stripe.balanceTransactions.list(params as Parameters<typeof stripe.balanceTransactions.list>[0]);

    for (const bt of batch.data) {
      stripeTransactions.push({
        id: bt.id,
        type: bt.type,
        amount: bt.amount,
        net: bt.net,
        description: bt.description,
        created: bt.created,
        source: typeof bt.source === "string" ? bt.source : bt.source?.id || null,
      });
    }

    hasMore = batch.has_more;
    if (batch.data.length > 0) {
      startingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  // Stripe totals
  const stripeCharges = stripeTransactions.filter((t) => t.type === "charge");
  const stripeRefunds = stripeTransactions.filter((t) => t.type === "refund");
  const stripePayouts = stripeTransactions.filter((t) => t.type === "payout");

  const stripeGrossRevenue = stripeCharges.reduce((sum, t) => sum + t.amount, 0);
  const stripeRefundTotal = stripeRefunds.reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const stripeFeeTotal = stripeTransactions.reduce((sum, t) => sum + (t.amount - t.net), 0);
  const stripeNetRevenue = stripeGrossRevenue - stripeRefundTotal;

  // === Pull from our DB: all payments for the month ===
  const dbPayments = await prisma.payment.findMany({
    where: {
      paidAt: { gte: startDate, lte: endDate },
    },
  });

  const dbGrossRevenue = dbPayments
    .filter((p) => p.status === "succeeded" || p.status === "partially_refunded")
    .reduce((sum, p) => sum + p.amountCents, 0);

  const dbRefundTotal = dbPayments.reduce((sum, p) => sum + p.refundedCents, 0);
  const dbNetRevenue = dbGrossRevenue - dbRefundTotal;
  const dbPaymentCount = dbPayments.filter((p) => p.status === "succeeded" || p.status === "partially_refunded").length;

  // === Find discrepancies ===
  // Check for Stripe charges we don't have in our DB
  const dbPiIds = new Set(dbPayments.map((p) => p.stripePaymentIntentId).filter(Boolean));

  // Get payment intents for the period to cross-check
  const missingFromDb: Array<{
    piId: string;
    amount: number;
    created: string;
    description: string | null;
  }> = [];

  let piHasMore = true;
  let piStartingAfter: string | undefined;

  while (piHasMore) {
    const params: Record<string, unknown> = {
      limit: 100,
      created: {
        gte: Math.floor(startDate.getTime() / 1000),
        lte: Math.floor(endDate.getTime() / 1000),
      },
    };
    if (piStartingAfter) params.starting_after = piStartingAfter;

    const batch = await stripe.paymentIntents.list(params as Parameters<typeof stripe.paymentIntents.list>[0]);

    for (const pi of batch.data) {
      if (pi.status === "succeeded" && !dbPiIds.has(pi.id)) {
        missingFromDb.push({
          piId: pi.id,
          amount: pi.amount,
          created: new Date(pi.created * 1000).toISOString(),
          description: pi.description,
        });
      }
    }

    piHasMore = batch.has_more;
    if (batch.data.length > 0) {
      piStartingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  // Revenue difference
  const grossDifference = stripeGrossRevenue - dbGrossRevenue;
  const refundDifference = stripeRefundTotal - dbRefundTotal;
  const netDifference = stripeNetRevenue - dbNetRevenue;

  const isReconciled = Math.abs(grossDifference) < 100 && missingFromDb.length === 0; // within $1 tolerance

  return NextResponse.json({
    period: { month, year, startDate, endDate },
    stripe: {
      grossRevenue: stripeGrossRevenue,
      refunds: stripeRefundTotal,
      fees: stripeFeeTotal,
      netRevenue: stripeNetRevenue,
      chargeCount: stripeCharges.length,
      refundCount: stripeRefunds.length,
      payoutCount: stripePayouts.length,
    },
    database: {
      grossRevenue: dbGrossRevenue,
      refunds: dbRefundTotal,
      netRevenue: dbNetRevenue,
      paymentCount: dbPaymentCount,
    },
    differences: {
      gross: grossDifference,
      refunds: refundDifference,
      net: netDifference,
    },
    missingFromDb,
    isReconciled,
    summary: isReconciled
      ? `✅ Reconciled: Stripe and DB match for ${month}/${year}`
      : `⚠️ Discrepancy: ${missingFromDb.length} missing payments, $${(Math.abs(grossDifference) / 100).toFixed(2)} gross difference`,
  });
}
