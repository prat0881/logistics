import type { ReactNode } from "react";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { rateVariantLabel, variantsForMode } from "@svyft/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/dates";
import { ForwarderStatusBadge } from "@/features/rfq-workspace/statusBadges";
import { fmtNative, fmtUsd } from "./money";

export interface ComparisonGridProps {
  leg: LegComparisonDto;
  selectedOfferKey?: string;
  onSelectOffer?: (quoteId: string, variant: string | null) => void;
}

/**
 * The stable identity of one (FF × variant) column. NOT `quoteId` alone: one submitted Quote fans
 * out into one `OfferDto` per variant of the leg's mode (Road: Dedicated + Groupage; Sea: FCL +
 * LCL — see comparison.service.ts's `buildLeg`, which loops `variantsForMode` per quote), so two
 * columns on the same leg can legitimately share a `quoteId` and differ only by `variant`.
 * Exported so `CompareLegPanel` can compose the same key when tracking which offer is expanded.
 */
export function offerKey(quoteId: string, variant: string | null): string {
  return `${quoteId}::${variant ?? "AIR"}`;
}

interface ForwarderGroup {
  freightForwarderId: string;
  freightForwarderName: string;
  offers: OfferDto[];
}

/**
 * Groups the leg's flat `offers` array by forwarder, preserving first-seen order, so the header
 * can render one FF-name cell spanning its variant columns (design §12 — Dedicated/Groupage or
 * FCL/LCL of the same FF read as a pair). Each group's own offers are sorted into canonical
 * `variantsForMode` order rather than trusting array order, so the grid degrades gracefully even
 * if a future caller hands it offers in a different sequence.
 */
function groupByForwarder(leg: LegComparisonDto): ForwarderGroup[] {
  const order = variantsForMode(leg.mode);
  const rank = (v: OfferDto["variant"]) => {
    const i = order.indexOf(v);
    return i === -1 ? order.length : i;
  };

  const groups = new Map<string, ForwarderGroup>();
  const seenOrder: string[] = [];
  for (const offer of leg.offers) {
    let group = groups.get(offer.freightForwarderId);
    if (!group) {
      group = {
        freightForwarderId: offer.freightForwarderId,
        freightForwarderName: offer.freightForwarderName,
        offers: [],
      };
      groups.set(offer.freightForwarderId, group);
      seenOrder.push(offer.freightForwarderId);
    }
    group.offers.push(offer);
  }
  for (const group of groups.values()) {
    group.offers.sort((a, b) => rank(a.variant) - rank(b.variant));
  }
  return seenOrder.map((id) => groups.get(id)!);
}

function isRecommended(leg: LegComparisonDto, offer: OfferDto): boolean {
  return (
    leg.recommendation != null &&
    leg.recommendation.quoteId === offer.quoteId &&
    leg.recommendation.variant === offer.variant
  );
}

/**
 * A read-only, muted "—" cell — the display-only counterpart to `ChargeMatrix`'s
 * (unexported, form-only) `NotApplicableCell`. Used whenever an offer has nothing real to show
 * (`priced === false`) so the grid never prints a misleading `$0`.
 */
function NaCell() {
  return <span className="text-muted-foreground">—</span>;
}

/** One body row: a row label + one cell per offer column, in the same FF-grouped column order the
 *  header renders. Shared by every metric row so the 5-row grid doesn't hand-roll the same
 *  `groups.flatMap(...)` traversal five times. */
function MetricRow({
  label,
  groups,
  testidPrefix,
  cellClassName,
  render,
}: {
  label: string;
  groups: ForwarderGroup[];
  testidPrefix: string;
  cellClassName?: string;
  render: (offer: OfferDto) => ReactNode;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium text-muted-foreground">{label}</TableCell>
      {groups.flatMap((g) =>
        g.offers.map((o) => {
          const key = offerKey(o.quoteId, o.variant);
          return (
            <TableCell key={key} data-testid={`${testidPrefix}-${key}`} className={cellClassName}>
              {render(o)}
            </TableCell>
          );
        }),
      )}
    </TableRow>
  );
}

/**
 * ComparisonGrid — the read-only per-leg `(FF × variant)` comparison table (S5.6 §12), the visual
 * core of the Compare Quotes screen. Borrows `ChargeMatrix`'s mental model (a column per rate
 * variant, common rows, a greyed not-applicable cell) but is entirely prop-driven display — no
 * RHF, nothing here is ever editable. One column per offer (not per FF): a FF with both Road
 * variants priced gets two adjacent columns, grouped under one FF-name header cell.
 */
export function ComparisonGrid({ leg, selectedOfferKey, onSelectOffer }: ComparisonGridProps) {
  const groups = groupByForwarder(leg);

  return (
    <div className="space-y-4">
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comparable quotes yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32" />
                {groups.map((g) => (
                  <TableHead
                    key={g.freightForwarderId}
                    colSpan={g.offers.length}
                    className="text-center font-semibold text-foreground"
                  >
                    {g.freightForwarderName}
                  </TableHead>
                ))}
              </TableRow>
              <TableRow>
                <TableHead className="w-32">Offer</TableHead>
                {groups.flatMap((g) =>
                  g.offers.map((o) => {
                    const key = offerKey(o.quoteId, o.variant);
                    const recommended = isRecommended(leg, o);
                    const variantText = o.variant ? rateVariantLabel(o.variant) : "—";
                    return (
                      <TableHead
                        key={key}
                        className={cn(
                          "text-center align-bottom",
                          recommended && "bg-primary/5 ring-1 ring-inset ring-primary",
                        )}
                      >
                        {/* An unpriced offer has nothing to expand (its "charges" are just the
                            two real, always-zero Additional/Warehousing lines buildCharges still
                            emits — see OfferDetail's doc comment) — no click affordance at all,
                            consistent with the grid greying its totals rather than showing $0. */}
                        {o.priced ? (
                          <button
                            type="button"
                            data-testid={`offer-header-${key}`}
                            aria-expanded={selectedOfferKey === key}
                            onClick={() => onSelectOffer?.(o.quoteId, o.variant)}
                            className="w-full rounded px-1 py-0.5 text-center hover:bg-muted/50"
                          >
                            <span className="block text-xs font-medium">{variantText}</span>
                            {recommended && (
                              <Badge variant="accent" className="mt-1">
                                Recommended
                              </Badge>
                            )}
                          </button>
                        ) : (
                          <div data-testid={`offer-header-${key}`} className="w-full px-1 py-0.5">
                            <span className="block text-xs font-medium text-muted-foreground">
                              {variantText}
                            </span>
                          </div>
                        )}
                      </TableHead>
                    );
                  }),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              <MetricRow
                label="Total (USD)"
                groups={groups}
                testidPrefix="offer-usd"
                cellClassName="text-right font-mono tabular-nums"
                render={(o) => (o.priced ? fmtUsd(o.usdTotal) : <NaCell />)}
              />
              <MetricRow
                label="Total (native)"
                groups={groups}
                testidPrefix="offer-native"
                cellClassName="text-right font-mono tabular-nums"
                render={(o) => (o.priced ? fmtNative(o.nativeTotal, o.currency) : <NaCell />)}
              />
              <MetricRow
                label="Transit"
                groups={groups}
                testidPrefix="offer-transit"
                cellClassName="text-right text-muted-foreground"
                render={(o) => (o.transitDays == null ? "—" : `${o.transitDays} d`)}
              />
              <MetricRow
                label="Valid until"
                groups={groups}
                testidPrefix="offer-valid"
                cellClassName="text-right text-muted-foreground"
                render={(o) => (o.validUntil ? formatDate(o.validUntil) : "—")}
              />
              <MetricRow
                label="Status"
                groups={groups}
                testidPrefix="offer-status"
                cellClassName="text-center"
                render={(o) => (
                  <div className="flex flex-col items-center gap-1">
                    <ForwarderStatusBadge status={o.quoteStatus} />
                    {o.quoteStatus === "REQUOTED" && (
                      <Badge
                        variant="warning"
                        data-testid={`offer-stale-${offerKey(o.quoteId, o.variant)}`}
                        className="whitespace-nowrap"
                      >
                        Re-quote requested
                      </Badge>
                    )}
                  </div>
                )}
              />
            </TableBody>
          </Table>
        </div>
      )}

      {(leg.pendingForwarders.length > 0 || leg.awaitingReQuote) && (
        <div className="space-y-2 text-sm">
          {leg.pendingForwarders.length > 0 && (
            <div data-testid="pending-forwarders" className="space-y-1">
              <p className="font-medium text-muted-foreground">Awaiting response</p>
              <ul className="space-y-1">
                {leg.pendingForwarders.map((pf) => (
                  <li
                    key={pf.freightForwarderId}
                    data-testid={`pending-ff-${pf.freightForwarderId}`}
                    className="flex items-center gap-2"
                  >
                    <span>{pf.freightForwarderName}</span>
                    <ForwarderStatusBadge status={pf.quoteStatus} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {leg.awaitingReQuote && (
            <p className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-warning">
              Awaiting revised quote — the re-quoted offer above is excluded from the
              recommendation until the forwarder responds.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
