import { z } from "zod";

// §7.3 reference tags (multi-badge).
export const ReferenceTag = {
  HEAVY: "HEAVY",
  FRAGILE: "FRAGILE",
  NON_STACKABLE: "NON_STACKABLE",
} as const;
export type ReferenceTag = (typeof ReferenceTag)[keyof typeof ReferenceTag];
export const REFERENCE_TAGS = Object.values(ReferenceTag) as [ReferenceTag, ...ReferenceTag[]];

// A cargo row (§7.3). Core fields required (a row is atomic data entry + volumeCbm
// is a generated column needing non-null dims/qty). freightDensity/chargeableWeight
// are Stage-4 (never sent here); volumeCbm is DB-generated (never sent here).
export const cargoCreateSchema = z
  .object({
    poReference: z.string().min(1).max(120),
    productName: z.string().min(1).max(200),
    referenceTags: z.array(z.enum(REFERENCE_TAGS)).optional(),
    hsCode: z.string().max(40).optional(),
    packageType: z.string().min(1).max(60),
    isDangerous: z.boolean().optional(),
    qty: z.number().int().positive().max(1000000), // F5: qty > 0
    dimL: z.number().positive().max(100000),
    dimW: z.number().positive().max(100000),
    dimH: z.number().positive().max(100000),
    netWt: z.number().nonnegative().max(1000000000).optional(),
    grossWt: z.number().positive().max(1000000000), // F5: gross present
  })
  .refine((c) => c.netWt === undefined || c.netWt <= c.grossWt, {
    message: "Net weight must be ≤ gross weight",
    path: ["netWt"],
  });
export type CargoCreateInput = z.infer<typeof cargoCreateSchema>;

// Update: all fields optional; keep the Net ≤ Gross guard when both are present.
export const cargoUpdateSchema = z
  .object({
    poReference: z.string().min(1).max(120),
    productName: z.string().min(1).max(200),
    referenceTags: z.array(z.enum(REFERENCE_TAGS)),
    hsCode: z.string().max(40).nullable(),
    packageType: z.string().min(1).max(60),
    isDangerous: z.boolean(),
    qty: z.number().int().positive().max(1000000),
    dimL: z.number().positive().max(100000),
    dimW: z.number().positive().max(100000),
    dimH: z.number().positive().max(100000),
    netWt: z.number().nonnegative().max(1000000000).nullable(),
    grossWt: z.number().positive().max(1000000000),
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
  freightDensity: string | null; // null in Stage 3
  chargeableWeight: string | null; // null in Stage 3
}
