// Reconnect-sequence copy. The text bodies are Colin's locked wording
// (2026-09-29); the email subjects + no-recap fallback are drafts flagged for
// his edit during the dry-run review. Keep the locked lines exact.
import { formatDemoDay } from "@/lib/confirmations/copy";

export const RECAP_EMAIL_SUBJECT = "Recap + a couple links before we reconnect";
export const T1_EMAIL_SUBJECT = "Ahead of our call tomorrow";

const TESTIMONIAL_LINE =
  "Also, ahead of us reconnecting, feel free to check out some testimonial videos so you can see actual agents talking about using cold email with us: www.grsfd.ai/#testimonials";

/** T-1 text into the SendBlue group. Colin's exact words. */
export function renderReconnectT1Text(): string {
  return "I know we're reconnecting tomorrow. I might be 1-2min late, but I'll give you a ring.";
}

export interface RecapEmailArgs {
  firstName: string;
  closerFirstName: string;
  /** Claude-rewritten first-call recap, or null -> generic no-recap variant. */
  recap: string | null;
  callAt: Date;
  timezone: string | null;
}

/**
 * Touch #1 — the recap email. Recap variant leads with the Claude-rewritten
 * first-call summary; the no-recap variant is the fallback when Fireflies has
 * nothing usable by send time. Both carry the testimonials line verbatim.
 */
export function renderRecapEmail({ firstName, closerFirstName, recap, callAt, timezone }: RecapEmailArgs): string {
  const lead = recap
    ? recap.trim()
    : `Great talking — looking forward to reconnecting ${formatDemoDay(callAt, timezone)}.`;
  return `Hey ${firstName},\n\n${lead}\n\n${TESTIMONIAL_LINE}\n\n${closerFirstName}`;
}

/** Touch #3 — the T-1 email. Body line is Colin's exact words. */
export function renderReconnectT1Email({
  firstName,
  closerFirstName,
}: {
  firstName: string;
  closerFirstName: string;
}): string {
  return `Hey ${firstName}, ahead of our call tomorrow, here are some final numbers if helpful: https://www.grsfd.ai/#results\n\n${closerFirstName}`;
}
