import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Stripe sends: payment_intent.succeeded, payment_intent.payment_failed, etc.
// We care about payment_intent.succeeded — a completed payment

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Verify this is from Stripe (optional signature verification with STRIPE_WEBHOOK_SECRET)
    const sig = request.headers.get("stripe-signature");
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // If webhook secret is set, verify the signature
    if (webhookSecret && sig) {
      // For proper verification we'd use the Stripe SDK, but for now
      // we'll accept the payload and rely on the endpoint being secret
      // TODO: Add stripe.webhooks.constructEvent verification
    }

    const eventType = body.type;
    const data = body.data?.object;

    if (!data) {
      return NextResponse.json({ error: "No data object" }, { status: 400 });
    }

    // === payment_intent.succeeded ===
    if (eventType === "payment_intent.succeeded") {
      const piId = data.id; // pi_xxxxx
      const amount = data.amount; // in cents
      const currency = data.currency || "usd";
      const customerId = data.customer; // cus_xxxxx or null
      const created = data.created; // unix timestamp
      const description = data.description;

      // Check if already recorded
      const existing = await prisma.payment.findUnique({
        where: { stripePaymentIntentId: piId },
      });
      if (existing) {
        return NextResponse.json({ received: true, action: "duplicate_skipped" });
      }

      // Try to get customer name/email
      let customerName: string | null = description || null;
      let customerEmail: string | null = data.receipt_email || null;

      // If we have a Stripe key and customer ID, fetch customer details
      if (customerId && process.env.STRIPE_SECRET_KEY) {
        try {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const customer = await stripe.customers.retrieve(customerId);
          if (!("deleted" in customer && customer.deleted)) {
            customerName = customer.name || customerName;
            customerEmail = customer.email || customerEmail;
          }
        } catch {
          // Customer lookup failed, continue with what we have
        }
      }

      // Create payment record
      const payment = await prisma.payment.create({
        data: {
          stripePaymentIntentId: piId,
          stripeCustomerId: customerId,
          amountCents: amount,
          currency,
          status: "succeeded",
          paidAt: new Date(created * 1000),
          isMonth1: true,
          customerName,
          customerEmail,
        },
      });

      // Audit log
      await prisma.auditLog.create({
        data: {
          entityType: "payment",
          entityId: payment.id,
          action: "stripe_webhook_created",
          newValue: JSON.stringify({ piId, amount, customer: customerName }),
          performedBy: "stripe_webhook",
        },
      });

      return NextResponse.json({
        received: true,
        action: "created",
        payment: { id: payment.id, amount, customer: customerName },
      });
    }

    // === payment_intent.payment_failed ===
    if (eventType === "payment_intent.payment_failed") {
      const piId = data.id;
      const existing = await prisma.payment.findUnique({
        where: { stripePaymentIntentId: piId },
      });
      if (existing) {
        await prisma.payment.update({
          where: { id: existing.id },
          data: { status: "failed" },
        });
      }
      return NextResponse.json({ received: true, action: "marked_failed" });
    }

    // Other event types — acknowledge but don't process
    return NextResponse.json({ received: true, action: "unhandled_event", type: eventType });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET handler for health check
export async function GET() {
  return NextResponse.json({ status: "ok", webhook: "stripe" });
}
