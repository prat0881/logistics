import { describe, expect, it } from "vitest";
import { buildChargeTree } from "./chargeTree";

const lines = [
  { group: "freight", label: "Freight", nativeAmount: 4200, usdAmount: 1143.63 },
  { group: "additional", label: "Additional Charges", nativeAmount: 2100, usdAmount: 571.82 },
  { group: "warehouse", label: "Warehousing", nativeAmount: 400, usdAmount: 108.92 },
];

describe("buildChargeTree", () => {
  it("maps each flat line to a top-level node with no children", () => {
    const t = buildChargeTree(lines);
    expect(t).toHaveLength(3);
    expect(t[0]).toMatchObject({ label: "Freight", nativeAmount: 4200, usdAmount: 1143.63 });
    expect(t.every((n) => n.children.length === 0)).toBe(true);
  });

  it("keeps API order and gives every node a stable id", () => {
    const t = buildChargeTree(lines);
    expect(t.map((n) => n.label)).toEqual(["Freight", "Additional Charges", "Warehousing"]);
    expect(new Set(t.map((n) => n.id)).size).toBe(3);
  });

  it("returns [] for an offer with no charge lines", () => {
    expect(buildChargeTree([])).toEqual([]);
  });
});
