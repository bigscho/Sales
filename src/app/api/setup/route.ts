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
  const results = { seed: "", import: "", cleanup: "", errors: [] as string[] };

  // === STEP 0: Clean up duplicate weeks from timezone mismatch ===
  // Old code created weeks with local-time midnight (e.g. 2026-03-30T04:00:00Z for US Eastern)
  // Import data uses UTC midnight (2026-03-30T00:00:00Z). Merge any duplicates.
  const allWeeks = await prisma.week.findMany({ orderBy: { weekStart: "asc" } });
  const weeksByMondayDate = new Map<string, typeof allWeeks>();
  for (const w of allWeeks) {
    // Group by the Monday date (YYYY-MM-DD), ignoring time component
    const d = new Date(w.weekStart);
    // Find the Monday for this date
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday));
    const key = monday.toISOString().slice(0, 10);
    const group = weeksByMondayDate.get(key) || [];
    group.push(w);
    weeksByMondayDate.set(key, group);
  }

  let mergedCount = 0;
  for (const [, group] of weeksByMondayDate) {
    if (group.length <= 1) continue;
    // Keep the one with UTC midnight (00:00:00.000Z), merge others into it
    const canonical = group.find(w => new Date(w.weekStart).getUTCHours() === 0)
      || group[0];
    const duplicates = group.filter(w => w.id !== canonical.id);

    for (const dup of duplicates) {
      // Move all related records to the canonical week
      await prisma.booking.updateMany({ where: { weekId: dup.id }, data: { weekId: canonical.id } });
      await prisma.demo.updateMany({ where: { weekId: dup.id }, data: { weekId: canonical.id } });
      await prisma.deal.updateMany({ where: { weekId: dup.id }, data: { weekId: canonical.id } });
      await prisma.expense.updateMany({ where: { weekId: dup.id }, data: { weekId: canonical.id } });
      await prisma.dayLock.deleteMany({ where: { weekId: dup.id } });
      await prisma.payrollRun.deleteMany({ where: { weekId: dup.id } });
      await prisma.week.delete({ where: { id: dup.id } });
      mergedCount++;
    }
  }
  results.cleanup = `Merged ${mergedCount} duplicate weeks`;

  // === STEP 1: Delete all existing bookings/demos to re-import clean ===
  // This ensures no duplicates from partial imports
  await prisma.deal.updateMany({ data: { demoId: null } });
  await prisma.demo.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.payment.deleteMany({});

  // === STEP 2: Seed team members ===
  const members = [
    { id: "setter-ming", name: "Ming", role: "setter", tier: 2 },
    { id: "setter-luke", name: "Luke", role: "setter", tier: 1 },
    { id: "setter-jett", name: "Jett", role: "setter", tier: 1, slackUserId: "U0B6EQNL6EA" },
    { id: "setter-christian", name: "Christian", role: "setter", tier: 1 },
    { id: "setter-oliver", name: "Oliver", role: "setter", tier: 1 },
    { id: "setter-nick", name: "Nick", role: "setter", tier: 1 },
    { id: "setter-evan", name: "Evan", role: "setter", tier: 1 },
    { id: "closer-colin", name: "Colin", role: "closer", tier: 1 },
    { id: "closer-matthew", name: "Matthew Schofield", role: "closer", tier: 1 },
    { id: "closer-will", name: "Will Farrell", role: "closer", tier: 1 },
    { id: "closer-mark", name: "Mark", role: "closer", tier: 1, isActive: false }, // departed Aug 2026
    { id: "rep-belayneh", name: "Belayneh", role: "show_rate_rep", tier: 1 },
  ];
  for (const m of members) {
    await prisma.teamMember.upsert({
      where: { id: m.id },
      update: { name: m.name, role: m.role, tier: m.tier, slackUserId: m.slackUserId, isActive: m.isActive ?? true, excludeFromLeaderboard: false },
      create: m,
    });
  }

  // === STEP 3: Seed expense categories ===
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

  // === STEP 4: Import weeks, bookings, demos, payments ===
  const importModule = await import("@/app/api/import/route");
  const importResponse = await importModule.POST();
  const importData = await importResponse.json();
  results.import = importData.message || "Import completed";
  if (importData.errors?.length) {
    results.errors.push(...importData.errors);
  }

  return NextResponse.json({
    success: true,
    message: `Setup complete. ${results.cleanup}. ${results.seed}. ${results.import}`,
    results,
  });
}
