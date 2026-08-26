import { z } from "zod";
import { FREIGHT_MODES, type FreightMode } from "../config";
import { REFERENCE_TAGS, type ReferenceTag } from "../cargo";

export const CHARGE_CATEGORIES = ["ORIGIN", "FREIGHT", "DESTINATION", "ADDITIONAL"] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

export const CHARGE_VARIANTS = [
  "DEDICATED", "GROUPAGE", "DIRECT", "INDIRECT", "FCL", "LCL", "BOTH",
] as const;
export type ChargeVariant = (typeof CHARGE_VARIANTS)[number];

const VARIANTS_BY_MODE: Record<FreightMode, ChargeVariant[]> = {
  ROAD: ["DEDICATED", "GROUPAGE", "BOTH"],
  AIR: ["DIRECT", "INDIRECT", "BOTH"],
  SEA: ["FCL", "LCL", "BOTH"],
};

const CATEGORIES_BY_MODE: Record<FreightMode, ChargeCategory[]> = {
  // Road has no origin or destination leg of its own — the seed matrix marks both N/A.
  ROAD: ["FREIGHT", "ADDITIONAL"],
  AIR: ["ORIGIN", "FREIGHT", "DESTINATION", "ADDITIONAL"],
  SEA: ["ORIGIN", "FREIGHT", "DESTINATION", "ADDITIONAL"],
};

// Named chargeVariantsForMode, not variantsForMode: packages/shared/src/quote.ts already exports
// variantsForMode(mode: FreightMode | null): (ChargeRateVariant | null)[] — the FREIGHT-RATE
// matrix columns (QuoteDraft.trucking/seaRates: Road → Dedicated/Groupage, Sea → FCL/LCL, Air →
// [null]). That function is consumed by quote-engine.ts, a file this build must not touch. This
// one is a different concept — the charge-catalogue's variant scope, including the "BOTH" value
// quote.ts's variant never takes — but has the same shape of name. Both are re-exported through
// the same packages/shared barrel (index.ts does `export * from "./quote"` and
// `export * from "./masters/index"`), so reusing the name would be a genuine ambiguous-export
// build break, not just a style clash.
export const chargeVariantsForMode = (mode: FreightMode): ChargeVariant[] => VARIANTS_BY_MODE[mode];
export const categoriesForMode = (mode: FreightMode): ChargeCategory[] => CATEGORIES_BY_MODE[mode];

/**
 * Phase 1 of the parallel change: `category` and `isAdditional` are what the admin edits,
 * `zone` and `role` are what resolveChargeConfig still reads. These two functions are the only
 * place the old columns are computed — the seed and the catalogue service both call them, so
 * the two representations cannot drift. Retired in the Stage-4 pass; see design doc §2.2.
 */
export function deriveZone(
  category: ChargeCategory,
  mode: FreightMode,
): "ORIGIN" | "MAIN_FREIGHT" | "DESTINATION" | null {
  // Road has no zoned legs — every existing Road definition stores zone = null, and that must
  // stay true, because ChargeLine.zone is frozen at distribute.
  if (mode === "ROAD") return null;
  switch (category) {
    case "ORIGIN": return "ORIGIN";
    case "FREIGHT": return "MAIN_FREIGHT";
    case "DESTINATION": return "DESTINATION";
    case "ADDITIONAL": return null;
  }
}

export function deriveRole(
  isAdditional: boolean,
  tagKey: ReferenceTag | null,
): "CORE" | "STANDARD" | "TAG_DRIVEN" {
  if (!isAdditional) return "CORE";
  return tagKey ? "TAG_DRIVEN" : "STANDARD";
}

const baseChargeLine = z.object({
  mode: z.enum(FREIGHT_MODES),
  variant: z.enum(CHARGE_VARIANTS),
  category: z.enum(CHARGE_CATEGORIES),
  label: z.string().min(1).max(120),
  isAdditional: z.boolean(),
  tagKey: z.enum(REFERENCE_TAGS).nullish(),
  inputType: z.enum(["PLAIN", "TRUCKING", "WAREHOUSE_STAGING", "HEAVY_WEIGHT_CALC"]).default("PLAIN"),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().default(true),
});

export const chargeLineCreateSchema = baseChargeLine.superRefine((v, ctx) => {
  if (!chargeVariantsForMode(v.mode).includes(v.variant)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["variant"],
      message: `${v.variant} is not a ${v.mode} variant`,
    });
  }
  if (!categoriesForMode(v.mode).includes(v.category)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: `${v.mode} charges have no ${v.category} category`,
    });
  }
  if (v.tagKey && !v.isAdditional) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tagKey"],
      message: "Only additional charges can be tag-driven",
    });
  }
});

/** Category and isAdditional are set on create and immutable afterwards — see design doc D18. */
export const chargeLineUpdateSchema = baseChargeLine
  .pick({ label: true, sortOrder: true, isActive: true, inputType: true })
  .partial();

export type ChargeLineCreateInput = z.input<typeof chargeLineCreateSchema>;
export type ChargeLineUpdateInput = z.input<typeof chargeLineUpdateSchema>;

export interface ChargeLineDefinitionAdminDto {
  id: string;
  key: string;
  mode: FreightMode;
  variant: ChargeVariant;
  category: ChargeCategory;
  label: string;
  isAdditional: boolean;
  tagKey: ReferenceTag | null;
  inputType: string;
  sortOrder: number;
  isActive: boolean;
}

/** `SEA_DEST_WHARFAGE` from ("SEA", "DESTINATION", "Wharfage Charges"). */
export function chargeLineKey(mode: FreightMode, category: ChargeCategory, label: string): string {
  const cat = { ORIGIN: "ORIGIN", FREIGHT: "FREIGHT", DESTINATION: "DEST", ADDITIONAL: "ADD" }[category];
  const slug = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  return `${mode}_${cat}_${slug}`;
}
