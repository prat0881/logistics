import { describe, it, expect } from "vitest";
import { computeChargeableWeight } from "./quote-engine";

describe("computeChargeableWeight", () => {
  it("returns the gross weight when it exceeds the volumetric weight", () => {
    // 2 T gross, 1 m³ × 167 kg/CBM = 0.167 T volumetric ⇒ gross wins
    expect(computeChargeableWeight(2, 1, 167)).toBe(2);
  });
  it("returns the volumetric weight when it exceeds gross (Air 167)", () => {
    // 0.1 T gross, 5 m³ × 167 / 1000 = 0.835 T volumetric ⇒ volumetric wins
    expect(computeChargeableWeight(0.1, 5, 167)).toBeCloseTo(0.835, 6);
  });
  it("uses the mode density (Sea 1000 kg/CBM)", () => {
    expect(computeChargeableWeight(0.5, 2, 1000)).toBe(2); // 2×1000/1000 = 2 T
  });
});
