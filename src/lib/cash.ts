// === Sales-dashboard money definition (Colin, 2026-08-12) ===
// The ONLY cash shown anywhere in sales views is UPFRONT CASH: what a
// first-time client paid at the close — every charge within 24h of the
// deal's first payment, net of refunds, on a deal whose first payment
// wasn't from an already-paying client. Renewals, reorders, and later
// charges are Company revenue — they live in Stripe, not here. This is
// the same rule closer commission uses (src/lib/payroll.ts).

export const UPFRONT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CashPayment = {
  amountCents: number;
  refundedCents: number;
  status: string;
  paidAt: Date | string;
  customerStatus: string;
  customerStatusOverride: string | null;
};

export function netCents(p: { amountCents: number; refundedCents: number; status: string }): number {
  return p.status === "failed" ? 0 : p.amountCents - p.refundedCents;
}

// Upfront cash for one deal's payments. Returns 0 for reorder deals
// (first payment from an already-paying client) — that's not sales cash.
export function dealUpfrontCents(payments: CashPayment[]): number {
  const real = payments.filter((p) => p.status !== "failed");
  if (real.length === 0) return 0;
  const first = real.reduce((a, b) => (new Date(a.paidAt) <= new Date(b.paidAt) ? a : b));
  if ((first.customerStatusOverride || first.customerStatus) === "returning") return 0;
  const firstMs = new Date(first.paidAt).getTime();
  return real
    .filter((p) => new Date(p.paidAt).getTime() - firstMs <= UPFRONT_WINDOW_MS)
    .reduce((s, p) => s + netCents(p), 0);
}
