import { prisma } from "@/lib/db";
import { summarizeBotSends, type BotCallerSummary } from "./send";

export async function botSendSummary(now = new Date()): Promise<{ hours: 24; callers: BotCallerSummary[] }> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await prisma.botSend.findMany({
    where: { createdAt: { gte: since } },
    select: { caller: true, status: true, dryRun: true },
  });
  return { hours: 24, callers: summarizeBotSends(rows) };
}
