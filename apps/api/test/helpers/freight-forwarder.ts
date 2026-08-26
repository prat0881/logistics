import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

// Task 5 (master-data expansion): companyAddress/city/country became required (NOT NULL, no
// column default — see the migration.sql comment) on FreightForwarder. ~33 e2e-spec.ts files
// build a FreightForwarder directly via `prisma.freightForwarder.create()` and none of them
// care about its address; restating three fields at every one of those call sites would be
// pure churn, and a database default would let production silently accept and mislabel an
// address-less forwarder (rejected — see the ruling in task-5-report.md). This helper is the
// alternative: a complete, valid create-input with sensible defaults for every required field,
// so call sites only state what they actually care about.
//
// freightForwarderCode/companyName are both globally @unique, so the defaults here are minted
// per-call via randomUUID() — not Date.now()+counter, which two jest workers starting in the
// same millisecond can both mint identically on their first call, colliding on both unique
// columns at once. Callers that assert on the code/name, or that need a stable value to
// search/re-fetch by, should still pass their own via `overrides`.

function mintSuffix(): string {
  return randomUUID();
}

export function ffFixture(
  overrides: Partial<Prisma.FreightForwarderCreateInput> = {},
): Prisma.FreightForwarderCreateInput {
  const suffix = mintSuffix();
  return {
    freightForwarderCode: `FF-FIXTURE-${suffix}`,
    companyName: `Fixture Forwarder ${suffix}`,
    companyAddress: "1 Fixture Way",
    city: "Fixture City",
    country: "Fixture Country",
    pic: "Fixture PIC",
    contactNumber: "+10000000000",
    email: `fixture-${suffix}@e2e.test`,
    availableCountries: ["AE"],
    modes: ["AIR"],
    handleDg: false,
    ...overrides,
  };
}
