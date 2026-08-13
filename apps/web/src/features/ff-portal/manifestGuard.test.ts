// manifestGuard.test.ts
import { describe, it, expect } from "vitest";
import { isV2Manifest } from "./manifestGuard";
import type { ManifestSnapshotCargo } from "@svyft/shared";

const v2Cargo: ManifestSnapshotCargo = {
  packageId: "pk1",
  packageNo: "PK-1",
  packageType: "BOX",
  packageCount: 1,
  dimL: "100",
  dimW: "100",
  dimH: "100",
  netWt: "900",
  grossWt: "1000",
  volumeCbm: "1",
  tags: [],
};

describe("isV2Manifest", () => {
  it("accepts a v2 manifest with package-shaped cargo", () => {
    expect(isV2Manifest({ cargo: [v2Cargo] } as never)).toBe(true);
  });

  it("accepts an empty cargo array (a valid, just-empty v2 leg)", () => {
    expect(isV2Manifest({ cargo: [] } as never)).toBe(true);
  });

  it("rejects a missing manifest", () => {
    expect(isV2Manifest(undefined)).toBe(false);
    expect(isV2Manifest(null)).toBe(false);
  });

  it("rejects manifest.cargo undefined (manifest present, cargo key missing)", () => {
    expect(isV2Manifest({} as never)).toBe(false);
  });

  it("rejects manifest.cargo that isn't an array (pre-v2 object shape)", () => {
    expect(isV2Manifest({ cargo: { legacy: true } } as never)).toBe(false);
  });

  it("rejects cargo items missing packageId (pre-v2 line-item shape)", () => {
    expect(isV2Manifest({ cargo: [{ productCode: "X", qty: 3 }] } as never)).toBe(false);
  });

  it("rejects cargo items missing tags", () => {
    const rest = { ...v2Cargo } as Partial<ManifestSnapshotCargo>;
    delete rest.tags;
    expect(isV2Manifest({ cargo: [rest] } as never)).toBe(false);
  });

  it("rejects null entries inside the cargo array", () => {
    expect(isV2Manifest({ cargo: [null] } as never)).toBe(false);
  });

  it("rejects when only some cargo entries are v2-shaped", () => {
    expect(isV2Manifest({ cargo: [v2Cargo, { legacy: true }] } as never)).toBe(false);
  });
});
