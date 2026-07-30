import { z } from "zod";

export const DimUnit = { CM: "CM", MM: "MM" } as const;
export type DimUnit = (typeof DimUnit)[keyof typeof DimUnit];
export const DIM_UNITS = Object.values(DimUnit) as [DimUnit, ...DimUnit[]];

export const WeightUnit = { KG: "KG", GM: "GM" } as const;
export type WeightUnit = (typeof WeightUnit)[keyof typeof WeightUnit];
export const WEIGHT_UNITS = Object.values(WeightUnit) as [WeightUnit, ...WeightUnit[]];

/** Volume in cubic metres from dims in the chosen unit. cm³/1e6 = m³; mm³/1e9 = m³. */
export function cbmFromDims(dimL: number, dimW: number, dimH: number, qty: number, dimUnit: DimUnit): number {
  const div = dimUnit === "MM" ? 1e9 : 1e6;
  return (dimL * dimW * dimH * qty) / div;
}

/** Normalize a weight in the chosen unit to kilograms. */
export function toKg(weight: number, weightUnit: WeightUnit): number {
  return weightUnit === "GM" ? weight / 1000 : weight;
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
} as const;
export type ReferenceTag = (typeof ReferenceTag)[keyof typeof ReferenceTag];
export const REFERENCE_TAGS = Object.values(ReferenceTag) as [ReferenceTag, ...ReferenceTag[]];

const REFERENCE_TAG_LABELS: Record<ReferenceTag, string> = {
  HEAVY: "Heavy",
  FRAGILE: "Fragile",
  NON_STACKABLE: "Non Stackable",
  OUT_OF_GAUGE: "Out of Gauge Cargo",
};
export function referenceTagLabel(tag: ReferenceTag): string {
  return REFERENCE_TAG_LABELS[tag] ?? tag.replace(/_/g, " ");
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
export const cargoUpdateSchema = z
  .object({
    poReference: z.string().trim().max(120).nullable(),
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
