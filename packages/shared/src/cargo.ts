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

export function cargoLabel(c: { poReference?: string | null; productName?: string | null; rowIndex?: number }): string {
  const po = c.poReference?.trim();
  if (po) return po;
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

// A cargo row (§7.3). Core fields required (a row is atomic data entry + volumeCbm
// is a generated column needing non-null dims/qty). volumeCbm is DB-generated (never written by the app).
export const cargoCreateSchema = z
  .object({
    poReference: z.string().trim().max(120).optional(),
    productName: z.string().trim().min(1).max(200),
    referenceTags: z.array(z.enum(REFERENCE_TAGS)).optional(),
    hsCode: z.string().max(40).optional(),
    packageType: z.string().trim().min(1).max(60),
    isDangerous: z.boolean().optional(),
    qty: z.number().int().positive().max(1000000), // F5: qty > 0
    dimL: z.number().positive().max(100000),
    dimW: z.number().positive().max(100000),
    dimH: z.number().positive().max(100000),
    netWt: z.number().nonnegative().max(1000000000).optional(),
    grossWt: z.number().positive().max(1000000000), // F5: gross present
    dimUnit: z.enum(DIM_UNITS).default("CM"),
    weightUnit: z.enum(WEIGHT_UNITS).default("KG"),
  })
  .refine((c) => c.netWt === undefined || c.netWt <= c.grossWt, {
    message: "Net weight must be ≤ gross weight",
    path: ["netWt"],
  });
export type CargoCreateInput = z.infer<typeof cargoCreateSchema>;

// Update: all fields optional; keep the Net ≤ Gross guard when both are present.
// `reason` (Stage 4, SB6 §7.2): justification for a mediated edit that lands on the
// change-order path (RfqDefining-or-heavier on a leg with live quotes). Metadata only — the
// service extracts it onto ChangeRequest.reason and MUST NOT let it reach the Prisma patch.
export const cargoUpdateSchema = z
  .object({
    poReference: z.string().trim().max(120),
    productName: z.string().trim().min(1).max(200),
    referenceTags: z.array(z.enum(REFERENCE_TAGS)),
    hsCode: z.string().max(40).nullable(),
    packageType: z.string().trim().min(1).max(60),
    isDangerous: z.boolean(),
    qty: z.number().int().positive().max(1000000),
    dimL: z.number().positive().max(100000),
    dimW: z.number().positive().max(100000),
    dimH: z.number().positive().max(100000),
    netWt: z.number().nonnegative().max(1000000000).nullable(),
    grossWt: z.number().positive().max(1000000000),
    dimUnit: z.enum(DIM_UNITS),
    weightUnit: z.enum(WEIGHT_UNITS),
    reason: z.string().trim().min(1).max(500),
  })
  .partial()
  .refine((c) => c.netWt == null || c.grossWt == null || c.netWt <= c.grossWt, {
    message: "Net weight must be ≤ gross weight",
    path: ["netWt"],
  });
export type CargoUpdateInput = z.infer<typeof cargoUpdateSchema>;

export interface CargoDto {
  id: string;
  rowIndex: number;
  poReference: string;
  productName: string;
  referenceTags: ReferenceTag[];
  hsCode: string | null;
  packageType: string;
  isDangerous: boolean;
  msdsFileId: string | null;
  qty: number;
  dimL: string;
  dimW: string;
  dimH: string;
  netWt: string | null;
  grossWt: string;
  volumeCbm: string | null; // Prisma Decimal serialises to string
  dimUnit: DimUnit;
  weightUnit: WeightUnit;
}
