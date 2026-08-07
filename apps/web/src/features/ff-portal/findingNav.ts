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
