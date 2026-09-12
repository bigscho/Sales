import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

// GET handler for Vercel cron
export async function GET() {
  return POST();
}

export async function POST() {
  const results: Record<string, { status: string; records?: number; error?: string }> = {};

  // Ensure current week + last 3 weeks + 2 future weeks exist
  for (let i = -2; i < 4; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i * 7);
    const { start, end } = getWeekRange(d);
    await prisma.week.upsert({
      where: { weekStart: start },
      create: { weekStart: start, weekEnd: end },
      update: {},
    });
  }

  // Sync Stripe
  try {
    const stripeResult = await syncStripe();
    results.stripe = { status: "success", records: stripeResult };
  } catch (error) {
    results.stripe = { status: "error", error: String(error) };
  }

  // Log sync
  for (const [source, result] of Object.entries(results)) {
    await prisma.syncLog.create({
      data: {
        source,
        syncType: "full",
        status: result.status,
        recordsSynced: result.records || 0,
        errorMessage: result.error,
        completedAt: new Date(),
      },
    });
  }

  return NextResponse.json({ results });
}

async function syncStripe(): Promise<number> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return 0;

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(key);

  const now = new Date();
  const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

  let count = 0;
  const paymentIntents = await stripe.paymentIntents.list({
    created: { gte: Math.floor(fourWeeksAgo.getTime() / 1000) },
    limit: 100,
  });

  for (const pi of paymentIntents.data) {
    if (pi.status !== "succeeded") continue;

    const existing = await prisma.payment.findUnique({
      where: { stripePaymentIntentId: pi.id },
    });
    if (existing) continue;

    let customerName: string | undefined;
    let customerEmail: string | undefined;
    if (pi.customer) {
      try {
        const customer = await stripe.customers.retrieve(pi.customer as string);
        if (!("deleted" in customer && customer.deleted)) {
          customerName = customer.name || undefined;
          customerEmail = customer.email || undefined;
        }
      } catch {
        // Customer lookup failed
      }
    }

    await prisma.payment.create({
      data: {
        stripePaymentIntentId: pi.id,
        amountCents: pi.amount,
        currency: pi.currency,
        status: pi.status,
        paidAt: new Date(pi.created * 1000),
        customerName,
        customerEmail,
      },
    });
    count++;
  }

  return count;
}

// Legacy direct-GCal ingest (syncGoogleCalendar + parseCalendlyEvent) removed
// 2026-09-12: it was gated on an env key that was never set, and had none of
// /api/sync/gcal's dedup/supersede/shadow guards — if the key ever appeared it
// would have duplicated every webhook booking. /api/sync/gcal (10-min cron) is
// the ONLY calendar ingest.
