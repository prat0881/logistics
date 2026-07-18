import { PrismaClient } from "@prisma/client";
import { runSeed, seedUsersFromEnv } from "./seed-core";
import { seedReferenceData } from "./reference-seed";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runSeed(prisma, seedUsersFromEnv());
    await seedReferenceData(prisma);
    console.log("Seed complete: users + reference data ensured.");
  } finally {
    await prisma.$disconnect();
  }
}

void main();
