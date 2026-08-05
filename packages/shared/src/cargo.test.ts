import { describe, it, expect } from "vitest";
import {
  REFERENCE_TAGS, referenceTagLabel, cargoCreateSchema, cargoUpdateSchema, cargoLabel,
  PACKAGE_TYPES, UOMS,
  toCanonicalDim, fromCanonicalDim, toCanonicalWeight, fromCanonicalWeight,
  cbmFromCanonical, weightUnitLabel,
  packageCreateSchema, packageUpdateSchema, itemCreateSchema, itemUpdateSchema, effectiveTags,
} from "./cargo";
import { DIM_UNITS, WEIGHT_UNITS, cbmFromDims, toKg } from "./cargo";

describe("ReferenceTag vocabulary", () => {
  it("pins the tag order", () => {
    expect(REFERENCE_TAGS).toEqual(["HEAVY", "FRAGILE", "NON_STACKABLE", "OUT_OF_GAUGE", "DG"]);
  });
});

describe("reference tags", () => {
  it("includes OUT_OF_GAUGE", () => {
    expect(REFERENCE_TAGS).toEqual(["HEAVY", "FRAGILE", "NON_STACKABLE", "OUT_OF_GAUGE", "DG"]);
  });
  it("labels OUT_OF_GAUGE as 'Out of Gauge Cargo'", () => {
    expect(referenceTagLabel("OUT_OF_GAUGE")).toBe("Out of Gauge Cargo");
    expect(referenceTagLabel("NON_STACKABLE")).toBe("Non Stackable");
  });
});

// packing-list re-model (Query→Cargo→Package→Item): the old flat cargoCreateSchema row
// (productName/qty/dims/grossWt/hsCode/isDangerous all on one row) is replaced by
// packageCreateSchema (dims/weights/packageType/tags) + itemCreateSchema (product/qty/uom/
// hsCode/tags); cargoCreateSchema is now just the PO/label/unit grouping. See the
// "packing-list schemas" + "effectiveTags" suites below for the new-shape contract tests.
describe("packing-list schemas", () => {
  it("cargo accepts optional PO + requires units with defaults", () => {
    expect(cargoCreateSchema.safeParse({}).success).toBe(true);
    const r = cargoCreateSchema.parse({});
    expect(r.dimUnit).toBe("CM");
    expect(r.weightUnit).toBe("KG");
  });
  it("package requires packageNo + type + dims + gross", () => {
    const base = { packageNo: "P-1", packageType: "PALLET", dimL: 120, dimW: 100, dimH: 140, grossWt: 420 };
    expect(packageCreateSchema.safeParse(base).success).toBe(true);
    expect(packageCreateSchema.safeParse({ ...base, packageType: "NUCLEAR" }).success).toBe(false);
    expect(packageCreateSchema.safeParse({ ...base, dimL: 0 }).success).toBe(false); // V-1
    expect(packageCreateSchema.safeParse({ ...base, netWt: 500 }).success).toBe(false); // V-2 net>gross
  });
  it("item requires UoM only when qty present (V-4)", () => {
    expect(itemCreateSchema.safeParse({ product: "Paint" }).success).toBe(true);        // qty absent → ok
    expect(itemCreateSchema.safeParse({ product: "Paint", qty: 8 }).success).toBe(false); // qty w/o uom
    expect(itemCreateSchema.safeParse({ product: "Paint", qty: 8, uom: "PC" }).success).toBe(true);
  });
});

describe("effectiveTags (BL-3 union)", () => {
  it("unions package + item tags, deduped, order-stable", () => {
    expect(effectiveTags({ tags: ["HEAVY"], items: [{ tags: ["DG"] }, { tags: ["HEAVY", "FRAGILE"] }] }))
      .toEqual(["HEAVY", "DG", "FRAGILE"]);
  });
});

// Migrated coverage: assertions the old flat cargoCreateSchema made (bounds/enum/whitespace
// guards) that now belong on packageCreateSchema/itemCreateSchema instead.
describe("packageCreateSchema / itemCreateSchema — migrated coverage from the old flat cargoCreateSchema", () => {
  const base = { packageNo: "P-1", packageType: "PALLET", dimL: 120, dimW: 100, dimH: 140, grossWt: 420 };
  it("rejects a dim beyond the max bound (DECIMAL(14,6) overflow guard)", () => {
    expect(packageCreateSchema.safeParse({ ...base, dimL: 200000 }).success).toBe(false);
  });
  it("rejects a whitespace-only packageNo (G8)", () => {
    expect(packageCreateSchema.safeParse({ ...base, packageNo: "   " }).success).toBe(false);
  });
  it("accepts tags from the enum and rejects an unknown tag", () => {
    expect(packageCreateSchema.safeParse({ ...base, tags: ["HEAVY"] }).success).toBe(true);
    expect(packageCreateSchema.safeParse({ ...base, tags: ["NUCLEAR"] }).success).toBe(false);
  });
  it("rejects item qty <= 0", () => {
    expect(itemCreateSchema.safeParse({ product: "Paint", qty: 0, uom: "PC" }).success).toBe(false);
  });
});

describe("packageUpdateSchema", () => {
  it("rejects netWt > grossWt when both are present (migrated from the old cargoUpdateSchema)", () => {
    expect(packageUpdateSchema.safeParse({ netWt: 600, grossWt: 500 }).success).toBe(false);
  });
});

// Task 7 §A2: unlike itemCreateSchema (stateless — qty⇒uom must hold within the submitted
// object), itemUpdateSchema's old `.refine()` was STRICT on a PARTIAL patch: `{qty:8}` alone
// false-rejected even when the stored item already had a uom, because a partial-update schema
// structurally cannot see stored state. V-4 cross-field enforcement on update moved to
// item.service.ts's `update` (merge patched-or-stored qty/uom, then validate); e2e coverage for
// the merge behavior lives in apps/api/test/item.e2e-spec.ts. This schema now validates only
// per-field shape on update, no cross-field refine.
describe("itemUpdateSchema", () => {
  it("accepts qty alone on a partial patch (V-4 cross-field check moved service-side)", () => {
    expect(itemUpdateSchema.safeParse({ qty: 8 }).success).toBe(true);
    expect(itemUpdateSchema.safeParse({ qty: 8, uom: "PC" }).success).toBe(true);
    expect(itemUpdateSchema.safeParse({ qty: null, uom: null }).success).toBe(true);
  });
  it("still rejects an out-of-range qty regardless of uom (per-field shape still enforced)", () => {
    expect(itemUpdateSchema.safeParse({ qty: 0 }).success).toBe(false); // qty must be positive
    expect(itemUpdateSchema.safeParse({ qty: -5, uom: "PC" }).success).toBe(false);
  });
});

describe("cargoCreateSchema / cargoUpdateSchema (PO + units grouping)", () => {
  it("accepts a blank/absent PO reference", () => {
    expect(cargoCreateSchema.safeParse({}).success).toBe(true);
    expect(cargoCreateSchema.safeParse({ poReference: "" }).success).toBe(true);
  });
  it("accepts explicit MM/GM units", () => {
    const r = cargoCreateSchema.parse({ dimUnit: "MM", weightUnit: "GM" });
    expect(r.dimUnit).toBe("MM");
    expect(r.weightUnit).toBe("GM");
  });
  it("update schema rejects null poReference but accepts blank/omitted", () => {
    expect(cargoUpdateSchema.safeParse({ poReference: null }).success).toBe(false);
    expect(cargoUpdateSchema.safeParse({ poReference: "" }).success).toBe(true);
    expect(cargoUpdateSchema.safeParse({}).success).toBe(true);
  });
});

describe("cargoLabel", () => {
  it("prefers PO, falls back to product name, then Row n", () => {
    expect(cargoLabel({ poReference: "PO-1", productName: "Steel", rowIndex: 0 })).toBe("PO-1");
    expect(cargoLabel({ poReference: "", productName: "Steel", rowIndex: 0 })).toBe("Steel");
    expect(cargoLabel({ poReference: null, productName: "", rowIndex: 2 })).toBe("Row 3");
  });
  it("falls back to label when PO is absent, before product name", () => {
    expect(
      cargoLabel({ poReference: null, label: "Engine Parts", productName: "Steel", rowIndex: 0 }),
    ).toBe("Engine Parts");
    expect(cargoLabel({ poReference: "", label: "", productName: "Steel", rowIndex: 0 })).toBe("Steel");
    expect(cargoLabel({ poReference: undefined, label: "  ", productName: undefined, rowIndex: 4 })).toBe(
      "Row 5",
    );
  });
});

describe("units", () => {
  it("pins the unit arrays", () => {
    expect(DIM_UNITS).toEqual(["CM", "MM"]);
    expect(WEIGHT_UNITS).toEqual(["KG", "TONNE", "GM"]);
  });
  it("cbmFromDims returns m³ and is unit-consistent (same box, either unit)", () => {
    // 100×50×40 cm, qty 2 → 0.4 m³
    expect(cbmFromDims(100, 50, 40, 2, "CM")).toBeCloseTo(0.4, 6);
    // same box in mm → same 0.4 m³
    expect(cbmFromDims(1000, 500, 400, 2, "MM")).toBeCloseTo(0.4, 6);
  });
  it("toKg normalizes grams", () => {
    expect(toKg(5, "KG")).toBe(5);
    expect(toKg(5000, "GM")).toBe(5);
  });
});

describe("packing-list vocabularies", () => {
  it("pins package types + UoMs", () => {
    expect(PACKAGE_TYPES).toEqual(["BOX", "PALLET", "CRATE", "CARTON", "DRUM", "BUNDLE"]);
    expect(UOMS).toEqual(["PC", "SET", "BOX", "KG", "M", "ROLL"]);
  });
  it("adds DG and TONNE", () => {
    expect(REFERENCE_TAGS).toContain("DG");
    expect(WEIGHT_UNITS).toEqual(["KG", "TONNE", "GM"]);
  });
});

describe("canonical unit helpers", () => {
  it("dims round-trip cm/mm to canonical cm", () => {
    expect(toCanonicalDim(100, "CM")).toBe(100);
    expect(toCanonicalDim(1000, "MM")).toBe(100);          // 1000 mm = 100 cm
    expect(fromCanonicalDim(100, "MM")).toBe(1000);        // 100 cm shown as 1000 mm
    expect(fromCanonicalDim(toCanonicalDim(37, "MM"), "MM")).toBeCloseTo(37, 9); // V-6 round-trip
  });
  it("weights round-trip kg/tonne/g to canonical kg", () => {
    expect(toCanonicalWeight(5, "KG")).toBe(5);
    expect(toCanonicalWeight(2, "TONNE")).toBe(2000);
    expect(toCanonicalWeight(5000, "GM")).toBe(5);
    expect(fromCanonicalWeight(2000, "TONNE")).toBe(2);
  });
  it("cbmFromCanonical returns m³ from cm dims", () => {
    expect(cbmFromCanonical(100, 50, 40)).toBeCloseTo(0.2, 9); // one package, no ×qty
  });
  it("labels g and tonne", () => {
    expect(weightUnitLabel("GM")).toBe("g");
    expect(weightUnitLabel("TONNE")).toBe("tonne");
    expect(weightUnitLabel("KG")).toBe("kg");
  });
});
