import { PrismaClient } from "@prisma/client";
import { runSeed, seedUsersFromEnv } from "./seed-core";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runSeed(prisma, seedUsersFromEnv());
    // eslint-disable-next-line no-console
    console.log("Seed complete: administrator, manager, executive ensured.");
  } finally {
    await prisma.$disconnect();
  }
}

void main();
