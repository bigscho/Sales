import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const members = [
    { id: "setter-ming", name: "Ming", role: "setter", tier: 2 },
    { id: "setter-luke", name: "Luke", role: "setter", tier: 1 },
    { id: "setter-jett", name: "Jett", role: "setter", tier: 1 },
    { id: "setter-christian", name: "Christian", role: "setter", tier: 1 },
    { id: "setter-oliver", name: "Oliver", role: "setter", tier: 1 },
    { id: "setter-nick", name: "Nick", role: "setter", tier: 1 },
    { id: "closer-colin", name: "Colin", role: "closer", tier: 1 },
    { id: "closer-mark", name: "Mark", role: "closer", tier: 1 },
    { id: "rep-belayneh", name: "Belayneh", role: "show_rate_rep", tier: 1 },
  ];

  for (const m of members) {
    await prisma.teamMember.upsert({
      where: { id: m.id },
      update: { name: m.name, role: m.role, tier: m.tier, isActive: true, excludeFromLeaderboard: false },
      create: m,
    });
  }

  console.log(`Seeded ${members.length} team members.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
