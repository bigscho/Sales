// Minimal Resend client (HTTP API via fetch — matches the repo's fetch-based
// integrations). Used by the reconnect sequence; the pre-demo nurture emails
// live in grassfedlite (Railway), NOT here. Requires RESEND_API_KEY on Vercel
// and the from-address domain (grsfd.co) verified in the Resend account.

const RESEND_URL = "https://api.resend.com/emails";

export interface SendEmailArgs {
  from: string; // "Colin <colin@grsfd.co>"
  to: string;
  subject: string;
  text: string;
}

/** Send a plain-text email via Resend. Throws on non-2xx (caller logs `failed`). */
export async function sendEmail({ from, to, subject, text }: SendEmailArgs): Promise<{ id: string | null }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => null)) as { id?: string } | null;
  return { id: data?.id || null };
}
