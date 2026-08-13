import {
  WarehousePosition,
  variantsForMode,
  variantsForTransit,
  rateVariantLabel,
  AIR_VARIANT_KEY,
  type QuoteDraft,
  type QuoteDraftCharge,
  type QuoteDraftTransit,
  type ChargeRateVariant,
  type TransitVariantKey,
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
  additionalChargeSum: number; // v4 (design D1/#4): Σ effectiveChargeAmount over the COMMON `draft.charges` — folded into EVERY variant's grandTotal equally, exposed separately so the UI can show an "Additional charges" subtotal distinct from freight/warehouse
  warehouseSum: number; // the shared warehouse total (renamed from v3's `sharedSubtotal`: now that charges are ALSO common, "shared" no longer picked out warehouse uniquely, so the field is named for exactly what it sums)
  chargeableWeightKg: number;
}

/** The freight-rate cell for variant `v` (design §3.1): Road ← the matching `trucking` row,
 *  Sea ← the matching `seaRates` row, Air ← always `null` (NOT `0` — Air has no separate rate
 *  cell; its freight is priced as the AIR_MAIN_FREIGHT charge line, folded into `additionalChargeSum`
 *  instead, same as every other common charge). Returning `null` (rather than `0`) for Air is
 *  load-bearing: isVariantPriced's `variantRate(draft, v) != null` check must be false for an
 *  untouched Air leg, or Air would always look "priced" via its (nonexistent) rate cell alone.
 *  Callers that want a number for arithmetic (computeQuoteTotals's grandTotal) still do
 *  `rateAmount ?? 0` at the call site — the `0` lives there, not in this function. */
function variantRate(draft: QuoteDraft, v: ChargeRateVariant | null): number | null {
  if (draft.mode === "ROAD") return draft.trucking.find((t) => t.rateVariant === v)?.amount ?? null;
  if (draft.mode === "SEA") return draft.seaRates.find((r) => r.rateVariant === v)?.amount ?? null;
  return null; // Air
}

/**
 * One grand total per rate-variant column (design §3.1/D1, v4 — partially reverses v3): each
 * variant's grandTotal = its own freight rate (`variantRate` — Road/Sea only; Air has none) +
 * `additionalChargeSum` (the COMMON `charges` total, identical across every column) +
 * `warehouseSum` (also common). Unlike v3, `charges` is never grouped/filtered by `rateVariant`
 * here — every charge folds into every variant equally, because v4 made `charges` common (one row
 * per definitionKey, `rateVariant: null`). Road/Sea always yield exactly the mode's two columns
 * (`variantsForMode`), regardless of which cells happen to be filled; Air yields its single
 * implicit column. Charge amounts run through `effectiveChargeAmount` so a HEAVY_WEIGHT_CALC
 * line's derived amount folds into the total the same way it folds into the persisted
 * `ChargeLine.amount` at submit (ff-portal.service.ts). `chargeableWeightKg` is the single
 * leg-level value (`QuoteDraft.chargedWeightKg`) — display only, never summed into any grand total.
 */
export function computeQuoteTotals(draft: QuoteDraft): QuoteTotals {
  const warehouseSum = draft.warehouse.reduce((s, w) => s + (w.amount ?? 0), 0);
  const additionalChargeSum = draft.charges.reduce((s, c) => s + effectiveChargeAmount(c), 0);
  const chargeableWeightKg = draft.chargedWeightKg ?? 0;

  const variants: QuoteVariantTotal[] = variantsForMode(draft.mode).map((v) => {
    const rateAmount = variantRate(draft, v);
    return {
      key: v ?? AIR_VARIANT_KEY,
      rateAmount,
      grandTotal: (rateAmount ?? 0) + additionalChargeSum + warehouseSum,
    };
  });

  return { variants, additionalChargeSum, warehouseSum, chargeableWeightKg };
}

// a charge cell counts as "priced" once it carries a usable amount — a literal `amount`, or
// (for a HEAVY_WEIGHT_CALC line) all three calc inputs, matching effectiveChargeAmount's own
// notion of "computable". Partial calc inputs don't count (Q_PRICED below reports precisely
// which input is still missing).
function chargeCellPriced(c: QuoteDraftCharge): boolean {
  if (c.amount != null) return true;
  return c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null;
}

// Is variant `v` "priced" (v4 — partially reverses v3)? Road/Sea: purely its OWN freight rate.
// Charges no longer carry a rateVariant, so a charge cell can no longer establish which freight
// column is "in play" — the only remaining signal is the trucking/seaRates row itself. This is a
// NARROW, per-variant signal — it feeds requiredTransitKeys (Q_TRANSIT) below, where "untouched
// variant left alone" must stay literal: a Road/Sea variant with no rate of its own gets no GTT
// requirement either, regardless of whether the LEG as a whole has been started (see
// isLegStarted, which is the broader, submission-gating signal Q_RATE actually uses).
// Air (and a not-yet-resolved mode) has no freight-rate cell at all (variantRate is always null),
// so its single implicit column falls back to the v3 signal: has ANY common charge been entered.
function isVariantPriced(draft: QuoteDraft, v: ChargeRateVariant | null): boolean {
  if (draft.mode === "ROAD" || draft.mode === "SEA") return variantRate(draft, v) != null;
  return draft.charges.some(chargeCellPriced);
}

// Has the LEG been started at all (Q_RATE, and the common-charge gate's guard) — design §3.2.
// Round 4 REVERSES Round 3's Road-optional carve-out: the freight submit-gate is now REQUIRED for
// every mode — Air, Sea, AND Road — so this is simply `pricedVariants.length > 0` (isVariantPriced
// above), with no per-mode exception. Sea/Road: a variant only counts once it carries its OWN
// freight rate (seaRates/trucking); Air's only signal already IS a common charge. (Formerly: Road
// ALSO counted as started via any common charge alone, with no trucking rate anywhere — that
// carve-out is removed, so a Road leg now needs its own trucking rate to be "started," exactly
// like Sea needs its own seaRates rate.)
function isLegStarted(pricedVariants: (ChargeRateVariant | null)[]): boolean {
  return pricedVariants.length > 0;
}

// Guaranteed Transit Time at a resolved TransitVariantKey (Road: a real ChargeRateVariant; Sea:
// SEA_VARIANT_KEY; Air: AIR_VARIANT_KEY — see requiredTransitKeys, which resolves priced freight
// variants down to the key(s) this actually indexes).
function transitDaysAt(transit: QuoteDraftTransit | null, key: TransitVariantKey): number | null {
  return transit?.guaranteedTransitDaysByVariant[key] ?? null;
}

// Which `guaranteedTransitDaysByVariant` keys must be populated, given which freight variants are
// priced (design D2/D3, v4). Road checks GTT independently per PRICED variant only (an untouched
// variant is left alone, same as v3) — DEDICATED and GROUPAGE can commit to different transit
// times, keyed directly by their own ChargeRateVariant. Sea/Air collapse to their ONE common/
// single key (variantsForTransit) the moment ANYTHING is priced — never duplicated per freight
// variant (Sea's FCL+LCL both map to the same SEA_VARIANT_KEY, so pricing both still requires
// only one shared GTT, checked once).
function requiredTransitKeys(
  mode: FreightMode | null,
  pricedVariants: (ChargeRateVariant | null)[],
): TransitVariantKey[] {
  if (pricedVariants.length === 0) return [];
  if (mode === "ROAD") return pricedVariants.filter((v): v is ChargeRateVariant => v != null);
  return variantsForTransit(mode); // SEA → [SEA_VARIANT_KEY], AIR/unresolved → [AIR_VARIANT_KEY]
}

/** Submit-gate v4 (design §3.2; partially reverses v3) — Round 4 reverses Round 3's Road-optional
 *  carve-out (see isLegStarted): blocking rules gating FF portal submission. Every rule here
 *  guards a value that gets force-unwrapped (`!`) at materialize (ff-portal.service.ts) onto a
 *  NOT NULL column — Q_WEIGHT (Quote.chargedWeightKg) and Q_CUSTOM_AMOUNT (ChargeLine.amount for
 *  a custom line) close gaps the base currency/validity/deadline rules leave open.
 *
 *  v4 replaces v3's per-variant-column charge gate with a split one: charges are COMMON (gated
 *  ONCE, full stop — not per variant); freight is per-variant (Road trucking / Sea seaRates).
 *  Round 4 (this change): the freight submit-gate is REQUIRED for every mode — Air, Sea, AND
 *  Road — so "has the leg been started" (isLegStarted) is simply `pricedVariants.length > 0`
 *  (isVariantPriced/pricedVariants), with no per-mode exception. (Round 3 had let a Road leg start
 *  via a common charge alone, with no trucking rate anywhere — that carve-out is now removed.)
 *  Once the leg is started, the common-charge completeness gate (Q_PRICED) runs — same
 *  "progressive" philosophy as v3 (an entirely untouched leg isn't yet yelled at for every blank
 *  field), just keyed off the leg as a whole rather than off each column independently. Q_TRANSIT
 *  stays keyed to the NARROWER `pricedVariants` (not isLegStarted) via requiredTransitKeys (Road
 *  per priced variant, Sea/Air one common/single key) — an untouched Road/Sea variant (no rate of
 *  its own) still needs no GTT, even once the leg overall is started via the OTHER variant's own
 *  rate. Q_PAST_DATE and Q_PIECE_WEIGHT (design D3/D4) are unconditional — a wrong date or an
 *  over-limit piece weight is wrong regardless of how much of the rest of the leg is priced. */
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

  // currency + validity (validity ≥ deadline) — unchanged from v2/v3
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

  // ── v4: freight is per-variant (Road/Sea). pricedVariants is the NARROW, per-variant signal
  // (feeds Q_TRANSIT only, below); isLegStarted is the broader submission-gating signal — Round 4
  // makes it exactly `pricedVariants.length > 0` for every mode (Road's Round-3 carve-out, which
  // ALSO accepted a common charge alone with no trucking rate, is removed). ──
  const variants = variantsForMode(draft.mode);
  const pricedVariants = variants.filter((v) => isVariantPriced(draft, v));
  const legStarted = isLegStarted(pricedVariants);

  // Q_RATE: the leg can't be submitted with nothing priced at all — for Sea/Road this means no
  // variant has its own freight rate (a common charge alone doesn't count: freight is required for
  // every mode as of Round 4); for Air, no common charge at all.
  if (!legStarted)
    f.push(blk("Q_RATE", "Enter at least one rate or charge amount for this leg", leg));

  // Common charges: gated ONCE the leg has been started (legStarted), not per variant — every
  // applicable active line (PLAIN/HEAVY_WEIGHT_CALC) must be priced. An entirely untouched leg is
  // left alone here (same progressive philosophy v3 had per-column); Q_RATE above is the only
  // finding on a truly blank leg.
  if (legStarted) {
    for (const line of activeLines) {
      const c = draft.charges.find((x) => x.definitionKey === line.definitionKey);
      if (line.inputType === "HEAVY_WEIGHT_CALC") {
        if (!c || c.pieceWeightKg == null || c.airlineLimitKg == null || c.ratePerExcessKg == null)
          f.push(blk("Q_PRICED", `Heavy-Weight inputs are required for "${line.label}"`, leg));
        continue;
      }
      if (line.inputType !== "PLAIN") continue;
      if (!c || c.amount == null)
        f.push(blk("Q_PRICED", `Charge line "${line.label}" must be priced`, leg));
      else if (c.amount === 0 && !c.note?.trim())
        f.push(blk("Q_PRICED", `A remark is required to quote "${line.label}" at 0`, leg));
    }
  }

  // Guaranteed Transit Time: Road per priced variant, Sea ONE common value, Air single (see
  // requiredTransitKeys). Road's suffix distinguishes DEDICATED vs. GROUPAGE; Sea/Air have no
  // per-variant ambiguity to name, so no suffix.
  for (const key of requiredTransitKeys(draft.mode, pricedVariants)) {
    if (transitDaysAt(draft.transit, key) == null) {
      const suffix =
        draft.mode === "ROAD" ? ` (${rateVariantLabel(key as ChargeRateVariant)})` : "";
      f.push(
        blk("Q_TRANSIT", `Guaranteed Transit Time is required${suffix}`, {
          type: "field",
          id: "guaranteedTransitDays",
        }),
      );
    }
  }

  // remark + amount mandatory on every custom [+ Add Charge] line (its `amount` is
  // force-unwrapped at materialize — ff-portal.service.ts's chargeLine.createMany) — unchanged
  // from v2/v3; every charge is common now, so this simply runs over the whole array
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

  // warehouse: every included warehouse line priced — unchanged from v2/v3 (D4: shared, not per-variant)
  for (const w of draft.warehouse)
    if (w.amount == null) f.push(blk("Q_PRICED", `Warehousing must be priced for ${w.label}`, leg));

  // Q_PAST_DATE (design D3, NEW): any FF-entered datetime earlier than `nowIso` → a finding scoped
  // to that specific field so findingNav can route/focus it. Unconditional (not gated behind
  // pricedVariants) — a stale date is wrong regardless of how much of the rest of the leg is
  // priced, same reasoning as Q_VALIDITY above. Malformed/unparseable values are silently ignored
  // here (NaN comparisons are always false) — format validity isn't this rule's job.
  const nowMs = new Date(nowIso).getTime();
  const pastDateField = (value: string | null | undefined, id: string, label: string): void => {
    if (!value) return;
    const t = new Date(value).getTime();
    if (!Number.isNaN(t) && t < nowMs)
      f.push(blk("Q_PAST_DATE", `${label} cannot be in the past`, { type: "field", id }));
  };
  if (draft.transit) {
    pastDateField(draft.transit.departureDate, "departureDate", "Departure Date");
    pastDateField(draft.transit.arrivalDate, "arrivalDate", "Arrival Date");
    pastDateField(draft.transit.plannedPickupDate, "plannedPickupDate", "Planned Pickup Date"); // Road
    pastDateField(draft.transit.plannedDeparture, "plannedDeparture", "Planned Departure"); // Air
    pastDateField(draft.transit.plannedArrival, "plannedArrival", "Planned Arrival"); // Air
    pastDateField(draft.transit.etd, "etd", "ETD"); // Sea
    pastDateField(draft.transit.eta, "eta", "ETA"); // Sea
  }
  for (const w of draft.warehouse)
    pastDateField(
      w.cargoAcceptanceWindow,
      `cargoAcceptanceWindow:${w.warehousePointId}`,
      "Cargo Acceptance Window",
    );

  // Q_PIECE_WEIGHT (design D4, NEW): a HEAVY_WEIGHT_CALC charge's piece weight can't exceed the
  // leg's total manifested cargo gross weight (Σ draft.cargo[].grossWtKg) — a single piece heavier
  // than the entire shipment is a data-entry error, not a real Heavy-Weight surcharge. Scoped to
  // the specific charge (by definitionKey, falling back to its label) so findingNav can route it.
  const totalGrossWtKg = draft.cargo.reduce((s, c) => s + c.grossWtKg, 0);
  for (const c of draft.charges) {
    if (c.pieceWeightKg != null && c.pieceWeightKg > totalGrossWtKg) {
      f.push(
        blk(
          "Q_PIECE_WEIGHT",
          `Piece weight (${c.pieceWeightKg} kg) for "${c.label}" cannot exceed the cargo's total gross weight (${totalGrossWtKg} kg)`,
          { type: "field", id: `pieceWeightKg:${c.definitionKey ?? c.label}` },
        ),
      );
    }
  }

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
