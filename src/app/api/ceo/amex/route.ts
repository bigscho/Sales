import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { categorizTransaction } from "@/lib/categorization";

// Amex CSV import endpoint
// Actual Amex export format:
// Date, Receipt, Description, Amount, Extended, Appears On Your Statement As,
// Address, City/State, Zip Code, Country, Reference, Category
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { csvData, dryRun = false } = body;

  if (!csvData) {
    return NextResponse.json({ error: "csvData is required" }, { status: 400 });
  }

  const lines = csvData.split("\n").filter((l: string) => l.trim());
  if (lines.length < 2) {
    return NextResponse.json({ error: "CSV must have a header row and at least one data row" }, { status: 400 });
  }

  // Parse header to find column indices
  const headerFields = parseCSVLine(lines[0]);
  const headerLower = headerFields.map(h => h.toLowerCase().trim());

  const dateIdx = headerLower.findIndex(h => h === "date");
  const descIdx = headerLower.findIndex(h => h === "description");
  const amountIdx = headerLower.findIndex(h => h === "amount");
  const appearsAsIdx = headerLower.findIndex(h => h.includes("appears on"));
  const categoryIdx = headerLower.findIndex(h => h === "category");
  const referenceIdx = headerLower.findIndex(h => h === "reference");
  if (dateIdx === -1 || amountIdx === -1) {
    return NextResponse.json({ error: "CSV must have Date and Amount columns" }, { status: 400 });
  }

  const results: Array<{
    date: string;
    description: string;
    amount: number;
    amexCategory: string | null;
    classification: string;
    categoryName: string | null;
    confidence: number;
    flags: string[];
    action: string;
  }> = [];

  let synced = 0;
  let skipped = 0;
  let internalTransfers = 0;
  const parseErrors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);

    const dateStr = fields[dateIdx]?.trim();
    const rawDescription = fields[descIdx]?.trim() || "";
    const appearsAs = appearsAsIdx >= 0 ? fields[appearsAsIdx]?.trim() : "";
    const amexCategory = categoryIdx >= 0 ? fields[categoryIdx]?.trim() : null;
    const reference = referenceIdx >= 0 ? fields[referenceIdx]?.trim() : null;
    const amountStr = fields[amountIdx]?.trim();

    if (!dateStr || !amountStr) {
      parseErrors.push(`Line ${i + 1}: missing date or amount`);
      continue;
    }

    const amount = parseFloat(amountStr.replace(/[$,]/g, ""));
    if (isNaN(amount)) {
      parseErrors.push(`Line ${i + 1}: invalid amount "${amountStr}"`);
      continue;
    }

    const parsedDate = new Date(dateStr);
    if (isNaN(parsedDate.getTime())) {
      parseErrors.push(`Line ${i + 1}: invalid date "${dateStr}"`);
      continue;
    }

    // Use "Appears On Your Statement As" as primary merchant name, fall back to Description
    const merchantName = appearsAs || rawDescription;

    // Detect internal transfers (Amex payment from Mercury)
    const isInternalTransfer = amount < 0 ||
      rawDescription.toLowerCase().includes("mobile payment") ||
      rawDescription.toLowerCase().includes("thank you") ||
      rawDescription.toLowerCase().includes("payment received");

    if (isInternalTransfer) {
      internalTransfers++;
      results.push({
        date: parsedDate.toISOString(),
        description: rawDescription,
        amount,
        amexCategory,
        classification: "internal_transfer",
        categoryName: null,
        confidence: 0.99,
        flags: ["INTERNAL_TRANSFER: payment from Mercury, excluded from P&L"],
        action: dryRun ? "dry_run_skip" : "skipped_transfer",
      });
      continue;
    }

    // Amex charges are expenses — store as negative cents
    const amountCents = Math.round(amount * -100);

    // Build unique ID from reference or date+description+amount
    const externalId = reference
      ? `amex-${reference}`
      : `amex-${parsedDate.toISOString().split("T")[0]}-${merchantName.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "")}-${Math.abs(amountCents)}`;

    // Skip duplicates
    const existing = await prisma.transaction.findUnique({
      where: { source_externalId: { source: "amex", externalId } },
    });

    if (existing) {
      skipped++;
      results.push({
        date: parsedDate.toISOString(),
        description: merchantName,
        amount,
        amexCategory,
        classification: existing.classification,
        categoryName: null,
        confidence: 1,
        flags: [],
        action: "skipped_duplicate",
      });
      continue;
    }

    // Auto-categorize using our merchant mapping engine
    const catResult = await categorizTransaction(merchantName, rawDescription);

    // Build flags
    const flags: string[] = [];
    if (catResult.confidence === 0) {
      flags.push(`UNKNOWN_MERCHANT: "${merchantName}" not in mapping database`);
    }
    if (amexCategory) {
      flags.push(`AMEX_CATEGORY: ${amexCategory}`);
    }
    if (amount > 3000) {
      flags.push(`LARGE_EXPENSE: $${amount.toFixed(2)}`);
    }

    // Get category name for display
    let categoryName: string | null = null;
    if (catResult.categoryId) {
      const cat = await prisma.financialCategory.findUnique({ where: { id: catResult.categoryId } });
      categoryName = cat?.name || null;
    }

    if (!dryRun) {
      await prisma.transaction.create({
        data: {
          externalId,
          source: "amex",
          date: parsedDate,
          amountCents,
          merchantName,
          description: rawDescription !== merchantName ? rawDescription : null,
          classification: catResult.classification,
          categoryId: catResult.categoryId,
          status: catResult.confidence >= 0.7 ? "auto_categorized" : "needs_review",
          confidenceScore: catResult.confidence,
        },
      });
    }

    synced++;
    results.push({
      date: parsedDate.toISOString(),
      description: merchantName,
      amount,
      amexCategory,
      classification: catResult.classification,
      categoryName,
      confidence: catResult.confidence,
      flags,
      action: dryRun ? "dry_run" : "created",
    });
  }

  if (!dryRun && synced > 0) {
    await prisma.syncLog.create({
      data: {
        source: "amex",
        syncType: "csv_import",
        status: parseErrors.length > 0 ? "error" : "success",
        recordsSynced: synced,
        errorMessage: parseErrors.length > 0 ? parseErrors.join("; ") : null,
      },
    });
  }

  const needsReview = results.filter(r => r.confidence === 0 && r.action !== "skipped_duplicate" && r.action !== "skipped_transfer" && r.action !== "dry_run_skip");

  return NextResponse.json({
    dryRun,
    summary: {
      totalLines: lines.length - 1,
      synced,
      skipped,
      internalTransfers,
      parseErrors: parseErrors.length,
      needsReviewCount: needsReview.length,
    },
    needsReview,
    results,
    parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
  });
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if ((char === "," || char === "\t") && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}
