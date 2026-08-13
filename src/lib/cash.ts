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
  upfrontOverride?: string | null; // include | exclude | null — human final word (reconcile drawer)
};

export function netCents(p: { amountCents: number; refundedCents: number; status: string }): number {
  return p.status === "failed" ? 0 : p.amountCents - p.refundedCents;
}

// Upfront cash for one deal's payments. Returns 0 for reorder deals
// (first payment from an already-paying client) — that's not sales cash.
// A per-payment upfrontOverride beats every automatic rule except "failed":
// operators reconcile edge cases (e.g. a real month-1 installment outside the
// 24h window) and the override must win everywhere the same way.
export function dealUpfrontCents(payments: CashPayment[]): number {
  const real = payments.filter((p) => p.status !== "failed");
  if (real.length === 0) return 0;
  const first = real.reduce((a, b) => (new Date(a.paidAt) <= new Date(b.paidAt) ? a : b));
  const dealIsNew = (first.customerStatusOverride || first.customerStatus) !== "returning";
  const firstMs = new Date(first.paidAt).getTime();
  return real
    .filter((p) => {
      if (p.upfrontOverride === "exclude") return false;
      if (p.upfrontOverride === "include") return true;
      if (!dealIsNew) return false;
      return new Date(p.paidAt).getTime() - firstMs <= UPFRONT_WINDOW_MS;
    })
    .reduce((s, p) => s + netCents(p), 0);
}
