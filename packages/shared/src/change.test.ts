import { describe, it, expect } from "vitest";
import { ImpactClass, IMPACT_RANK, decidePath } from "./change";

describe("IMPACT_RANK ordering (§11.1, by downstream cost)", () => {
  it("orders Internal < Corrective < RfqDefining < PricingAwardDefining < Structural", () => {
    expect(IMPACT_RANK.Internal).toBeLessThan(IMPACT_RANK.Corrective);
    expect(IMPACT_RANK.Corrective).toBeLessThan(IMPACT_RANK.RfqDefining);
    expect(IMPACT_RANK.RfqDefining).toBeLessThan(IMPACT_RANK.PricingAwardDefining);
    expect(IMPACT_RANK.PricingAwardDefining).toBeLessThan(IMPACT_RANK.Structural);
  });
});

describe("decidePath (§7.3 fork, §11.2/§11.4)", () => {
  it("takes the Free path whenever there is no downstream work — any class (pre-RFQ)", () => {
    expect(decidePath(ImpactClass.Internal, false)).toBe("free");
    expect(decidePath(ImpactClass.RfqDefining, false)).toBe("free");
    expect(decidePath(ImpactClass.Structural, false)).toBe("free");
  });

  it("takes the Change-order path only for RfqDefining-or-heavier WITH downstream work", () => {
    expect(decidePath(ImpactClass.RfqDefining, true)).toBe("change-order");
    expect(decidePath(ImpactClass.PricingAwardDefining, true)).toBe("change-order");
    expect(decidePath(ImpactClass.Structural, true)).toBe("change-order");
  });

  it("keeps Internal/Corrective on the Free path even WITH downstream work (class still gates, §7.5)", () => {
    expect(decidePath(ImpactClass.Internal, true)).toBe("free");
    expect(decidePath(ImpactClass.Corrective, true)).toBe("free"); // e.g. a legName typo post-RFQ
  });
});
