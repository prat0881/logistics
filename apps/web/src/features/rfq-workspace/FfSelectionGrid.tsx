import { useEffect, useMemo, useState } from "react";
import type { FreightForwarderDto, QuoteStatus } from "@svyft/shared";
import { getCountryName } from "@svyft/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useEligibleFfs, useSetFfSelection } from "./useRfq";
import { ForwarderStatusBadge } from "./statusBadges";
import { RegeneratePortalLink } from "./RegeneratePortalLink";

export interface LegQuote {
  freightForwarderId: string;
  status: QuoteStatus;
}
interface FfSelectionGridProps {
  queryId: string;
  legId: string;
  legQuotes: LegQuote[];
  referencedFfs: FreightForwarderDto[];
}

export function FfSelectionGrid({ queryId, legId, legQuotes, referencedFfs }: FfSelectionGridProps) {
  const [broaden, setBroaden] = useState(false);
  const { data: eligible = [], isLoading } = useEligibleFfs(queryId, legId, broaden);
  const setSelection = useSetFfSelection(queryId, legId);

  // Per-FF status + frozen (anything past SELECT is locked, spec §7.2.2).
  const statusByFf = useMemo(
    () => new Map(legQuotes.map((q) => [q.freightForwarderId, q.status])),
    [legQuotes],
  );
  const frozen = useMemo(
    () => new Set(legQuotes.filter((q) => q.status !== "SELECT").map((q) => q.freightForwarderId)),
    [legQuotes],
  );

  // Selection = the mutable SELECT set; seed from the server, re-seed on re-GET.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(legQuotes.filter((q) => q.status === "SELECT").map((q) => q.freightForwarderId)),
  );
  useEffect(() => {
    // Don't clobber the optimistic toggle while the mutation is in flight.
    if (setSelection.isPending) return;
    setSelected(new Set(legQuotes.filter((q) => q.status === "SELECT").map((q) => q.freightForwarderId)));
  }, [legQuotes, setSelection.isPending]);

  // Display = eligible ∪ any FF that already has a quote (so frozen/off-list FFs still show).
  const display = useMemo(() => {
    const byId = new Map<string, FreightForwarderDto>();
    for (const f of eligible) byId.set(f.id, f);
    for (const f of referencedFfs) if (statusByFf.has(f.id) && !byId.has(f.id)) byId.set(f.id, f);
    return [...byId.values()];
  }, [eligible, referencedFfs, statusByFf]);

  const selectedCount = new Set([...selected, ...frozen]).size;

  function toggle(ffId: string, next: boolean) {
    if (frozen.has(ffId)) return;
    const nextSet = new Set(selected);
    if (next) nextSet.add(ffId);
    else nextSet.delete(ffId);
    setSelected(nextSet);
    setSelection.mutate([...nextSet]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex gap-3 text-muted-foreground">
          <span>Eligible {eligible.length}</span>
          <span>·</span>
          <span>Selected {selectedCount}</span>
        </div>
        {broaden && (
          <Button variant="ghost" size="sm" onClick={() => setBroaden(false)}>
            Back to filtered
          </Button>
        )}
      </div>

      {broaden && (
        <p className="text-xs text-warning">
          Showing all active forwarders — the route/mode filter is off (DG rules still enforced at distribute).
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading forwarders…</p>
      ) : display.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm">
          <p className="text-muted-foreground">
            No eligible Freight Forwarders were found for this route and transport mode.
          </p>
          {!broaden && (
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setBroaden(true)}>
              View all active forwarders
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {display.map((f) => {
            const isFrozen = frozen.has(f.id);
            const status = statusByFf.get(f.id);
            return (
              <Card key={f.id} className={isFrozen ? "opacity-90" : ""}>
                <CardContent className="flex gap-3 p-4">
                  <Checkbox
                    aria-label={`Select ${f.companyName}`}
                    checked={selected.has(f.id) || isFrozen}
                    disabled={isFrozen}
                    onCheckedChange={(v) => toggle(f.id, v === true)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{f.companyName}</span>
                      {status && <ForwarderStatusBadge status={status} />}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {f.availableCountries.map(getCountryName).join(", ")} · {f.modes.join(", ")}
                    </p>
                    {isFrozen && <RegeneratePortalLink queryId={queryId} freightForwarderId={f.id} />}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
