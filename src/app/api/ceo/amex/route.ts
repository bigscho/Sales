import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { categorizTransaction } from "@/lib/categorization";

// Amex CSV import endpoint
// Expected CSV format: Date, Description, Card Member, Amount
// or: Date, Reference, Description, Amount
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { csvData } = body;

  if (!csvData) {
    return NextResponse.json({ error: "csvData is required" }, { status: 400 });
  }

  const lines = csvData.split("\n").filter((l: string) => l.trim());
  if (lines.length < 2) {
    return NextResponse.json({ error: "CSV must have a header row and at least one data row" }, { status: 400 });
  }

  // Parse header to detect format
  const header = lines[0].toLowerCase();
  const isAmexFormat = header.includes("card member") || header.includes("description");

  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV line (handle quoted fields)
    const fields = parseCSVLine(line);
    if (fields.length < 3) {
      errors.push(`Line ${i + 1}: not enough fields`);
      continue;
    }

    let date: string;
    let description: string;
    let amount: number;

    if (isAmexFormat && fields.length >= 4) {
      // Amex format: Date, Description, Card Member, Amount
      date = fields[0];
      description = fields[1];
      amount = parseFloat(fields[fields.length - 1].replace(/[$,]/g, ""));
    } else {
      // Generic format: Date, Description, Amount
      date = fields[0];
      description = fields[1];
      amount = parseFloat(fields[fields.length - 1].replace(/[$,]/g, ""));
    }

    if (isNaN(amount)) {
      errors.push(`Line ${i + 1}: invalid amount`);
      continue;
    }

    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      errors.push(`Line ${i + 1}: invalid date "${date}"`);
      continue;
    }

    // Amex charges are expenses (negative), but Amex CSV shows them as positive
    const amountCents = Math.round(amount * -100);
    const externalId = `amex-${parsedDate.toISOString().split("T")[0]}-${description.slice(0, 30)}-${Math.abs(amountCents)}`;

    // Skip duplicates
    const existing = await prisma.transaction.findUnique({
      where: { source_externalId: { source: "amex", externalId } },
    });

    if (existing) {
      skipped++;
      continue;
    }

    const result = await categorizTransaction(description, null);

    await prisma.transaction.create({
      data: {
        externalId,
        source: "amex",
        date: parsedDate,
        amountCents,
        merchantName: description,
        description: null,
        classification: result.classification,
        categoryId: result.categoryId,
        status: result.confidence >= 0.7 ? "auto_categorized" : "needs_review",
        confidenceScore: result.confidence,
      },
    });
    synced++;
  }

  await prisma.syncLog.create({
    data: {
      source: "amex",
      syncType: "csv_import",
      status: errors.length > 0 ? "error" : "success",
      recordsSynced: synced,
      errorMessage: errors.length > 0 ? errors.join("; ") : null,
    },
  });

  return NextResponse.json({ success: true, synced, skipped, errors });
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}
