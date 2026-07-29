import type { Finding } from "@svyft/shared";

export type PortalSection = "density" | "charges" | "warehouse" | "transit" | "rfq" | "terms";

export const PORTAL_SECTION_LABEL: Record<PortalSection, string> = {
  density: "Density & chargeable weight",
  charges: "Charges",
  warehouse: "Warehousing",
  transit: "Transit plan",
  rfq: "Currency & validity",
  terms: "Terms & DG note",
};

export const PORTAL_SECTION_ORDER: PortalSection[] = [
  "rfq",
  "density",
  "charges",
  "warehouse",
  "transit",
  "terms",
];

export function findingSection(f: Finding): PortalSection {
  const { scope } = f;

  if (scope.type === "cargo") return "density";

  if (scope.type === "field") {
    if (scope.id === "currency" || scope.id === "quoteValidityUntil") return "rfq";
    if (scope.id === "dgSurchargeNote") return "terms";
    if (scope.id === "departureDate" || scope.id === "arrivalDate") return "transit";
  }

  if (scope.type === "leg") {
    if (f.rule === "Q8") return "warehouse";
    return "charges";
  }

  return "charges";
}

export function sectionAnchorId(legId: string, section: PortalSection): string {
  return `leg-${legId}-${section}`;
}
