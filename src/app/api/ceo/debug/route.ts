import { NextResponse } from "next/server";

// Quick debug endpoint to see raw Stripe subscription data
export async function GET() {
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "STRIPE_SECRET_KEY not set" }, { status: 400 });
  }

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const subs = await stripe.subscriptions.list({
    status: "active",
    limit: 100,
    expand: ["data.customer"],
  });

  const results = subs.data.map((sub) => {
    const raw = sub as unknown as Record<string, unknown>;
    const customer = typeof sub.customer === "string" ? null : sub.customer;
    const name = customer && !("deleted" in customer && customer.deleted)
      ? (customer.name || customer.email || "Unknown")
      : "Unknown";

    return {
      name,
      status: sub.status,
      pause_collection: raw.pause_collection || null,
      current_period_end: raw.current_period_end,
      current_period_start: raw.current_period_start,
      cancel_at: raw.cancel_at,
      cancel_at_period_end: raw.cancel_at_period_end,
      billing_cycle_anchor: raw.billing_cycle_anchor,
      items: sub.items.data.map(item => ({
        unit_amount: item.price.unit_amount,
        interval: item.price.recurring?.interval,
        interval_count: item.price.recurring?.interval_count,
      })),
    };
  });

  return NextResponse.json({ count: results.length, subscriptions: results });
}
