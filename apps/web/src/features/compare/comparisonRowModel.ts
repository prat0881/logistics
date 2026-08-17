import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { formatDate } from "@/lib/dates";
import { fmtNative, fmtUsd } from "./money";

/**
 * The stable identity of one (FF × variant) column. NOT `quoteId` alone: one submitted Quote fans
 * out into one `OfferDto` per variant of the leg's mode (Road: Dedicated + Groupage; Sea: FCL +
 * LCL — see comparison.service.ts's `buildLeg`, which loops `variantsForMode` per quote), so two
 * columns on the same leg can legitimately share a `quoteId` and differ only by `variant`.
 * Moved here from `ComparisonGrid.tsx` (S5.7 T1) byte-for-byte — every existing importer keeps
 * resolving it via `ComparisonGrid`'s re-export.
 */
export function offerKey(quoteId: string, variant: string | null): string {
  return `${quoteId}::${variant ?? "AIR"}`;
}

/** The stale-price marker for a REQUOTED offer (design §14). One constant, because it labels the
 *  same offer in three places — this grid's Status-row badge, `ComparisonGridColumns`, and
 *  `MakerPanel`'s shortlist radio. Lives here (not `ComparisonGrid.tsx`) so `ComparisonGridColumns`
 *  can import it without a cycle back through `ComparisonGrid.tsx`; still re-exported from
 *  `ComparisonGrid.tsx` so existing importers (`MakerPanel`) keep resolving it unchanged. */
export const STALE_OFFER_LABEL = "Re-quote requested";

export interface OfferCell {
  key: string; // offerKey(quoteId, variant)
  offer: OfferDto;
  recommended: boolean; // false whenever locked
  stale: boolean; // quoteStatus === "REQUOTED"
}

export interface ForwarderGroup {
  freightForwarderId: string;
  freightForwarderName: string;
  cells: OfferCell[];
}

export interface ComparisonRowModel {
  groups: ForwarderGroup[];
  cells: OfferCell[]; // flat, same order as groups flattened
  recommendedKey: string | null;
}

/**
 * Builds the leg's (FF × variant) row model, grouped by forwarder in first-seen order (design
 * §12 — Dedicated/Groupage or FCL/LCL of the same FF read as a pair). `locked` suppresses the
 * recommendation entirely — once the client quote is generated the winning quote is `APPROVED`
 * and excluded from `offers`, so the live recommendation would re-rank the losers (S5.6 final
 * review M1). This must stay a hard `null`/`false`, not merely hidden downstream.
 */
export function buildComparisonRowModel(leg: LegComparisonDto, locked: boolean): ComparisonRowModel {
  const recKey =
    !locked && leg.recommendation
      ? offerKey(leg.recommendation.quoteId, leg.recommendation.variant)
      : null;

  const groups: ForwarderGroup[] = [];
  for (const offer of leg.offers) {
    const key = offerKey(offer.quoteId, offer.variant);
    const cell: OfferCell = {
      key,
      offer,
      recommended: recKey != null && key === recKey,
      stale: offer.quoteStatus === "REQUOTED",
    };
    const existing = groups.find((g) => g.freightForwarderId === offer.freightForwarderId);
    if (existing) existing.cells.push(cell);
    else
      groups.push({
        freightForwarderId: offer.freightForwarderId,
        freightForwarderName: offer.freightForwarderName,
        cells: [cell],
      });
  }
  return { groups, cells: groups.flatMap((g) => g.cells), recommendedKey: recKey };
}

export interface MetricDef {
  id: string;
  label: string;
  render(cell: OfferCell): string;
}

export const METRICS: MetricDef[] = [
  {
    id: "usdTotal",
    label: "Total (USD)",
    render: (c) => (c.offer.priced ? fmtUsd(c.offer.usdTotal) : "—"),
  },
  {
    id: "nativeTotal",
    label: "Total (native)",
    render: (c) => (c.offer.priced ? fmtNative(c.offer.nativeTotal, c.offer.currency) : "—"),
  },
  {
    id: "rate",
    label: "Rate (per USD)",
    render: (c) => (c.offer.unitsPerUsd == null ? "—" : c.offer.unitsPerUsd.toFixed(5)),
  },
  {
    id: "transit",
    label: "Transit",
    render: (c) => (c.offer.transitDays == null ? "—" : `${c.offer.transitDays} d`),
  },
  {
    id: "validUntil",
    label: "Valid until",
    render: (c) => (c.offer.validUntil ? formatDate(c.offer.validUntil) : "—"),
  },
];

/**
 * Per-metric `data-testid` suffix and cell class, shared by `ComparisonGridColumns` and
 * `ComparisonGridRows` (S5.7 T2) so the two orientations physically cannot drift on either — they
 * were untyped, per-file copies in `ComparisonGridColumns.tsx` alone until T2 lifted them here.
 * Keyed by `MetricDef["id"]` (not hand-listed) so a new `METRICS` entry can't compile against a
 * lookup map that forgot to grow with it.
 */
export const METRIC_TESTID: Record<MetricDef["id"], string> = {
  usdTotal: "offer-usd",
  nativeTotal: "offer-native",
  rate: "offer-rate",
  transit: "offer-transit",
  validUntil: "offer-valid",
};

export const METRIC_CELL_CLASS: Record<MetricDef["id"], string> = {
  usdTotal: "text-right font-mono tabular-nums",
  nativeTotal: "text-right font-mono tabular-nums",
  rate: "text-right font-mono tabular-nums text-muted-foreground",
  transit: "text-right text-muted-foreground",
  validUntil: "text-right text-muted-foreground",
};

/** The recommended row/column's tint (S5.7 item 2 — every cell, not just the header/label). Shared
 *  by both orientations for the same drift-proofing reason as the maps above. */
export const RECOMMENDED_TINT = "bg-emerald-500/10";
