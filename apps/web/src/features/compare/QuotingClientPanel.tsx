import type { LegComparisonDto, QueryAwardSnapshot } from "@svyft/shared";
import { rateVariantLabel } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { fmtUsd } from "./money";
import { useReopenComparison } from "./useAwardActions";
import { errorMessage } from "./errorMessage";

export interface QuotingClientPanelProps {
  queryId: string;
  snapshot: QueryAwardSnapshot;
  /** The live `ComparisonDto.legs` — used ONLY to resolve display names/routes for the snapshot's
   *  bare ids (see the name-resolution note below), never to re-derive award state. */
  legs: LegComparisonDto[];
  fxAsOf: string | null;
}

/**
 * QuotingClientPanel — the frozen award summary shown once the query is QUOTING_CLIENT (S5.6
 * Task 6). Mounted purely off `comparison.awardSnapshot != null` (coordinator ambiguity
 * resolution #1 — the same presence signal `query-status.projector.ts` itself reads to roll the
 * query to QUOTING_CLIENT). Renders each leg's frozen winner (FF + variant + USD/transit), the
 * snapshot's own `combinedUsd`, the comparison's FX "as of" stamp, and the Executive+ Reopen
 * control (resolution #3 — no confirmation dialog; `useReopenComparison` invalidates both
 * `["comparison", queryId]` and `["query", queryId]` on success, same convention as every other
 * award-action hook in `useAwardActions.ts`).
 *
 * ID -> NAME RESOLUTION (judgment call): `QueryAwardSnapshotLeg` stores only ids
 * (`freightForwarderId`, `legId`) — nothing in the snapshot itself carries a display name, and the
 * brief explicitly rules out a second network call. `legById` (built from the SAME `legs` prop
 * `CompareQuotesPage` already fetched) resolves the leg's own code/route straight off the `Leg`
 * table, unaffected by any quote's status. Forwarder names are harder: once a quote is APPROVED —
 * which every winner is, by the time this panel can ever render, see
 * `award.service.ts#generateClientQuote`'s own doc comment — `ComparisonService.getComparison`
 * stops emitting ANY `OfferDto` for it (`COMPARABLE_STATUSES` is QUOTED/REQUOTED only), including
 * on its own leg. So a lookup scoped to "the winning leg's own offers" would ALWAYS miss for the
 * one row that matters most. Instead `ffNameById` is built from EVERY leg's `offers[]` AND
 * `pendingForwarders[]` across the WHOLE comparison (both already carry `freightForwarderName`
 * per `OfferDto`/`PendingForwarderDto`) — the winning forwarder's name survives if that same
 * company happens to still appear anywhere else in the query (a non-winning offer on another leg,
 * or a still-pending RFQ). When it doesn't (the snapshot is frozen; a forwarder or leg can in
 * principle no longer appear in the live read model at all), this degrades to a generic
 * "Unknown forwarder" / short leg-id label rather than crashing or fabricating a name — the same
 * defensive `.find()`-and-fall-back convention `RecommendationBanner`/`defaultShortlistKey`
 * already use elsewhere in this feature.
 */
export function QuotingClientPanel({ queryId, snapshot, legs, fxAsOf }: QuotingClientPanelProps) {
  const reopen = useReopenComparison(queryId);

  const legById = new Map(legs.map((l) => [l.legId, l]));
  const ffNameById = new Map<string, string>();
  for (const leg of legs) {
    for (const o of leg.offers) {
      if (!ffNameById.has(o.freightForwarderId)) {
        ffNameById.set(o.freightForwarderId, o.freightForwarderName);
      }
    }
    for (const p of leg.pendingForwarders) {
      if (!ffNameById.has(p.freightForwarderId)) {
        ffNameById.set(p.freightForwarderId, p.freightForwarderName);
      }
    }
  }

  function onReopen() {
    if (reopen.isPending) return;
    reopen.mutate();
  }

  return (
    <div
      data-testid="quoting-client-panel"
      className="space-y-4 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Quoted to client
        </h3>
        {fxAsOf && (
          <span className="text-xs text-muted-foreground">FX as of {formatDateTime(fxAsOf)}</span>
        )}
      </div>

      <ul className="space-y-2">
        {snapshot.legs.map((sLeg) => {
          const leg = legById.get(sLeg.legId);
          const ffName = ffNameById.get(sLeg.freightForwarderId) ?? "Unknown forwarder";
          const variantLabel = sLeg.variant ? rateVariantLabel(sLeg.variant) : "—";
          return (
            <li
              key={sLeg.legId}
              data-testid={`snapshot-leg-${sLeg.legId}`}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 text-sm last:border-b-0 last:pb-0"
            >
              <div>
                <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
                  {leg?.legCode ?? `Leg ${sLeg.legId.slice(0, 8)}`}
                </span>
                {leg && (
                  <span className="ml-2 text-muted-foreground">
                    {leg.origin} → {leg.destination}
                  </span>
                )}
              </div>
              <div className="text-right">
                <p className="font-medium">
                  {ffName} — {variantLabel}
                </p>
                <p className="text-muted-foreground">
                  {fmtUsd(sLeg.usdTotal)}
                  {sLeg.transitDays != null &&
                    ` · ${sLeg.transitDays} day${sLeg.transitDays === 1 ? "" : "s"}`}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm font-medium">Combined total</span>
        <span className="text-lg font-semibold">{fmtUsd(snapshot.combinedUsd)}</span>
      </div>

      {reopen.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(reopen.error, "Failed to reopen the comparison.")}
        </p>
      )}

      <Button type="button" variant="outline" onClick={onReopen} disabled={reopen.isPending}>
        {reopen.isPending ? "Reopening…" : "Reopen comparison"}
      </Button>
    </div>
  );
}
