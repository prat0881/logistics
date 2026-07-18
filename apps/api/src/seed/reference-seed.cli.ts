import { PrismaClient } from "@prisma/client";
import { seedReferenceData } from "./reference-seed";

// Reference-data-only seed entry point (density factors + checklist definitions + code
// sequences), run by the deploy pipeline right after `prisma migrate deploy`. It is
// idempotent/create-only, so it is safe to run on every deploy and guarantees these tables
// can never be left empty by a forgotten manual seed. The full seed (`seed.ts`) additionally
// creates login users and stays a MANUAL step, since it needs the `SEED_*` credentials.
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedReferenceData(prisma);
    console.log("Reference data ensured (density + checklist + code sequences).");
  } finally {
    await prisma.$disconnect();
  }
}

void main();
