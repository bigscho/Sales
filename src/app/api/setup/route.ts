import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const [teamCount, weekCount, bookingCount, demoCount, paymentCount] = await Promise.all([
    prisma.teamMember.count(),
    prisma.week.count(),
    prisma.booking.count(),
    prisma.demo.count(),
    prisma.payment.count(),
  ]);
  return NextResponse.json({
    teamMembers: teamCount,
    weeks: weekCount,
    bookings: bookingCount,
    demos: demoCount,
    payments: paymentCount,
    needsSetup: teamCount === 0 || bookingCount === 0,
  });
}

export async function POST() {
  const results = { seed: "", import: "", errors: [] as string[] };

  // === STEP 1: Seed team members ===
  const members = [
    { id: "setter-ming", name: "Ming", role: "setter", tier: 2 },
    { id: "setter-luke", name: "Luke", role: "setter", tier: 1 },
    { id: "setter-logan", name: "Logan", role: "setter", tier: 1 },
    { id: "closer-colin", name: "Colin", role: "closer", tier: 1 },
    { id: "closer-mark", name: "Mark", role: "closer", tier: 1 },
    { id: "rep-belayneh", name: "Belayneh", role: "show_rate_rep", tier: 1 },
  ];
  for (const m of members) {
    await prisma.teamMember.upsert({
      where: { id: m.id },
      update: { name: m.name, role: m.role, tier: m.tier },
      create: m,
    });
  }

  // === STEP 2: Seed expense categories ===
  const categories = [
    "Setter Payroll", "Closer Payroll", "Show Rate Bonus", "Ad Spend",
    "Software", "Data Costs", "Contractors", "Other",
  ];
  for (let i = 0; i < categories.length; i++) {
    await prisma.expenseCategory.upsert({
      where: { name: categories[i] },
      update: {},
      create: { name: categories[i], sortOrder: i },
    });
  }
  results.seed = `Seeded ${members.length} team members, ${categories.length} expense categories`;

  // === STEP 3: Import weeks, bookings, demos, payments ===
  // Dynamically import the data from the import route's module
  const importModule = await import("@/app/api/import/route");
  const importResponse = await importModule.POST();
  const importData = await importResponse.json();
  results.import = importData.message || "Import completed";
  if (importData.errors?.length) {
    results.errors.push(...importData.errors);
  }

  return NextResponse.json({
    success: true,
    message: `Setup complete. ${results.seed}. ${results.import}`,
    results,
  });
}
