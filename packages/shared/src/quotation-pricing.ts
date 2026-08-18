import type { ChargeGroupKey, QuotationCostGroup, QuotationCostLine } from "./quotation-charges";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** round2(cost × (1 + m/100)) — markup ON COST, never `cost / (1 - m/100)` (margin-on-sell).
 *  20% on a $100 cost is $120.00, not $125.00; the two formulas diverge further as m grows. */
export function clientAmount(costUsd: number, marginPct: number): number {
  return round2(costUsd * (1 + marginPct / 100));
}

export interface PricedLine extends QuotationCostLine {
  clientUsd: number;
  /** True iff `${legId}:${line.id}` is a key in the overrides record — determined by KEY
   *  PRESENCE, never by comparing clientUsd to the computed markup. A user who types the same
   *  number the formula would have produced has still pinned the line. */
  overridden: boolean;
}

export interface PricedGroup {
  group: ChargeGroupKey;
  label: string;
  lines: PricedLine[];
  costUsd: number;
  clientUsd: number;
}

export interface PricedLeg {
  legId: string;
  legCode: string;
  forwarderName: string;
  variantLabel: string | null;
  groups: PricedGroup[];
  costUsd: number;
  clientUsd: number;
}

export interface PricedQuotation {
  legs: PricedLeg[];
  costTotalUsd: number;
  clientTotalUsd: number;
  /** round2(clientTotalUsd − costTotalUsd) — a derived display figure, never an input. */
  marginValueUsd: number;
}

/**
 * Applies `marginPct` to every cost line and rolls the result up into group/leg/grand totals.
 *
 * Overrides are absolute client-USD amounts (not deltas, not percentages), keyed by
 * `${legId}:${lineId}` — a line id is only unique WITHIN a leg, so the leg id must be part of the
 * key or one leg's override silently bleeds onto another leg's line with the same id. A key that
 * matches no line (e.g. a stale key from a re-frozen award) is ignored, not an error.
 *
 * Every total is the re-rounded SUM OF ALREADY-ROUNDED CHILDREN — group from its lines, leg from
 * its groups, grand total from its legs — never `cost × (1 + m)` recomputed directly on a rolled-up
 * figure, which would silently drop any override from the total.
 */
export function priceQuotation(
  legs: {
    legId: string;
    legCode: string;
    forwarderName: string;
    variantLabel: string | null;
    groups: QuotationCostGroup[];
  }[],
  marginPct: number,
  overrides: Record<string, number>,
): PricedQuotation {
  const pricedLegs: PricedLeg[] = legs.map((leg) => {
    const pricedGroups: PricedGroup[] = leg.groups.map((group) => {
      const pricedLines: PricedLine[] = group.lines.map((line) => {
        const key = `${leg.legId}:${line.id}`;
        const overridden = key in overrides;
        return {
          ...line,
          clientUsd: overridden ? overrides[key] : clientAmount(line.costUsd, marginPct),
          overridden,
        };
      });
      return {
        group: group.group,
        label: group.label,
        lines: pricedLines,
        costUsd: round2(pricedLines.reduce((sum, l) => sum + l.costUsd, 0)),
        clientUsd: round2(pricedLines.reduce((sum, l) => sum + l.clientUsd, 0)),
      };
    });
    return {
      legId: leg.legId,
      legCode: leg.legCode,
      forwarderName: leg.forwarderName,
      variantLabel: leg.variantLabel,
      groups: pricedGroups,
      costUsd: round2(pricedGroups.reduce((sum, g) => sum + g.costUsd, 0)),
      clientUsd: round2(pricedGroups.reduce((sum, g) => sum + g.clientUsd, 0)),
    };
  });

  const costTotalUsd = round2(pricedLegs.reduce((sum, l) => sum + l.costUsd, 0));
  const clientTotalUsd = round2(pricedLegs.reduce((sum, l) => sum + l.clientUsd, 0));

  return {
    legs: pricedLegs,
    costTotalUsd,
    clientTotalUsd,
    marginValueUsd: round2(clientTotalUsd - costTotalUsd),
  };
}
