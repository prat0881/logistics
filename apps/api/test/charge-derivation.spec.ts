import { deriveRole, deriveZone } from "@svyft/shared";
import type { ReferenceTag } from "@svyft/shared";
import { CHARGE_LINE_DEFINITIONS } from "../src/seed/reference-seed";

/**
 * The acceptance criterion for the whole category/isAdditional → zone/role parallel change,
 * machine-checked. NOT an e2e spec: no Nest app, no database, no seed run — hence the plain
 * `.spec.ts` name (test/jest-e2e.json's testRegex accepts both).
 *
 * Why this and not charge-catalogue-invariant.e2e-spec.ts: that spec reads rows out of the
 * database and compares their zone/role to deriveZone/deriveRole. On CI those rows were created
 * by the seed *using* deriveZone/deriveRole, so it compares the derivation to itself and cannot
 * fail however either function is edited. The real oracle is here in the tree instead — the
 * `role:`/`zone:` literals on the 50 legacy definitions in reference-seed.ts, hand-authored
 * before the derivation existed and now overridden by it at seed time. Checking the derivation
 * against those literals is a genuine two-source comparison, and it is what makes editing either
 * function a test failure rather than a silent change in what every future quote prices.
 */
const CATEGORISED = CHARGE_LINE_DEFINITIONS.flatMap((d) =>
  // ROAD_WH_HANDLING is the one definition with no category (warehousing is deferred). It is
  // excluded because the seed genuinely still reads its role/zone literals directly — there is
  // nothing to derive them from — so there is no derivation to check for it.
  d.category ? [{ ...d, category: d.category }] : [],
);

describe("charge-line zone/role derivation", () => {
  it("has a legacy literal to check for every categorised definition", () => {
    // Guards the suite below against becoming vacuous: an `it.each` over an accidentally-empty
    // array reports zero tests and passes. 50 is the count as of the master-data expansion
    // branch; a definition added or removed here should be a deliberate edit to this number.
    expect(CATEGORISED).toHaveLength(50);
    expect(CATEGORISED.every((d) => d.role !== undefined)).toBe(true);
  });

  it.each(CATEGORISED.map((d) => [d.key, d] as const))(
    "%s: deriveZone reproduces the legacy zone literal",
    (_key, d) => {
      expect(deriveZone(d.category, d.mode)).toBe(d.zone ?? null);
    },
  );

  it.each(CATEGORISED.map((d) => [d.key, d] as const))(
    "%s: deriveRole reproduces the legacy role literal",
    (_key, d) => {
      expect(deriveRole(d.isAdditional ?? false, (d.tagKey ?? null) as ReferenceTag | null)).toBe(
        d.role,
      );
    },
  );
});
