import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWeekRange } from "@/lib/utils";

export async function POST() {
  // Seed team members
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

  // Create weeks for the last 4 weeks
  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    const { start, end } = getWeekRange(d);
    await prisma.week.upsert({
      where: { weekStart: start },
      create: { weekStart: start, weekEnd: end },
      update: {},
    });
  }

  // Seed default expense categories
  const categories = [
    "Setter Payroll",
    "Closer Payroll",
    "Show Rate Bonus",
    "Ad Spend",
    "Software",
    "Data Costs",
    "Contractors",
    "Other",
  ];
  for (let i = 0; i < categories.length; i++) {
    await prisma.expenseCategory.upsert({
      where: { name: categories[i] },
      update: {},
      create: { name: categories[i], sortOrder: i },
    });
  }

  return NextResponse.json({
    success: true,
    message: "Seeded 6 team members, 4 weeks, and 8 expense categories",
  });
}
