import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { categorizTransaction } from "@/lib/categorization";

// Mercury API sync endpoint
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { apiKey } = body;

  if (!apiKey && !process.env.MERCURY_API_KEY) {
    return NextResponse.json(
      { error: "Mercury API key required. Pass apiKey in body or set MERCURY_API_KEY env var." },
      { status: 400 }
    );
  }

  const key = apiKey || process.env.MERCURY_API_KEY;

  try {
    // Fetch accounts first
    const accountsRes = await fetch("https://api.mercury.com/api/v1/accounts", {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });

    if (!accountsRes.ok) {
      const err = await accountsRes.text();
      return NextResponse.json({ error: `Mercury API error: ${err}` }, { status: accountsRes.status });
    }

    const { accounts } = await accountsRes.json();
    let totalSynced = 0;
    let totalSkipped = 0;

    for (const account of accounts) {
      // Fetch transactions for last 90 days
      const since = new Date();
      since.setDate(since.getDate() - 90);
      const txRes = await fetch(
        `https://api.mercury.com/api/v1/account/${account.id}/transactions?start=${since.toISOString().split("T")[0]}&limit=500`,
        { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } }
      );

      if (!txRes.ok) continue;

      const { transactions } = await txRes.json();

      for (const tx of transactions) {
        const externalId = tx.id || tx.transactionId;

        // Skip if already imported
        const existing = await prisma.transaction.findUnique({
          where: { source_externalId: { source: "mercury", externalId: String(externalId) } },
        });

        if (existing) {
          totalSkipped++;
          continue;
        }

        const amountCents = Math.round((tx.amount || 0) * 100);
        const merchantName = tx.counterpartyName || tx.bankDescription || null;
        const description = tx.note || tx.bankDescription || tx.externalMemo || null;

        // Auto-categorize
        const result = await categorizTransaction(merchantName, description);

        await prisma.transaction.create({
          data: {
            externalId: String(externalId),
            source: "mercury",
            date: new Date(tx.postedAt || tx.createdAt),
            amountCents,
            merchantName,
            description,
            classification: result.classification,
            categoryId: result.categoryId,
            status: result.confidence >= 0.7 ? "auto_categorized" : "needs_review",
            confidenceScore: result.confidence,
          },
        });
        totalSynced++;
      }
    }

    // Log the sync
    await prisma.syncLog.create({
      data: {
        source: "mercury",
        syncType: "transactions",
        status: "success",
        recordsSynced: totalSynced,
      },
    });

    return NextResponse.json({
      success: true,
      synced: totalSynced,
      skipped: totalSkipped,
      accounts: accounts.length,
    });
  } catch (err) {
    await prisma.syncLog.create({
      data: {
        source: "mercury",
        syncType: "transactions",
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Mercury sync failed" },
      { status: 500 }
    );
  }
}
