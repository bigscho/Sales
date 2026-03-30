import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

export async function POST(request: NextRequest) {
  const results: Record<string, { status: string; records?: number; error?: string }> = {};

  // Ensure current week exists
  const { start, end } = getWeekRange(new Date());
  await prisma.week.upsert({
    where: { weekStart: start },
    create: { weekStart: start, weekEnd: end },
    update: {},
  });

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

  // Redirect back to dashboard
  const referer = request.headers.get("referer") || "/";
  return NextResponse.redirect(new URL(referer, request.url));
}

async function syncStripe(): Promise<number> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return 0;

  // Dynamic import to avoid build errors when key not set
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

    // Get customer info
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
        // Customer lookup failed, continue without
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
