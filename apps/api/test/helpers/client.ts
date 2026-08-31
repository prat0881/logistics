import { randomUUID } from "node:crypto";

/**
 * A complete, valid POST /api/clients body. Task 3 made `contacts` required with exactly one
 * PRIMARY, which breaks the existing create sites that rightly do not care about contacts.
 * Same precedent and same reasoning as `ffFixture` in ./freight-forwarder.ts: state the
 * defaults once here rather than restating a contact block at every call site.
 */
export function clientCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const suffix = randomUUID();
  return {
    companyName: `Fixture Client ${suffix}`,
    country: "AE",
    streetAddress: "1 Fixture Way",
    city: "Fixture City",
    contacts: [
      {
        name: "Fixture Primary",
        email: `fixture-${suffix}@e2e.test`,
        contactNo: "+971501234567",
        pocLevel: "PRIMARY",
      },
    ],
    ...overrides,
  };
}
