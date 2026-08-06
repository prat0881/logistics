import { WarehousePosition, type QuoteDraft } from "./quote";
import type { Finding } from "./findings";
import type { FreightMode } from "./config";
import type { ResolvedChargeLine } from "./charge-config";

/** Heavy-Weight excess amount = max(0, pieceWeightKg − airlineLimitKg) × ratePerExcessKg. */
export function computeHeavyWeightAmount(pieceWeightKg: number, airlineLimitKg: number, ratePerExcessKg: number): number {
  return Math.max(0, pieceWeightKg - airlineLimitKg) * ratePerExcessKg;
}

export interface QuoteVariantTotal { key: string; rateAmount: number | null; grandTotal: number; }
export interface QuoteTotals {
  variants: QuoteVariantTotal[];
  sharedSubtotal: number;
  chargeableWeightKg: number;
}

/**
 * One grand total per rate variant (design §7): Road/Sea are dual-rate (Dedicated/Groupage,
 * FCL/LCL) — each filled rate yields its own grand total over the shared subtotal (Air/Sea
 * zone charges + warehouse). Air is single-variant.
 */
export function computeQuoteTotals(draft: QuoteDraft): QuoteTotals {
  const chargesSum = draft.charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const warehouseSum = draft.warehouse.reduce((s, w) => s + (w.amount ?? 0), 0);
  const sharedSubtotal = chargesSum + warehouseSum;
  const chargeableWeightKg = draft.cargo.reduce((s, c) => s + (c.chargedWeightKg ?? 0), 0);

  const variants: QuoteVariantTotal[] = [];
  if (draft.mode === "ROAD") {
    const byVariant = new Map<string, number>();
    for (const t of draft.trucking)
      byVariant.set(t.rateVariant, (byVariant.get(t.rateVariant) ?? 0) + (t.amount ?? 0));
    for (const [key, rateAmount] of byVariant)
      variants.push({ key, rateAmount, grandTotal: rateAmount + sharedSubtotal });
  } else if (draft.mode === "SEA") {
    for (const r of draft.seaRates)
      variants.push({ key: r.rateVariant, rateAmount: r.amount, grandTotal: (r.amount ?? 0) + sharedSubtotal });
  } else {
    variants.push({ key: "AIR", rateAmount: null, grandTotal: sharedSubtotal });
  }
  return { variants, sharedSubtotal, chargeableWeightKg };
}

/** Submit-gate v2 (design §7): 6 blocking rules gating FF portal submission. */
export function validateQuote(
  draft: QuoteDraft, deadlineIso: string, nowIso: string, activeLines: ResolvedChargeLine[] = [],
): Finding[] {
  const f: Finding[] = [];
  const blk = (rule: string, message: string, scope: Finding["scope"]): Finding => ({ rule, severity: "blocking", scope, message });
  const leg = { type: "leg", id: draft.legId } as const;

  // (6) submission before the deadline
  if (new Date(nowIso).getTime() > new Date(deadlineIso).getTime())
    f.push(blk("Q_DEADLINE", "The submission deadline has passed", leg));

  // (1) currency + validity (validity ≥ deadline)
  if (!draft.currency) f.push(blk("Q_CURRENCY", "Currency is required", { type: "field", id: "currency" }));
  if (!draft.quoteValidityUntil) f.push(blk("Q_VALIDITY", "Quote Validity Until is required", { type: "field", id: "quoteValidityUntil" }));
  else if (new Date(draft.quoteValidityUntil).getTime() < new Date(deadlineIso).getTime())
    f.push(blk("Q_VALIDITY", "Quote Validity Until must be on or after the submission deadline", { type: "field", id: "quoteValidityUntil" }));

  // (2) every active charge line priced — amount present; 0 allowed ONLY with a remark
  const byKey = new Map(draft.charges.filter((c) => c.definitionKey).map((c) => [c.definitionKey!, c]));
  for (const line of activeLines) {
    if (line.inputType === "HEAVY_WEIGHT_CALC") {
      const c = byKey.get(line.definitionKey);
      if (!c || c.pieceWeightKg == null || c.airlineLimitKg == null || c.ratePerExcessKg == null)
        f.push(blk("Q_PRICED", `Heavy-Weight inputs are required for "${line.label}"`, leg));
      continue;
    }
    if (line.inputType !== "PLAIN") continue;
    const c = byKey.get(line.definitionKey);
    if (!c || c.amount == null) f.push(blk("Q_PRICED", `Charge line "${line.label}" must be priced`, leg));
    else if (c.amount === 0 && !c.note?.trim())
      f.push(blk("Q_PRICED", `A remark is required to quote "${line.label}" at 0`, leg));
  }

  // (3) remark mandatory on every custom [+ Add Charge] line
  for (const c of draft.charges)
    if (!c.definitionKey && !c.presetKey && !c.note?.trim())
      f.push(blk("Q_CUSTOM_REMARK", `A remark is required on the custom charge "${c.label}"`, leg));

  // (4) Guaranteed Transit Time present on every leg
  if (draft.transit?.guaranteedTransitDays == null)
    f.push(blk("Q_TRANSIT", "Guaranteed Transit Time is required", { type: "field", id: "guaranteedTransitDays" }));

  // (5) dual-rate — ≥1 of the two rates filled (each filled rate yields its own grand total)
  if (draft.mode === "ROAD" && !draft.trucking.some((t) => t.amount != null))
    f.push(blk("Q_RATE", "Enter at least one trucking rate (Dedicated or Groupage)", leg));
  if (draft.mode === "SEA" && !draft.seaRates.some((r) => r.amount != null))
    f.push(blk("Q_RATE", "Enter at least one sea freight rate (FCL or LCL)", leg));

  // warehouse: every included warehouse line priced
  for (const w of draft.warehouse)
    if (w.amount == null) f.push(blk("Q_PRICED", `Warehousing must be priced for ${w.label}`, leg));

  return f;
}

export interface WhLeg { originPointId: string | null; destinationPointId: string | null; mode: FreightMode | null; }

/** Order the leg edges into a single point sequence (source→sink); returns [] if no orderable chain. */
function orderPointSequence(legs: WhLeg[]): string[] {
  const edges = legs.filter((l): l is WhLeg & { originPointId: string; destinationPointId: string } =>
    !!l.originPointId && !!l.destinationPointId);
  if (edges.length === 0) return [];
  const next = new Map<string, string>();
  const indeg = new Map<string, number>();
  const nodes = new Set<string>();
  for (const e of edges) {
    next.set(e.originPointId, e.destinationPointId);
    indeg.set(e.destinationPointId, (indeg.get(e.destinationPointId) ?? 0) + 1);
    nodes.add(e.originPointId); nodes.add(e.destinationPointId);
  }
  const source = [...nodes].find((n) => (indeg.get(n) ?? 0) === 0);
  if (!source) return []; // cyclic / non-orderable
  const seq: string[] = [source];
  const seen = new Set<string>([source]);
  let cur = source;
  while (next.has(cur)) {
    const nxt = next.get(cur)!;
    if (seen.has(nxt)) break;
    seq.push(nxt); seen.add(nxt); cur = nxt;
  }
  return seq;
}

export function classifyWarehousePositions(legs: WhLeg[], warehousePointIds: string[]): Record<string, WarehousePosition> {
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
