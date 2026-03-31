async function sendToWebhook(url: string, text: string, blocks?: unknown[]) {
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

// Send to #sales-team channel
export async function sendSlackTeam(text: string, blocks?: unknown[]) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await sendToWebhook(url, text, blocks);
}

// Send to CEO channel/DM
export async function sendSlackCEO(text: string, blocks?: unknown[]) {
  const url = process.env.SLACK_CEO_WEBHOOK_URL;
  if (!url) return;
  await sendToWebhook(url, text, blocks);
}

// Legacy alias — sends to team channel
export async function sendSlackMessage(text: string, blocks?: unknown[]) {
  return sendSlackTeam(text, blocks);
}
