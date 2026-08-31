import { useState } from "react";
import type { LegComparisonDto, QueryAwardSnapshot } from "@svyft/shared";
import { rateVariantLabel, Role } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/dates";
import { useAuth } from "@/features/auth/AuthProvider";
import { fmtUsd } from "./money";
import { ReopenDialog } from "./ReopenDialog";

export interface QuotingClientPanelProps {
  queryId: string;
  snapshot: QueryAwardSnapshot;
  /** The live `ComparisonDto.legs` — used ONLY to resolve the snapshot's leg ids to a display
   *  code/route (see the name-resolution note below), never to re-derive award state. */
  legs: LegComparisonDto[];
  /** `ComparisonDto.forwarderNames` (freightForwarderId -> companyName) — see the name-resolution
   *  note below for why this can't be derived from `legs` alone. */
  forwarderNames: Record<string, string>;
  fxAsOf: string | null;
}

/**
 * QuotingClientPanel — the frozen award summary shown once the query is QUOTING_CLIENT (S5.6
 * Task 6). Mounted purely off `comparison.awardSnapshot != null` (coordinator ambiguity
 * resolution #1 — the same presence signal `query-status.projector.ts` itself reads to roll the
 * query to QUOTING_CLIENT). Renders each leg's frozen winner (FF + variant + USD/transit), the
 * snapshot's own `combinedUsd`, the comparison's FX "as of" stamp, and the Reopen control.
 *
 * **The Reopen control, CORRECTED at S5.9.5 (design D6).** This used to be described as "the
 * Executive+ Reopen control (resolution #3 — no confirmation dialog)". Neither half survives D6:
 * `award.controller.ts`'s `reopen-comparison` now carries `@Roles(Role.ADMINISTRATOR,
 * Role.MANAGER)` and requires a `{reason}` body. So the button is withheld from anyone who is not
 * a checker — a ROLE rule hides rather than disables (D1), and an Executive who clicked it could
 * only ever earn a 403 — and it opens `ReopenDialog` to collect the reason instead of mutating
 * straight from the bar, the same shape `RejectDialog` has. `useReopenComparison` still
 * invalidates both `["comparison", queryId]` and `["query", queryId]` on success, same convention
 * as every other award-action hook in `useAwardActions.ts`. The mutation's error state is rendered
 * inside the dialog now (it is where the submit happens), not beside the trigger.
 *
 * ID -> NAME RESOLUTION (judgment call, revised in review round 1): `QueryAwardSnapshotLeg`
 * stores only ids (`freightForwarderId`, `legId`) — nothing in the snapshot itself carries a
 * display name, and a second network call is explicitly out. `legById` (built from the SAME
 * `legs` prop `CompareQuotesPage` already fetched) resolves the leg's own code/route straight off
 * the `Leg` table, unaffected by any quote's status.
 *
 * Forwarder names are NOT resolved from `legs[].offers[]`/`pendingForwarders[]` — an earlier
 * version of this component did that and was wrong. RE-TRACED at S5.9.5 (design D8), because the
 * reason recorded here has changed: it used to be that `COMPARABLE_STATUSES` excluded `APPROVED`
 * outright, so `ComparisonService.getComparison` emitted no `OfferDto` at all for a snapshot
 * winner (which every leg's winner is by the time this panel can render — see
 * `award.service.ts#generateClientQuote`'s own doc comment) and a lookup scoped to the live
 * comparison missed EVERY time. D8 added `APPROVED` to that list, so an approved winner usually
 * does produce an offer now — but only usually: `buildLeg` skips any quote with no
 * `submittedJson` (S5.9.6),
 * and the whole point of a frozen snapshot is that it must not depend on what the live read model
 * happens to still carry. `forwarderNames` is the source that does not depend on status at all,
 * which is why it stays the one used here.
 * Instead this reads `ComparisonDto.forwarderNames` (a `freightForwarderId -> companyName` map
 * `ComparisonService.getComparison` builds server-side from EVERY quote on the query, no status
 * filter — see that field's own doc comment) — the exact same data source that names
 * `offers[].freightForwarderName` for non-APPROVED quotes, just not status-filtered. A miss is
 * still possible in principle (the snapshot is frozen; a forwarder could in principle be deleted
 * from master data later) and degrades to a generic "Unknown forwarder" rather than crashing or
 * fabricating a name — the same defensive fallback convention `buildComparisonRowModel` already
 * uses elsewhere in this feature (a recommendation naming an offer the leg no longer carries flags
 * nothing rather than crashing).
 */
export function QuotingClientPanel({
  queryId,
  snapshot,
  legs,
  forwarderNames,
  fxAsOf,
}: QuotingClientPanelProps) {
  const { user } = useAuth();
  // The SAME "is this viewer a checker?" test `CompareLegPanel` and `CompareQuotesPage` already
  // compute, matching `reopen-comparison`'s own `@Roles(Role.ADMINISTRATOR, Role.MANAGER)` (D6).
  const isChecker = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;
  const [reopenOpen, setReopenOpen] = useState(false);

  const legById = new Map(legs.map((l) => [l.legId, l]));

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
          const ffName = forwarderNames[sLeg.freightForwarderId] ?? "Unknown forwarder";
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

      {isChecker && (
        <Button type="button" variant="outline" onClick={() => setReopenOpen(true)}>
          Reopen comparison
        </Button>
      )}
      {isChecker && (
        <ReopenDialog open={reopenOpen} onOpenChange={setReopenOpen} queryId={queryId} />
      )}
    </div>
  );
}
