export async function sendSlackMessage(text: string, blocks?: unknown[]) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.warn("SLACK_WEBHOOK_URL not set, skipping notification");
    return;
  }

  const body: Record<string, unknown> = { text };
  if (blocks) body.blocks = blocks;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}
