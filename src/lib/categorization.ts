import { prisma } from "./db";

// Known internal transfer patterns
const INTERNAL_TRANSFER_PATTERNS = [
  /AMERICAN EXPRESS/i,
  /AMEX EPAYMENT/i,
  /STRIPE TRANSFER/i,
  /STRIPE PAYOUT/i,
  /Transfer to.*Amex/i,
  /Transfer from.*Stripe/i,
];

export interface CategorizationResult {
  classification: string;
  categoryId: string | null;
  confidence: number;
  matchedPattern: string | null;
}

export async function categorizTransaction(
  merchantName: string | null,
  description: string | null
): Promise<CategorizationResult> {
  const text = `${merchantName || ""} ${description || ""}`.trim();

  // Check internal transfers first
  for (const pattern of INTERNAL_TRANSFER_PATTERNS) {
    if (pattern.test(text)) {
      return {
        classification: "internal_transfer",
        categoryId: null,
        confidence: 0.95,
        matchedPattern: pattern.source,
      };
    }
  }

  // Check merchant mappings from the database
  const mappings = await prisma.merchantMapping.findMany({
    orderBy: { confidence: "desc" },
  });

  for (const mapping of mappings) {
    if (text.toUpperCase().includes(mapping.merchantPattern.toUpperCase())) {
      return {
        classification: mapping.classification,
        categoryId: mapping.categoryId,
        confidence: mapping.confidence,
        matchedPattern: mapping.merchantPattern,
      };
    }
  }

  return {
    classification: "needs_review",
    categoryId: null,
    confidence: 0,
    matchedPattern: null,
  };
}

export async function learnMapping(
  merchantName: string,
  classification: string,
  categoryId: string | null
): Promise<void> {
  // Normalize merchant pattern — take the main identifier
  const pattern = merchantName.trim().toUpperCase();
  if (!pattern) return;

  const existing = await prisma.merchantMapping.findUnique({
    where: { merchantPattern: pattern },
  });

  if (existing) {
    await prisma.merchantMapping.update({
      where: { id: existing.id },
      data: {
        classification,
        categoryId,
        timesConfirmed: existing.timesConfirmed + 1,
        confidence: Math.min(0.99, existing.confidence + 0.1),
      },
    });
  } else {
    await prisma.merchantMapping.create({
      data: {
        merchantPattern: pattern,
        classification,
        categoryId,
        confidence: 0.7,
        timesConfirmed: 1,
      },
    });
  }
}
