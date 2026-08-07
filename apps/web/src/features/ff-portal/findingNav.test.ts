import { describe, it, expect } from "vitest";
import type { Finding } from "@svyft/shared";
import { findingSection } from "./findingNav";

const f = (rule: string, scope: Finding["scope"], message = "m"): Finding => ({
  rule,
  severity: "blocking",
  scope,
  message,
});

describe("findingSection", () => {
  it("routes submit-gate v2 findings to their portal sections", () => {
    // Charged Weight (Q_WEIGHT) lives under the density block
    expect(findingSection(f("Q_WEIGHT", { type: "cargo", id: "pkg1" }))).toBe("density");
    // currency + validity
    expect(findingSection(f("Q_CURRENCY", { type: "field", id: "currency" }))).toBe("rfq");
    expect(findingSection(f("Q_VALIDITY", { type: "field", id: "quoteValidityUntil" }))).toBe(
      "rfq",
    );
    // DG surcharge note
    expect(findingSection(f("Q_DG_NOTE", { type: "field", id: "dgSurchargeNote" }))).toBe("terms");
    // charge-line pricing + dual-rate
    expect(
      findingSection(f("Q_PRICED", { type: "leg", id: "L1" }, 'Charge line "THC" must be priced')),
    ).toBe("charges");
    expect(findingSection(f("Q_RATE", { type: "leg", id: "L1" }))).toBe("charges");
  });

  it("routes Guaranteed Transit Time (Q_TRANSIT) to the transit section", () => {
    // Regression: before Unit 6 this field id fell through to the default "charges" bucket.
    expect(findingSection(f("Q_TRANSIT", { type: "field", id: "guaranteedTransitDays" }))).toBe(
      "transit",
    );
  });

  it("routes warehouse pricing (Q_PRICED + leg) to warehouse via its message", () => {
    // Warehouse shares Q_PRICED + leg scope with charge lines; the message discriminates.
    // Regression: before Unit 6 this landed in "charges".
    expect(
      findingSection(
        f("Q_PRICED", { type: "leg", id: "L1" }, "Warehousing must be priced for Origin CFS"),
      ),
    ).toBe("warehouse");
  });

  it("defaults unknown scope to charges", () => {
    expect(findingSection(f("UNKNOWN", { type: "query" }))).toBe("charges");
  });
});
