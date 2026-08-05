import { describe, it, expect } from "vitest";
import {
  REFERENCE_TAGS, referenceTagLabel, cargoCreateSchema, cargoUpdateSchema, cargoLabel,
  PACKAGE_TYPES, UOMS,
  toCanonicalDim, fromCanonicalDim, toCanonicalWeight, fromCanonicalWeight,
  cbmFromCanonical, weightUnitLabel,
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

describe("cargoCreateSchema", () => {
  const base = {
    poReference: "PO-1",
    productName: "Widget",
    packageType: "Pallet",
    qty: 10,
    dimL: 120,
    dimW: 80,
    dimH: 100,
    grossWt: 500,
  };
  it("accepts a minimal valid row", () => {
    expect(cargoCreateSchema.safeParse(base).success).toBe(true);
  });
  it("rejects qty <= 0 (F5)", () => {
    expect(cargoCreateSchema.safeParse({ ...base, qty: 0 }).success).toBe(false);
  });
  it("rejects netWt > grossWt (F5)", () => {
    expect(cargoCreateSchema.safeParse({ ...base, netWt: 600 }).success).toBe(false);
  });
  it("accepts referenceTags from the enum and rejects unknown tags", () => {
    expect(cargoCreateSchema.safeParse({ ...base, referenceTags: ["HEAVY"] }).success).toBe(true);
    expect(cargoCreateSchema.safeParse({ ...base, referenceTags: ["NUCLEAR"] }).success).toBe(
      false,
    );
  });
  it("rejects a dim beyond the max bound (DECIMAL(14,6) overflow guard)", () => {
    expect(cargoCreateSchema.safeParse({ ...base, dimL: 200000 }).success).toBe(false);
  });
  it("rejects whitespace-only required text (G8)", () => {
    // poReference is now optional — blank/whitespace is accepted
    expect(cargoCreateSchema.safeParse({ ...base, productName: "  " }).success).toBe(false);
    expect(cargoCreateSchema.safeParse({ ...base, packageType: " " }).success).toBe(false);
  });
});

describe("cargoUpdateSchema", () => {
  it("rejects netWt > grossWt when both are present (F5)", () => {
    expect(cargoUpdateSchema.safeParse({ netWt: 600, grossWt: 500 }).success).toBe(false);
  });
});

describe("cargo schema round-3", () => {
  const base = { productName: "Widget", packageType: "Carton", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 };
  it("accepts a blank/absent PO reference", () => {
    expect(cargoCreateSchema.safeParse(base).success).toBe(true);
    expect(cargoCreateSchema.safeParse({ ...base, poReference: "" }).success).toBe(true);
  });
  it("defaults dimUnit=CM and weightUnit=KG when omitted", () => {
    const r = cargoCreateSchema.parse(base);
    expect(r.dimUnit).toBe("CM");
    expect(r.weightUnit).toBe("KG");
  });
  it("accepts explicit MM/GM units", () => {
    const r = cargoCreateSchema.parse({ ...base, dimUnit: "MM", weightUnit: "GM" });
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
