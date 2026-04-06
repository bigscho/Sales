import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const CATEGORIES = [
  { name: "Email Infrastructure", type: "business", costPurpose: "cogs", sortOrder: 1 },
  { name: "Software", type: "business", costPurpose: "overhead", sortOrder: 2 },
  { name: "Automation", type: "business", costPurpose: "cogs", sortOrder: 3 },
  { name: "Data", type: "business", costPurpose: "cogs", sortOrder: 4 },
  { name: "Internal Marketing", type: "business", costPurpose: "cac", sortOrder: 5 },
  { name: "CRM", type: "business", costPurpose: "cac", sortOrder: 6 },
  { name: "Communication", type: "business", costPurpose: "overhead", sortOrder: 7 },
  { name: "Accounting", type: "business", costPurpose: "overhead", sortOrder: 8 },
  { name: "Education", type: "business", costPurpose: "overhead", sortOrder: 9 },
  { name: "Verification", type: "business", costPurpose: "cogs", sortOrder: 10 },
  { name: "Fees", type: "business", costPurpose: "overhead", sortOrder: 11 },
  { name: "Payroll - Sales", type: "payroll", costPurpose: "cac", sortOrder: 12 },
  { name: "Payroll - Fulfillment", type: "payroll", costPurpose: "cogs", sortOrder: 13 },
  { name: "Payroll - Misc", type: "payroll", costPurpose: "overhead", sortOrder: 14 },
];

const MERCHANT_MAPPINGS: Array<{ pattern: string; classification: string; category: string }> = [
  // Email Infrastructure
  { pattern: "PUZZLEINBOXES", classification: "business", category: "Email Infrastructure" },
  { pattern: "SMARTLEAD", classification: "business", category: "Email Infrastructure" },
  { pattern: "ZAPMAIL", classification: "business", category: "Email Infrastructure" },
  { pattern: "CHEAP INBOXES", classification: "business", category: "Email Infrastructure" },
  { pattern: "SENDSENTRY", classification: "business", category: "Email Infrastructure" },
  { pattern: "GODADDY", classification: "business", category: "Internal Marketing" },
  // Software
  { pattern: "MARUNO", classification: "business", category: "Software" },
  { pattern: "CLICKUP", classification: "business", category: "Software" },
  { pattern: "FIREFLIES", classification: "business", category: "Software" },
  { pattern: "GOOGLE WORKSPACE", classification: "business", category: "Software" },
  { pattern: "GOOGLE *GSUITE", classification: "business", category: "Software" },
  { pattern: "ANTHROPIC", classification: "business", category: "Software" },
  { pattern: "DOCUSIGN", classification: "business", category: "Software" },
  { pattern: "LOVABLE", classification: "business", category: "Software" },
  { pattern: "SUPABASE", classification: "business", category: "Software" },
  { pattern: "NORDVPN", classification: "business", category: "Software" },
  { pattern: "CRISP", classification: "business", category: "Software" },
  // Automation
  { pattern: "ZAPIER", classification: "business", category: "Automation" },
  { pattern: "MAKE.COM", classification: "business", category: "Automation" },
  { pattern: "OPENAI", classification: "business", category: "Automation" },
  { pattern: "SERPAPI", classification: "business", category: "Automation" },
  { pattern: "N8N", classification: "business", category: "Automation" },
  // Data
  { pattern: "BATCHDATA", classification: "business", category: "Data" },
  { pattern: "PROPERTYSHARK", classification: "business", category: "Data" },
  // Internal Marketing
  { pattern: "HIGHLEVEL", classification: "business", category: "Internal Marketing" },
  { pattern: "GOHIGHLEVEL", classification: "business", category: "Internal Marketing" },
  { pattern: "PERSPECTIVES", classification: "business", category: "Internal Marketing" },
  { pattern: "CALENDLY", classification: "business", category: "Internal Marketing" },
  { pattern: "WEBFLOW", classification: "business", category: "Internal Marketing" },
  { pattern: "WISTIA", classification: "business", category: "Internal Marketing" },
  // CRM
  { pattern: "AIRTABLE", classification: "business", category: "CRM" },
  // Communication
  { pattern: "SLACK", classification: "business", category: "Communication" },
  { pattern: "LOOM", classification: "business", category: "Communication" },
  // Accounting
  { pattern: "QUICKBOOKS", classification: "business", category: "Accounting" },
  { pattern: "INTUIT", classification: "business", category: "Accounting" },
  // Education
  { pattern: "HORMOZI", classification: "business", category: "Education" },
  { pattern: "AFFIRM", classification: "business", category: "Education" },
  // Verification
  { pattern: "OMNIVERIFIER", classification: "business", category: "Verification" },
  // Payroll
  { pattern: "IT GLOBAL", classification: "payroll", category: "" },
  { pattern: "AXIA GROWTH", classification: "payroll", category: "" },
  { pattern: "AUGMANTRA", classification: "payroll", category: "" },
  { pattern: "BAY STATE BOOK", classification: "payroll", category: "" },
  // Personal
  { pattern: "UBER", classification: "personal", category: "" },
  { pattern: "AIRBNB", classification: "personal", category: "" },
  { pattern: "DIDI FOOD", classification: "personal", category: "" },
  { pattern: "APPLE.COM", classification: "personal", category: "" },
  { pattern: "PEPTIDE", classification: "personal", category: "" },
  { pattern: "GYM", classification: "personal", category: "" },
  { pattern: "SPA", classification: "personal", category: "" },
  { pattern: "BARBER", classification: "personal", category: "" },
  // Internal transfers
  { pattern: "AMERICAN EXPRESS", classification: "internal_transfer", category: "" },
  { pattern: "AMEX EPAYMENT", classification: "internal_transfer", category: "" },
  { pattern: "STRIPE TRANSFER", classification: "internal_transfer", category: "" },
  { pattern: "STRIPE PAYOUT", classification: "internal_transfer", category: "" },
];

export async function POST() {
  let categoriesCreated = 0;
  let mappingsCreated = 0;

  // Create categories
  for (const cat of CATEGORIES) {
    await prisma.financialCategory.upsert({
      where: { name: cat.name },
      update: { sortOrder: cat.sortOrder, costPurpose: cat.costPurpose },
      create: cat,
    });
    categoriesCreated++;
  }

  // Create merchant mappings
  const allCategories = await prisma.financialCategory.findMany();
  const catMap = new Map(allCategories.map((c) => [c.name, c.id]));

  for (const mapping of MERCHANT_MAPPINGS) {
    const categoryId = mapping.category ? catMap.get(mapping.category) || null : null;

    await prisma.merchantMapping.upsert({
      where: { merchantPattern: mapping.pattern },
      update: { classification: mapping.classification, categoryId },
      create: {
        merchantPattern: mapping.pattern,
        classification: mapping.classification,
        categoryId,
        confidence: 0.85,
        timesConfirmed: 0,
      },
    });
    mappingsCreated++;
  }

  return NextResponse.json({
    success: true,
    categoriesCreated,
    mappingsCreated,
  });
}
