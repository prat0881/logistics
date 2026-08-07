import {
  WarehousePosition,
  variantsForMode,
  rateVariantLabel,
  AIR_VARIANT_KEY,
  type QuoteDraft,
  type QuoteDraftCharge,
  type QuoteDraftTransit,
  type ChargeRateVariant,
} from "./quote";
import type { Finding } from "./findings";
import type { FreightMode } from "./config";
import type { ResolvedChargeLine } from "./charge-config";

/** Heavy-Weight excess amount = max(0, pieceWeightKg − airlineLimitKg) × ratePerExcessKg. */
export function computeHeavyWeightAmount(
  pieceWeightKg: number,
  airlineLimitKg: number,
  ratePerExcessKg: number,
): number {
  return Math.max(0, pieceWeightKg - airlineLimitKg) * ratePerExcessKg;
}

// effective amount of a charge line: HEAVY_WEIGHT_CALC lines derive their amount from
// the 3 inputs (their `amount` is null); all others use `amount ?? 0`. Exported so the web
// (ChargeZonePanel's zone subtotal) folds a calc line the SAME way the engine does — one source
// of truth, no drift between the live client total and the submitted grandTotal.
export function effectiveChargeAmount(c: QuoteDraftCharge): number {
  if (c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null)
    return computeHeavyWeightAmount(c.pieceWeightKg, c.airlineLimitKg, c.ratePerExcessKg);
  return c.amount ?? 0;
}

export interface QuoteVariantTotal {
  key: string;
  rateAmount: number | null;
  grandTotal: number;
}
export interface QuoteTotals {
  variants: QuoteVariantTotal[];
  sharedSubtotal: number; // v3: the shared warehouse total only — every other line is per-variant
  chargeableWeightKg: number;
}

/** The freight-rate cell for variant `v` (design §3.1): Road ← the matching `trucking` row,
 *  Sea ← the matching `seaRates` row, Air ← always `null` (NOT `0` — Air has no separate rate
 *  cell; its freight is priced as the AIR_MAIN_FREIGHT charge line, folded into that variant's
 *  charge-cell sum instead, both in computeQuoteTotals below and in isVariantPriced further
 *  down). Returning `null` (rather than `0`) for Air is load-bearing: isVariantPriced's
 *  `variantRate(draft, v) != null` check must be false for an untouched Air leg, or Air would
 *  always look "priced" via its (nonexistent) rate cell alone and silently defeat Q_RATE. Callers
 *  that want a number for arithmetic (computeQuoteTotals's grandTotal) still do `rateAmount ?? 0`
 *  at the call site — the `0` lives there, not in this function. */
function variantRate(draft: QuoteDraft, v: ChargeRateVariant | null): number | null {
  if (draft.mode === "ROAD") return draft.trucking.find((t) => t.rateVariant === v)?.amount ?? null;
  if (draft.mode === "SEA") return draft.seaRates.find((r) => r.rateVariant === v)?.amount ?? null;
  return null; // Air
}

/**
 * One grand total per rate-variant column (design §3.1/D1, v3): each variant is a full column —
 * its own charge cells (`charges` grouped by `rateVariant`) + its own freight rate
 * (`variantRate`) + the one shared warehouse total. Road/Sea always yield exactly the mode's two
 * columns (`variantsForMode`), regardless of which cells happen to be filled; Air yields its
 * single implicit column. Charge amounts run through `effectiveChargeAmount` so a
 * HEAVY_WEIGHT_CALC line's derived amount folds into the total the same way it folds into the
 * persisted `ChargeLine.amount` at submit (ff-portal.service.ts) — the live client total (web)
 * and the submitted grandTotal must agree regardless of whether the calc line ever gets a
 * literal `amount` written onto it. `chargeableWeightKg` is the single leg-level value
 * (`QuoteDraft.chargedWeightKg`) — display only, never summed into any grand total.
 */
export function computeQuoteTotals(draft: QuoteDraft): QuoteTotals {
  const warehouseSum = draft.warehouse.reduce((s, w) => s + (w.amount ?? 0), 0);
  const chargeableWeightKg = draft.chargedWeightKg ?? 0;

  const variants: QuoteVariantTotal[] = variantsForMode(draft.mode).map((v) => {
    const chargeSum = draft.charges
      .filter((c) => c.rateVariant === v)
      .reduce((s, c) => s + effectiveChargeAmount(c), 0);
    const rateAmount = variantRate(draft, v);
    return {
      key: v ?? "AIR",
      rateAmount,
      grandTotal: chargeSum + (rateAmount ?? 0) + warehouseSum,
    };
  });

  return { variants, sharedSubtotal: warehouseSum, chargeableWeightKg };
}

// a charge cell counts as "priced" once it carries a usable amount — a literal `amount`, or
// (for a HEAVY_WEIGHT_CALC line) all three calc inputs, matching effectiveChargeAmount's own
// notion of "computable". Partial calc inputs don't count (Q_PRICED below reports precisely
// which input is still missing).
function chargeCellPriced(c: QuoteDraftCharge): boolean {
  if (c.amount != null) return true;
  return c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null;
}

// has variant `v` had *anything* entered against it yet — its freight-rate cell or any charge
// cell? Gates both Q_RATE (leg-wide: has any variant been started at all) and which variants
// Q_PRICED/Q_TRANSIT hold to full completeness below (design §3.2: "for each priced variant").
function isVariantPriced(draft: QuoteDraft, v: ChargeRateVariant | null): boolean {
  if (variantRate(draft, v) != null) return true;
  return draft.charges.some((c) => c.rateVariant === v && chargeCellPriced(c));
}

// Guaranteed Transit Time for variant `v` (AIR_VARIANT_KEY stands in for Air's single implicit
// column — see quote.ts).
function transitDaysFor(
  transit: QuoteDraftTransit | null,
  v: ChargeRateVariant | null,
): number | null {
  return transit?.guaranteedTransitDaysByVariant[v ?? AIR_VARIANT_KEY] ?? null;
}

/** Submit-gate v3 (design §3.2): blocking rules gating FF portal submission. Every rule here
 *  guards a value that gets force-unwrapped (`!`) at materialize (ff-portal.service.ts) onto a
 *  NOT NULL column — Q_WEIGHT (Quote.chargedWeightKg) and Q_CUSTOM_AMOUNT (ChargeLine.amount for
 *  a custom line) close gaps the base currency/validity/deadline rules leave open. v3 replaces
 *  the v2 "shared charges + one dual-rate pick" gate with a per-variant-column one: Q_RATE only
 *  requires that submission isn't entirely empty; once a variant column has anything in it,
 *  Q_PRICED/Q_TRANSIT require it to be fully priced (every applicable active line + its
 *  transit-days) — untouched variant columns are left alone (a Road FF quoting only Dedicated
 *  need not also fill Groupage). */
export function validateQuote(
  draft: QuoteDraft,
  deadlineIso: string,
  nowIso: string,
  activeLines: ResolvedChargeLine[] = [],
): Finding[] {
  const f: Finding[] = [];
  const blk = (rule: string, message: string, scope: Finding["scope"]): Finding => ({
    rule,
    severity: "blocking",
    scope,
    message,
  });
  const leg = { type: "leg", id: draft.legId } as const;

  // submission before the deadline
  if (new Date(nowIso).getTime() > new Date(deadlineIso).getTime())
    f.push(blk("Q_DEADLINE", "The submission deadline has passed", leg));

  // currency + validity (validity ≥ deadline) — unchanged from v2
  if (!draft.currency)
    f.push(blk("Q_CURRENCY", "Currency is required", { type: "field", id: "currency" }));
  if (!draft.quoteValidityUntil)
    f.push(
      blk("Q_VALIDITY", "Quote Validity Until is required", {
        type: "field",
        id: "quoteValidityUntil",
      }),
    );
  else if (new Date(draft.quoteValidityUntil).getTime() < new Date(deadlineIso).getTime())
    f.push(
      blk("Q_VALIDITY", "Quote Validity Until must be on or after the submission deadline", {
        type: "field",
        id: "quoteValidityUntil",
      }),
    );

  // Q_WEIGHT: one leg-level Chargeable Weight (kg) — Quote.chargedWeightKg is NOT NULL (v3: was
  // per-package QuoteCargoLine.chargedWeightKg)
  if (draft.chargedWeightKg == null)
    f.push(
      blk("Q_WEIGHT", "Charged Weight (kg) is required", { type: "field", id: "chargedWeightKg" }),
    );

  const variants = variantsForMode(draft.mode);
  const pricedVariants = variants.filter((v) => isVariantPriced(draft, v));

  // Q_RATE: the leg can't be submitted with nothing priced in any column at all
  if (pricedVariants.length === 0)
    f.push(blk("Q_RATE", "Enter at least one rate or charge amount for this leg", leg));

  // every priced variant's column must be fully priced (Q_PRICED) and have its own transit-days
  // (Q_TRANSIT); an untouched column is left alone.
  for (const v of pricedVariants) {
    const suffix = v ? ` (${rateVariantLabel(v)})` : "";

    for (const line of activeLines) {
      const c = draft.charges.find(
        (x) => x.definitionKey === line.definitionKey && x.rateVariant === v,
      );
      if (line.inputType === "HEAVY_WEIGHT_CALC") {
        if (!c || c.pieceWeightKg == null || c.airlineLimitKg == null || c.ratePerExcessKg == null)
          f.push(
            blk("Q_PRICED", `Heavy-Weight inputs are required for "${line.label}"${suffix}`, leg),
          );
        continue;
      }
      if (line.inputType !== "PLAIN") continue;
      if (!c || c.amount == null)
        f.push(blk("Q_PRICED", `Charge line "${line.label}"${suffix} must be priced`, leg));
      else if (c.amount === 0 && !c.note?.trim())
        f.push(blk("Q_PRICED", `A remark is required to quote "${line.label}"${suffix} at 0`, leg));
    }

    if (transitDaysFor(draft.transit, v) == null)
      f.push(
        blk("Q_TRANSIT", `Guaranteed Transit Time is required${suffix}`, {
          type: "field",
          id: "guaranteedTransitDays",
        }),
      );
  }

  // remark + amount mandatory on every custom [+ Add Charge] line (its `amount` is
  // force-unwrapped at materialize — ff-portal.service.ts's chargeLine.createMany) — unchanged
  // from v2; applies regardless of which variant (or none) the custom line carries
  for (const c of draft.charges)
    if (!c.definitionKey && !c.presetKey) {
      if (!c.note?.trim())
        f.push(
          blk("Q_CUSTOM_REMARK", `A remark is required on the custom charge "${c.label}"`, leg),
        );
      if (c.amount == null)
        f.push(
          blk("Q_CUSTOM_AMOUNT", `An amount is required on the custom charge "${c.label}"`, leg),
        );
    }

  // warehouse: every included warehouse line priced — unchanged from v2 (D4: shared, not per-variant)
  for (const w of draft.warehouse)
    if (w.amount == null) f.push(blk("Q_PRICED", `Warehousing must be priced for ${w.label}`, leg));

  return f;
}

export interface WhLeg {
  originPointId: string | null;
  destinationPointId: string | null;
  mode: FreightMode | null;
}

/** Order the leg edges into a single point sequence (source→sink); returns [] if no orderable chain. */
function orderPointSequence(legs: WhLeg[]): string[] {
  const edges = legs.filter(
    (l): l is WhLeg & { originPointId: string; destinationPointId: string } =>
      !!l.originPointId && !!l.destinationPointId,
  );
  if (edges.length === 0) return [];
  const next = new Map<string, string>();
  const indeg = new Map<string, number>();
  const nodes = new Set<string>();
  for (const e of edges) {
    next.set(e.originPointId, e.destinationPointId);
    indeg.set(e.destinationPointId, (indeg.get(e.destinationPointId) ?? 0) + 1);
    nodes.add(e.originPointId);
    nodes.add(e.destinationPointId);
  }
  const source = [...nodes].find((n) => (indeg.get(n) ?? 0) === 0);
  if (!source) return []; // cyclic / non-orderable
  const seq: string[] = [source];
  const seen = new Set<string>([source]);
  let cur = source;
  while (next.has(cur)) {
    const nxt = next.get(cur)!;
    if (seen.has(nxt)) break;
    seq.push(nxt);
    seen.add(nxt);
    cur = nxt;
  }
  return seq;
}

export function classifyWarehousePositions(
  legs: WhLeg[],
  warehousePointIds: string[],
): Record<string, WarehousePosition> {
  const seq = orderPointSequence(legs);
  const idxOf = new Map(seq.map((p, i) => [p, i] as const));
  const mainLeg = legs.find((l) => l.mode === "AIR" || l.mode === "SEA");
  const pivot =
    mainLeg && mainLeg.originPointId != null && idxOf.has(mainLeg.originPointId)
      ? idxOf.get(mainLeg.originPointId)!
      : Math.floor(seq.length / 2);
  const out: Record<string, WarehousePosition> = {};
  for (const w of warehousePointIds) {
    const i = idxOf.get(w);
    out[w] = i != null && i < pivot ? WarehousePosition.ORIGIN : WarehousePosition.DESTINATION;
  }
  return out;
}
