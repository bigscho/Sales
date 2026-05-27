import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST() {
  // Seed team members
  const members = [
    { id: "setter-ming", name: "Ming", role: "setter", tier: 2 },
    { id: "setter-luke", name: "Luke", role: "setter", tier: 1 },
    { id: "setter-jett", name: "Jett", role: "setter", tier: 1 },
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

  // Create weeks: 4 past + 2 future (using UTC to match import data)
  for (let i = -2; i < 4; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i * 7);
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6, 23, 59, 59, 999));
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
    message: "Seeded 6 team members, 6 weeks (4 past + 2 future), and 8 expense categories",
  });
}
