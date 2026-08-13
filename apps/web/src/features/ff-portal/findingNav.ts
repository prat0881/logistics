import type { Finding } from "@svyft/shared";

export type PortalSection =
  "density" | "charges" | "warehouse" | "transit" | "notes" | "rfq" | "terms";

export const PORTAL_SECTION_LABEL: Record<PortalSection, string> = {
  density: "Density & chargeable weight",
  charges: "Charges",
  warehouse: "Warehousing",
  transit: "Transit plan",
  notes: "Notes",
  rfq: "Currency & validity",
  terms: "Terms & DG note",
};

export const PORTAL_SECTION_ORDER: PortalSection[] = [
  "rfq",
  "density",
  "charges",
  "warehouse",
  "transit",
  "notes",
  "terms",
];

export function findingSection(f: Finding): PortalSection {
  const { scope } = f;

  // Generic cargo-scoped finding (route.ts-style route/cargo-assignment rules) — the FF portal's
  // validateQuote no longer emits this shape itself (v3's Q_WEIGHT is a leg-level field scope,
  // below), but density is still the most sensible default home for anything cargo-scoped.
  if (scope.type === "cargo") return "density";

  if (scope.type === "field") {
    if (scope.id === "currency" || scope.id === "quoteValidityUntil") return "rfq";
    if (scope.id === "dgSurchargeNote") return "terms";
    if (scope.id === "guaranteedTransitDays") return "transit"; // Q_TRANSIT (submit-gate v3)
    if (scope.id === "chargedWeightKg") return "density"; // Q_WEIGHT (submit-gate v3, leg-level)
  }

  if (scope.type === "leg") {
    // Warehouse pricing findings share Q_PRICED + leg scope with charge-line findings, so the
    // message is the only discriminator (validateQuote emits "Warehousing must be priced …").
    if (f.message.startsWith("Warehousing")) return "warehouse";
    return "charges";
  }

  return "charges";
}

export function sectionAnchorId(legId: string, section: PortalSection): string {
  return `leg-${legId}-${section}`;
}

/**
 * navigateToFindingSection — the finding-click handler behind `QuoteFindingsSummary`'s
 * `onNavigate` (wired from `LegSection`'s `handleNavigate`). Force-opens the finding's leg
 * (`openLeg`, called UNCONDITIONALLY — every time, regardless of current accordion state) before
 * scrolling to its target section.
 *
 * This ordering matters, not just the call: Round 4's accordion (design §4.8 finding #1) gates a
 * leg's body on `{open && <body>}`, so a collapsed leg's section anchors (`sectionAnchorId`) don't
 * exist in the DOM at all until it opens. `openLeg` is typically a React state setter (see
 * LegSection/FfPortalPage's `onOpen`), whose DOM effect isn't visible synchronously right after
 * it's called — a plain state update commits on React's own schedule, not this line — so the
 * lookup+scroll is deferred one frame via `requestAnimationFrame`, the SAME deferral the executive
 * `RfqWorkspace.jumpToLeg` uses for the identical "open, then find, then scroll" sequencing. When
 * the leg is already open, `openLeg` is a harmless no-op re-set and the deferred lookup still
 * finds the (already-mounted) target.
 *
 * "rfq" is the one exception: it targets `PortalShell`'s `#rfq-fields`, which sits page-level,
 * above/outside every leg's accordion — always mounted regardless of any leg's open state — so
 * `legId` and `openLeg` are irrelevant to reaching it (still called, for consistency/simplicity).
 */
export function navigateToFindingSection(
  legId: string,
  section: PortalSection,
  openLeg: () => void,
): void {
  openLeg();
  const id = section === "rfq" ? "rfq-fields" : sectionAnchorId(legId, section);
  requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
