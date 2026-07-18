import { describe, it, expect } from "vitest";
import { REFERENCE_TAGS, cargoCreateSchema, cargoUpdateSchema } from "./cargo";

describe("ReferenceTag vocabulary", () => {
  it("pins the tag order", () => {
    expect(REFERENCE_TAGS).toEqual(["HEAVY", "FRAGILE", "NON_STACKABLE"]);
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
});

describe("cargoUpdateSchema", () => {
  it("rejects netWt > grossWt when both are present (F5)", () => {
    expect(cargoUpdateSchema.safeParse({ netWt: 600, grossWt: 500 }).success).toBe(false);
  });
});
