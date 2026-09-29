// Reconnect-sequence copy. Text bodies + the "Great to chat." lead are Colin's
// wording (2026-09-29); the email subjects are drafts flagged for his edit.
// Keep the locked lines exact.

// "One more thing" = Colin's locked subject (2026-09-29).
export const RECAP_EMAIL_SUBJECT = "One more thing";
export const T1_EMAIL_SUBJECT = "Ahead of our call tomorrow";

const TESTIMONIAL_LINE =
  "Also, ahead of us reconnecting, feel free to check out some testimonial videos so you can see actual agents talking about using cold email with us: www.grsfd.ai/#testimonials";

/** T-1 text into the SendBlue group. Colin's exact words. */
export function renderReconnectT1Text(): string {
  return "I know we're reconnecting tomorrow. I might be 1-2min late, but I'll give you a ring.";
}

/**
 * Touch #1 — deliberately GENERIC (Colin, 2026-09-29: no AI-written recap of
 * the first call — "it's just going to make it weird"). A short "great to
 * chat" plus the testimonials line, nothing else.
 */
export function renderRecapEmail({
  firstName,
  closerFirstName,
}: {
  firstName: string;
  closerFirstName: string;
}): string {
  return `Hey ${firstName},\n\nGreat to chat. ${TESTIMONIAL_LINE}\n\n${closerFirstName}`;
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
