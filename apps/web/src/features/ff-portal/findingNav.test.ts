import { describe, it, expect } from "vitest";
import type { Finding } from "@svyft/shared";
import { findingSection } from "./findingNav";

const f = (rule: string, scope: Finding["scope"]): Finding => ({ rule, severity: "blocking", scope, message: "m" });

describe("findingSection", () => {
  it("maps Q1–Q8 to portal sections", () => {
    expect(findingSection(f("Q2", { type: "cargo", id: "c1" }))).toBe("density");
    expect(findingSection(f("Q4", { type: "field", id: "currency" }))).toBe("rfq");
    expect(findingSection(f("Q3", { type: "field", id: "quoteValidityUntil" }))).toBe("rfq");
    expect(findingSection(f("Q5", { type: "field", id: "dgSurchargeNote" }))).toBe("terms");
    expect(findingSection(f("Q6", { type: "field", id: "arrivalDate" }))).toBe("transit");
    expect(findingSection(f("Q8", { type: "leg", id: "L1" }))).toBe("warehouse");
    expect(findingSection(f("Q1", { type: "leg", id: "L1" }))).toBe("charges");
  });

  it("maps Q6 departureDate to transit", () => {
    expect(findingSection(f("Q6", { type: "field", id: "departureDate" }))).toBe("transit");
  });

  it("maps unknown scope to charges (default)", () => {
    expect(findingSection(f("UNKNOWN", { type: "query" }))).toBe("charges");
  });
});
