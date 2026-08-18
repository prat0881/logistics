import { describe, expect, it } from "vitest";
import { clientAmount, priceQuotation } from "./quotation-pricing";

const legs = [{
  legId: "l1", legCode: "L1", forwarderName: "Bridge", variantLabel: "Dedicated",
  groups: [{ group: "ORIGIN" as const, label: "Origin charges", costUsd: 300,
    lines: [
      { id: "ORIGIN:0", group: "ORIGIN" as const, label: "THC", costNative: 0, costUsd: 100 },
      { id: "ORIGIN:1", group: "ORIGIN" as const, label: "Docs", costNative: 0, costUsd: 200 },
    ] }],
}];

describe("clientAmount", () => {
  it("marks up on cost, not margin-on-sell", () => {
    expect(clientAmount(100, 20)).toBe(120);      // NOT 125
    expect(clientAmount(100, 0)).toBe(100);
  });
  it("rounds to cents", () => { expect(clientAmount(103.47, 18)).toBe(122.09); });
});

describe("priceQuotation", () => {
  it("applies the margin to every line and rolls up", () => {
    const p = priceQuotation(legs, 20, {});
    expect(p.legs[0].groups[0].lines.map((l) => l.clientUsd)).toEqual([120, 240]);
    expect(p.legs[0].groups[0].clientUsd).toBe(360);
    expect(p.clientTotalUsd).toBe(360);
    expect(p.costTotalUsd).toBe(300);
    expect(p.marginValueUsd).toBe(60);
  });

  it("an override pins its line and is excluded from recalculation", () => {
    const p = priceQuotation(legs, 20, { "l1:ORIGIN:1": 500 });
    expect(p.legs[0].groups[0].lines[0]).toMatchObject({ clientUsd: 120, overridden: false });
    expect(p.legs[0].groups[0].lines[1]).toMatchObject({ clientUsd: 500, overridden: true });
    expect(p.clientTotalUsd).toBe(620);
  });

  it("changing the margin moves unpinned lines only", () => {
    const a = priceQuotation(legs, 20, { "l1:ORIGIN:1": 500 });
    const b = priceQuotation(legs, 50, { "l1:ORIGIN:1": 500 });
    expect(b.legs[0].groups[0].lines[0].clientUsd).toBe(150);
    expect(b.legs[0].groups[0].lines[1].clientUsd).toBe(500);
    expect(a.legs[0].groups[0].lines[1].clientUsd).toBe(500);
  });

  it("re-rounds after summing so per-line rounding cannot leak a float artifact", () => {
    const drift = [{ legId: "l1", legCode: "L1", forwarderName: "B", variantLabel: null,
      groups: [{ group: "ORIGIN" as const, label: "Origin charges", costUsd: 0,
        lines: [1000.1, 500.25, 233.33].map((c, i) => ({ id: `ORIGIN:${i}`, group: "ORIGIN" as const, label: `L${i}`, costNative: 0, costUsd: c })) }] }];
    const p = priceQuotation(drift, 0, {});
    expect(p.clientTotalUsd).toBe(1733.68);
    expect([1000.1, 500.25, 233.33].reduce((s, n) => s + n, 0)).not.toBe(1733.68);
  });

  it("ignores an override whose key matches no line", () => {
    const p = priceQuotation(legs, 20, { "l1:NOPE:9": 999 });
    expect(p.clientTotalUsd).toBe(360);
  });
});
