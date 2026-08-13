import { describe, it, expect, vi, afterEach } from "vitest";
import type { Finding } from "@svyft/shared";
import { findingSection, navigateToFindingSection, sectionAnchorId } from "./findingNav";

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

  // ── Round 4 fix: Q_PAST_DATE (design D3) field ids were never taught to findingSection, so
  // they all fell through to the "charges" default even though every one of them lives in the
  // Transit or Warehouse section (quote-engine.ts's `pastDateField` helper). ──────────────────
  it("routes every Q_PAST_DATE transit-plan field id to transit", () => {
    const transitDateIds = [
      "departureDate",
      "arrivalDate",
      "plannedPickupDate", // Road
      "plannedDeparture", // Air
      "plannedArrival", // Air
      "etd", // Sea
      "eta", // Sea
    ];
    for (const id of transitDateIds) {
      expect(findingSection(f("Q_PAST_DATE", { type: "field", id }))).toBe("transit");
    }
  });

  it("routes the Q_PAST_DATE warehouse cargo-acceptance-window finding to warehouse (prefixed id, startsWith not ===)", () => {
    // scope.id is `cargoAcceptanceWindow:${warehousePointId}` — one per warehouse line — so the
    // match must be a prefix check, not an exact-string match.
    expect(
      findingSection(f("Q_PAST_DATE", { type: "field", id: "cargoAcceptanceWindow:pt1" })),
    ).toBe("warehouse");
    expect(
      findingSection(f("Q_PAST_DATE", { type: "field", id: "cargoAcceptanceWindow:pt2" })),
    ).toBe("warehouse");
  });

  it("still routes Q_PIECE_WEIGHT's prefixed field id (pieceWeightKg:*) to charges (regression)", () => {
    // The HeavyWeight input IS in the charges matrix, so the pre-existing "charges" default is
    // correct for it — this locks that in now that findingSection gains explicit id-prefix checks.
    expect(
      findingSection(f("Q_PIECE_WEIGHT", { type: "field", id: "pieceWeightKg:HEAVY_WEIGHT_CALC" })),
    ).toBe("charges");
  });

  it("still routes currency/validity/DG findings as before (regression)", () => {
    expect(findingSection(f("Q_CURRENCY", { type: "field", id: "currency" }))).toBe("rfq");
    expect(findingSection(f("Q_VALIDITY", { type: "field", id: "quoteValidityUntil" }))).toBe(
      "rfq",
    );
    expect(findingSection(f("Q_DG_NOTE", { type: "field", id: "dgSurchargeNote" }))).toBe("terms");
  });
});

// ── Round 4, #1: force-open the finding's leg before scrolling ──────────────────────────────
describe("navigateToFindingSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // The lookup+scroll is deferred one requestAnimationFrame tick (matching the executive
  // RfqWorkspace.jumpToLeg's identical deferral) so a real React state-setter `openLeg` has a
  // chance to commit before `document.getElementById` runs — awaited here so tests observe the
  // post-frame state rather than the synchronous-return state.
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  it("force-opens the leg BEFORE scrolling, so a target that only exists once opened is still found", async () => {
    // Simulates a COLLAPSED leg: LegSection gates its body on `{open && <body>}`, so the section
    // anchor isn't in the DOM at all until the leg opens. `openLeg` here plays that role — it
    // mounts the element, mirroring what re-rendering with open=true would do.
    const scrollSpy = vi.fn();
    const openLeg = vi.fn(() => {
      const el = document.createElement("div");
      el.id = sectionAnchorId("L2", "charges");
      (el as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;
      document.body.appendChild(el);
    });

    expect(document.getElementById(sectionAnchorId("L2", "charges"))).toBeNull(); // collapsed: not mounted

    navigateToFindingSection("L2", "charges", openLeg);
    expect(openLeg).toHaveBeenCalledTimes(1); // force-open itself IS synchronous

    await nextFrame();

    expect(scrollSpy).toHaveBeenCalledTimes(1); // only reachable because openLeg ran first
  });

  it("still calls openLeg (idempotent force-open) when the leg is already open/mounted", async () => {
    const el = document.createElement("div");
    el.id = sectionAnchorId("L1", "density");
    const scrollSpy = vi.fn();
    (el as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;
    document.body.appendChild(el);
    const openLeg = vi.fn();

    navigateToFindingSection("L1", "density", openLeg);
    expect(openLeg).toHaveBeenCalledTimes(1);

    await nextFrame();

    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("scrolls to the page-level #rfq-fields anchor for the 'rfq' section (not a per-leg anchor)", async () => {
    const el = document.createElement("div");
    el.id = "rfq-fields";
    const scrollSpy = vi.fn();
    (el as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;
    document.body.appendChild(el);

    navigateToFindingSection("L1", "rfq", () => {});
    await nextFrame();

    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("does not throw synchronously, nor once the deferred frame runs, when the target section genuinely doesn't exist", async () => {
    expect(() => navigateToFindingSection("L1", "charges", () => {})).not.toThrow();
    await nextFrame(); // the deferred getElementById()?.scrollIntoView() no-ops via optional chaining
  });
});
