import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Setters
  await prisma.teamMember.upsert({
    where: { id: "setter-ming" },
    update: {},
    create: { id: "setter-ming", name: "Ming", role: "setter", tier: 2 },
  });
  await prisma.teamMember.upsert({
    where: { id: "setter-luke" },
    update: {},
    create: { id: "setter-luke", name: "Luke", role: "setter", tier: 1 },
  });
  await prisma.teamMember.upsert({
    where: { id: "setter-jett" },
    update: {},
    create: { id: "setter-jett", name: "Jett", role: "setter", tier: 1 },
  });

  // Closers
  await prisma.teamMember.upsert({
    where: { id: "closer-colin" },
    update: {},
    create: { id: "closer-colin", name: "Colin", role: "closer" },
  });
  await prisma.teamMember.upsert({
    where: { id: "closer-mark" },
    update: {},
    create: { id: "closer-mark", name: "Mark", role: "closer" },
  });

  // Show Rate Rep
  await prisma.teamMember.upsert({
    where: { id: "rep-belayneh" },
    update: {},
    create: { id: "rep-belayneh", name: "Belayneh", role: "show_rate_rep" },
  });

  console.log("Seeded 6 team members.");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
