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

    // Dump all top-level keys that contain "period" or "cancel" or "pause"
    const debugFields: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
      if (key.includes("period") || key.includes("cancel") || key.includes("pause") || key.includes("billing") || key.includes("current")) {
        debugFields[key] = raw[key];
      }
    }

    return {
      name,
      status: sub.status,
      allKeys: Object.keys(raw).sort(),
      debugFields,
      pause_collection: raw.pause_collection || null,
      items: sub.items.data.map(item => ({
        unit_amount: item.price.unit_amount,
        interval: item.price.recurring?.interval,
        interval_count: item.price.recurring?.interval_count,
      })),
    };
  });

  return NextResponse.json({ count: results.length, subscriptions: results });
}
