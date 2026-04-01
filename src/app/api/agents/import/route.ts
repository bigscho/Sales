import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST: Bulk import agents from parsed CSV data
// Accepts JSON array of agent objects, upserts by email
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { agents, batchName } = body;

  if (!Array.isArray(agents) || agents.length === 0) {
    return NextResponse.json({ error: "agents array required" }, { status: 400 });
  }

  const batchId = batchName || `import_${new Date().toISOString().slice(0, 10)}_${Date.now()}`;

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Process in chunks of 500
  const chunkSize = 500;
  for (let i = 0; i < agents.length; i += chunkSize) {
    const chunk = agents.slice(i, i + chunkSize);

    for (const row of chunk) {
      try {
        const email = row.email?.trim()?.toLowerCase() || null;
        if (!email) {
          skipped++;
          continue;
        }

        const firstName = row.firstName?.trim() || row.first_name?.trim() || "";
        const lastName = row.lastName?.trim() || row.last_name?.trim() || "";

        if (!firstName && !lastName) {
          skipped++;
          continue;
        }

        // Parse production numbers — handle commas, dollar signs, etc.
        const totalTransactions = parseNumber(row.totalTransactions || row.total_transactions || row.transactions);
        const totalVolume = parseNumber(row.totalVolumeCents || row.total_volume || row.volume || row.sales_volume);
        // If volume looks like dollars (not cents), convert to cents
        const totalVolumeCents = totalVolume && totalVolume < 1_000_000_000 ? BigInt(Math.round(totalVolume * 100)) : totalVolume ? BigInt(Math.round(totalVolume)) : null;

        const data = {
          firstName,
          lastName,
          email,
          phone: row.phone?.trim() || null,
          state: row.state?.trim() || null,
          city: row.city?.trim() || null,
          zip: row.zip?.trim() || null,
          brokerage: row.brokerage?.trim() || row.company?.trim() || null,
          totalTransactions,
          totalVolumeCents,
          avgTransactions: totalTransactions ? Math.round(totalTransactions / 5) : null,
          avgVolumeCents: totalVolumeCents ? BigInt(Number(totalVolumeCents) / 5) : null,
          source: "csv_import" as const,
          importBatch: batchId,
        };

        // Upsert by email — update existing, create new
        const existing = await prisma.agent.findUnique({ where: { email } });
        if (existing) {
          await prisma.agent.update({
            where: { email },
            data: {
              ...data,
              // Preserve existing verification status on re-import
              emailVerifyStatus: existing.emailVerifyStatus,
              emailVerifiedAt: existing.emailVerifiedAt,
            },
          });
          updated++;
        } else {
          await prisma.agent.create({ data });
          imported++;
        }
      } catch (e) {
        errors.push(`Row ${i + chunk.indexOf(row)}: ${String(e).slice(0, 100)}`);
      }
    }
  }

  return NextResponse.json({
    success: true,
    batchId,
    imported,
    updated,
    skipped,
    total: agents.length,
    errors: errors.slice(0, 20),
  });
}

// GET: List past imports
export async function GET() {
  const batches = await prisma.agent.groupBy({
    by: ["importBatch"],
    _count: true,
    orderBy: { importBatch: "desc" },
    take: 20,
  });

  return NextResponse.json({ batches });
}

function parseNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const str = String(val).replace(/[$,\s]/g, "");
  const num = parseFloat(str);
  return isNaN(num) ? null : Math.round(num);
}
