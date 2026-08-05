import { z } from "zod";

export const DimUnit = { CM: "CM", MM: "MM" } as const;
export type DimUnit = (typeof DimUnit)[keyof typeof DimUnit];
export const DIM_UNITS = Object.values(DimUnit) as [DimUnit, ...DimUnit[]];

export const WeightUnit = { KG: "KG", TONNE: "TONNE", GM: "GM" } as const;
export type WeightUnit = (typeof WeightUnit)[keyof typeof WeightUnit];
export const WEIGHT_UNITS = Object.values(WeightUnit) as [WeightUnit, ...WeightUnit[]];

export const PackageType = {
  BOX: "BOX", PALLET: "PALLET", CRATE: "CRATE", CARTON: "CARTON", DRUM: "DRUM", BUNDLE: "BUNDLE",
} as const;
export type PackageType = (typeof PackageType)[keyof typeof PackageType];
export const PACKAGE_TYPES = Object.values(PackageType) as [PackageType, ...PackageType[]];

export const UnitOfMeasure = {
  PC: "PC", SET: "SET", BOX: "BOX", KG: "KG", M: "M", ROLL: "ROLL",
} as const;
export type UnitOfMeasure = (typeof UnitOfMeasure)[keyof typeof UnitOfMeasure];
export const UOMS = Object.values(UnitOfMeasure) as [UnitOfMeasure, ...UnitOfMeasure[]];

/** Volume in cubic metres from dims in the chosen unit. cm³/1e6 = m³; mm³/1e9 = m³. */
export function cbmFromDims(dimL: number, dimW: number, dimH: number, qty: number, dimUnit: DimUnit): number {
  const div = dimUnit === "MM" ? 1e9 : 1e6;
  return (dimL * dimW * dimH * qty) / div;
}

/** Normalize a weight in the chosen unit to kilograms. */
export function toKg(weight: number, weightUnit: WeightUnit): number {
  return weightUnit === "GM" ? weight / 1000 : weight;
}

/** Convert a dimension value to canonical cm. */
export function toCanonicalDim(v: number, u: DimUnit): number {
  return u === "MM" ? v / 10 : v;
}

/** Convert from canonical cm to the chosen unit. */
export function fromCanonicalDim(vCm: number, u: DimUnit): number {
  return u === "MM" ? vCm * 10 : vCm;
}

/** Convert a weight value to canonical kg. */
export function toCanonicalWeight(v: number, u: WeightUnit): number {
  if (u === "TONNE") return v * 1000;
  if (u === "GM") return v / 1000;
  return v;
}

/** Convert from canonical kg to the chosen unit. */
export function fromCanonicalWeight(vKg: number, u: WeightUnit): number {
  if (u === "TONNE") return vKg / 1000;
  if (u === "GM") return vKg * 1000;
  return vKg;
}

/** Volume in m³ from a single package's canonical-cm dims (no ×qty). */
export function cbmFromCanonical(dimLcm: number, dimWcm: number, dimHcm: number): number {
  return (dimLcm * dimWcm * dimHcm) / 1e6;
}

export function cargoLabel(c: {
  poReference?: string | null;
  label?: string | null;
  productName?: string | null;
  rowIndex?: number;
}): string {
  const po = c.poReference?.trim();
  if (po) return po;
  const label = c.label?.trim();
  if (label) return label;
  const name = c.productName?.trim();
  if (name) return name;
  return `Row ${(c.rowIndex ?? 0) + 1}`;
}

// §7.3 reference tags (multi-badge).
export const ReferenceTag = {
  HEAVY: "HEAVY",
  FRAGILE: "FRAGILE",
  NON_STACKABLE: "NON_STACKABLE",
  OUT_OF_GAUGE: "OUT_OF_GAUGE",
  DG: "DG",
} as const;
export type ReferenceTag = (typeof ReferenceTag)[keyof typeof ReferenceTag];
export const REFERENCE_TAGS = Object.values(ReferenceTag) as [ReferenceTag, ...ReferenceTag[]];

const REFERENCE_TAG_LABELS: Record<ReferenceTag, string> = {
  HEAVY: "Heavy",
  FRAGILE: "Fragile",
  NON_STACKABLE: "Non Stackable",
  OUT_OF_GAUGE: "Out of Gauge Cargo",
  DG: "Dangerous Goods",
};
export function referenceTagLabel(tag: ReferenceTag): string {
  return REFERENCE_TAG_LABELS[tag] ?? tag.replace(/_/g, " ");
}

const PACKAGE_TYPE_LABELS: Record<PackageType, string> = {
  BOX: "Box", PALLET: "Pallet", CRATE: "Crate", CARTON: "Carton", DRUM: "Drum", BUNDLE: "Bundle",
};
export function packageTypeLabel(t: PackageType): string { return PACKAGE_TYPE_LABELS[t] ?? t; }

const UOM_LABELS: Record<UnitOfMeasure, string> = {
  PC: "pc", SET: "set", BOX: "box", KG: "kg", M: "m", ROLL: "roll",
};
export function uomLabel(u: UnitOfMeasure): string { return UOM_LABELS[u] ?? u; }

export function weightUnitLabel(u: WeightUnit): string {
  return u === "GM" ? "g" : u === "TONNE" ? "tonne" : "kg";
}

// A cargo grouping (§7.3, re-modelled Query→Cargo→Package→Item). Cargo itself now holds
// only the PO/label/unit grouping; Package carries dims/weights (§ packageCreateSchema),
// Item carries product/qty (§ itemCreateSchema).
export const cargoCreateSchema = z.object({
  poReference: z.string().trim().max(120).optional(),
  label: z.string().trim().max(160).optional(),
  dimUnit: z.enum(DIM_UNITS).default("CM"),
  weightUnit: z.enum(WEIGHT_UNITS).default("KG"),
});
export type CargoCreateInput = z.infer<typeof cargoCreateSchema>;
export const cargoUpdateSchema = cargoCreateSchema.partial();
export type CargoUpdateInput = z.infer<typeof cargoUpdateSchema>;

// Package dims/weights arrive in the CARGO's entry unit; the service converts to canonical.
export const packageCreateSchema = z
  .object({
    packageNo: z.string().trim().min(1).max(60),
    packageType: z.enum(PACKAGE_TYPES),
    dimL: z.number().positive().max(100000),
    dimW: z.number().positive().max(100000),
    dimH: z.number().positive().max(100000),
    grossWt: z.number().positive().max(1000000000),
    netWt: z.number().nonnegative().max(1000000000).optional(),
    tags: z.array(z.enum(REFERENCE_TAGS)).optional(),
  })
  .refine((p) => p.netWt === undefined || p.netWt <= p.grossWt, {
    message: "Net weight must be ≤ gross weight",
    path: ["netWt"], // V-2
  });
export type PackageCreateInput = z.infer<typeof packageCreateSchema>;

// Update: all fields optional; keep the Net ≤ Gross guard when both are present.
// `reason` (Stage 4, SB6 §7.2): justification for a mediated edit that lands on the
// change-order path (RfqDefining-or-heavier on a leg with live quotes). Metadata only — the
// service extracts it onto ChangeRequest.reason and MUST NOT let it reach the Prisma patch.
export const packageUpdateSchema = z
  .object({
    packageNo: z.string().trim().min(1).max(60),
    packageType: z.enum(PACKAGE_TYPES),
    dimL: z.number().positive().max(100000),
    dimW: z.number().positive().max(100000),
    dimH: z.number().positive().max(100000),
    grossWt: z.number().positive().max(1000000000),
    netWt: z.number().nonnegative().max(1000000000).nullable(),
    tags: z.array(z.enum(REFERENCE_TAGS)),
    reason: z.string().trim().min(1).max(500),
  })
  .partial()
  .refine((p) => p.netWt == null || p.grossWt == null || p.netWt <= p.grossWt, {
    message: "Net weight must be ≤ gross weight",
    path: ["netWt"],
  });
export type PackageUpdateInput = z.infer<typeof packageUpdateSchema>;

export const itemCreateSchema = z
  .object({
    product: z.string().trim().max(200).optional(),
    qty: z.number().positive().max(1000000000).optional(),
    uom: z.enum(UOMS).optional(),
    hsCode: z.string().trim().max(40).optional(),
    tags: z.array(z.enum(REFERENCE_TAGS)).optional(),
  })
  .refine((i) => i.qty === undefined || i.uom !== undefined, {
    message: "Unit of measure is required when a quantity is entered",
    path: ["uom"], // V-4
  });
export type ItemCreateInput = z.infer<typeof itemCreateSchema>;
// No cross-field `.refine()` here (Task 7 §A2), unlike itemCreateSchema above: this schema
// validates a PARTIAL patch, and a partial patch can't see the item's stored uom, so a refine
// checking "qty ⇒ uom" against the patch ALONE would false-reject `{qty:5}` even when the
// stored row already has a uom. V-4 is instead enforced in item.service.ts's `update` by
// merging patched-or-stored qty/uom and validating the effective pair (same merge-then-validate
// shape as package.service.ts's V-2 fix, §A1) — see item.service.ts and item.e2e-spec.ts.
export const itemUpdateSchema = z
  .object({
    product: z.string().trim().max(200).nullable(),
    qty: z.number().positive().max(1000000000).nullable(),
    uom: z.enum(UOMS).nullable(),
    hsCode: z.string().trim().max(40).nullable(),
    tags: z.array(z.enum(REFERENCE_TAGS)),
  })
  .partial();
export type ItemUpdateInput = z.infer<typeof itemUpdateSchema>;

export interface ItemDto {
  id: string;
  rowIndex: number;
  product: string | null;
  qty: string | null;
  uom: UnitOfMeasure | null;
  hsCode: string | null;
  tags: ReferenceTag[];
}
export interface PackageDto {
  id: string;
  rowIndex: number;
  packageNo: string;
  packageType: PackageType;
  dimL: string;
  dimW: string;
  dimH: string; // canonical cm (Decimal → string)
  grossWt: string;
  netWt: string | null; // canonical kg
  volumeCbm: string | null; // m³
  tags: ReferenceTag[]; // own tags
  effectiveTags: ReferenceTag[]; // own ∪ item tags (derived)
  msdsFileId: string | null;
  items: ItemDto[];
}
export interface CargoDto {
  id: string;
  rowIndex: number;
  poReference: string | null;
  label: string | null;
  dimUnit: DimUnit;
  weightUnit: WeightUnit;
  packages: PackageDto[];
  // derived header (H4–H8) — computed by the service, never stored
  packageCount: number;
  grossWeightKg: string;
  volumeCbm: string;
  tags: ReferenceTag[];
  chargeableWeight: null;
}

/** BL-3: a package's effective tags = its own tags ∪ every item's tags, deduped, order-stable. */
export function effectiveTags(pkg: { tags: ReferenceTag[]; items: { tags: ReferenceTag[] }[] }): ReferenceTag[] {
  const seen = new Set<ReferenceTag>();
  const out: ReferenceTag[] = [];
  for (const t of [...pkg.tags, ...pkg.items.flatMap((i) => i.tags)]) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
