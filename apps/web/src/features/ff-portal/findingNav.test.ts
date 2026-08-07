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
  it("routes Charged Weight (Q_WEIGHT, submit-gate v3: leg-level field scope) to density", () => {
    // v3: Q_WEIGHT moved from a per-package `{type:"cargo", id:pkgId}` scope to one leg-level
    // `{type:"field", id:"chargedWeightKg"}` finding (quote-engine.ts) — this is the regression
    // this task fixes: before the fix, this shape fell through to the default "charges" bucket.
    expect(findingSection(f("Q_WEIGHT", { type: "field", id: "chargedWeightKg" }))).toBe("density");
  });

  it("still routes a generic cargo-scoped finding to density (defensive default; not emitted by validateQuote)", () => {
    // scope.type === "cargo" is a general FindingScope variant (e.g. route.ts's cargo-assignment
    // rules) unrelated to the FF portal's own submit-gate — kept as a sensible default in case a
    // cargo-scoped finding is ever routed through this function.
    expect(findingSection(f("R3", { type: "cargo", id: "pkg1" }))).toBe("density");
  });

  it("routes submit-gate findings to their portal sections", () => {
    // currency + validity
    expect(findingSection(f("Q_CURRENCY", { type: "field", id: "currency" }))).toBe("rfq");
    expect(findingSection(f("Q_VALIDITY", { type: "field", id: "quoteValidityUntil" }))).toBe(
      "rfq",
    );
    // DG surcharge note
    expect(findingSection(f("Q_DG_NOTE", { type: "field", id: "dgSurchargeNote" }))).toBe("terms");
    // charge-line pricing + per-variant rate
    expect(
      findingSection(f("Q_PRICED", { type: "leg", id: "L1" }, 'Charge line "THC" must be priced')),
    ).toBe("charges");
    expect(findingSection(f("Q_RATE", { type: "leg", id: "L1" }))).toBe("charges");
  });

  it("routes Guaranteed Transit Time (Q_TRANSIT) to the transit section, regardless of the per-variant message suffix", () => {
    // v3: Q_TRANSIT's scope.id stays the constant "guaranteedTransitDays" for every rate variant
    // (quote-engine.ts's `blk("Q_TRANSIT", ..., {type:"field", id:"guaranteedTransitDays"})`) —
    // only the *message* gains a " (Dedicated)" / " (Groupage)" suffix once 2+ variants are
    // priced. Routing is by rule+scope, not message, so every variant's finding still lands here.
    expect(findingSection(f("Q_TRANSIT", { type: "field", id: "guaranteedTransitDays" }))).toBe(
      "transit",
    );
    expect(
      findingSection(
        f(
          "Q_TRANSIT",
          { type: "field", id: "guaranteedTransitDays" },
          "Guaranteed Transit Time is required (Dedicated)",
        ),
      ),
    ).toBe("transit");
    expect(
      findingSection(
        f(
          "Q_TRANSIT",
          { type: "field", id: "guaranteedTransitDays" },
          "Guaranteed Transit Time is required (Groupage)",
        ),
      ),
    ).toBe("transit");
  });

  it("routes warehouse pricing (Q_PRICED + leg) to warehouse via its message", () => {
    // Warehouse shares Q_PRICED + leg scope with charge lines; the message discriminates.
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
