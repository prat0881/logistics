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

// `tagKey` is `ReferenceTag | null` here, stricter than the schema field below (`.nullish()`,
// which also admits `undefined`). A caller wiring this to parsed schema output — e.g. a future
// catalogue service passing `parsed.tagKey` straight through — will need an explicit `?? null`
// at the boundary; nothing here does that conversion for you.
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
  label: z.string().min(1).max(120)
    .regex(/[A-Za-z0-9]/, "Label must contain at least one letter or number"),
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

/**
 * Category and isAdditional are set on create and immutable afterwards — see design doc D18.
 * `.strict()` is required, not cosmetic: Zod's default `.object()` mode is "strip", which
 * silently drops unrecognized keys (including `category`) rather than failing validation. A
 * `.strict()`-less schema would let a PATCH carrying `category` return 200 with the field
 * quietly ignored — passing the update through unchanged, not rejecting it. `.strict()` makes
 * an unrecognized key a validation error, which ZodValidationPipe turns into a 400.
 */
export const chargeLineUpdateSchema = baseChargeLine
  .pick({ label: true, sortOrder: true, isActive: true, inputType: true })
  .partial()
  .strict();

export type ChargeLineCreateInput = z.input<typeof chargeLineCreateSchema>;
export type ChargeLineUpdateInput = z.input<typeof chargeLineUpdateSchema>;

export interface ChargeLineDefinitionAdminDto {
  id: string;
  key: string;
  mode: FreightMode;
  variant: ChargeVariant;
  // Nullable: ROAD_WH_HANDLING has no category while warehousing is deferred (see
  // ChargeLineDefinition.category in schema.prisma, which is @db-nullable for the same reason).
  // Admin consumers should filter rows with a null category out of any category-keyed view.
  category: ChargeCategory | null;
  label: string;
  isAdditional: boolean;
  tagKey: ReferenceTag | null;
  inputType: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * `SEA_DEST_WHARFAGE` from ("SEA", "DESTINATION", "Wharfage Charges"). Truncation happens BEFORE
 * the boundary-underscore strip, not after: stripping first and then slicing to 40 chars can
 * reintroduce a trailing `_` if the cut lands on a collapsed separator (e.g. a run of spaces at
 * position 40). Slicing first means the strip always sees — and cleans — the final string.
 */
export function chargeLineKey(mode: FreightMode, category: ChargeCategory, label: string): string {
  const cat = { ORIGIN: "ORIGIN", FREIGHT: "FREIGHT", DESTINATION: "DEST", ADDITIONAL: "ADD" }[category];
  const slug = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40).replace(/^_|_$/g, "");
  return `${mode}_${cat}_${slug}`;
}
