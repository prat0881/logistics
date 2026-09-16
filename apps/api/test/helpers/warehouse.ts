import { randomUUID } from "node:crypto";

/**
 * A complete, valid POST /api/warehouses body. Task 3 made `contacts` required with exactly one
 * PRIMARY, breaking 11 create sites that do not care about contacts. Same precedent as
 * `clientCreateBody` and `ffFixture`.
 *
 * `type: "CLIENT"` deliberately: OWNED and CONTRACTED carry the agreement/insurance-date
 * invariant (refineWarehouseInvariants), so a fixture defaulting to either would force every
 * caller to supply dates it does not care about.
 */
export function warehouseCreateBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const suffix = randomUUID();
  return {
    name: `Fixture Warehouse ${suffix}`,
    type: "CLIENT",
    streetAddress: "1 Fixture Way",
    country: "Fixture Country",
    city: "Fixture City",
    pinCode: "00000",
    capacity: 100,
    capacityUnit: "CBM",
    contacts: [
      {
        name: "Fixture Primary",
        email: `wh-fixture-${suffix}@e2e.test`,
        contactNo: "+971501234567",
        pocLevel: "PRIMARY",
      },
    ],
    ...overrides,
  };
}
