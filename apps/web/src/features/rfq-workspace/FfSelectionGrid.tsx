import { useEffect, useMemo, useState } from "react";
import type { FreightForwarderDto, QuoteStatus } from "@svyft/shared";
import { getCountryName } from "@svyft/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useEligibleFfs, useSetFfSelection } from "./useRfq";
import { ForwarderStatusBadge } from "./statusBadges";
import { RegeneratePortalLink } from "./RegeneratePortalLink";

const PAGE_SIZE = 10;

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

function countryText(f: FreightForwarderDto): string {
  return f.availableCountries.map(getCountryName).join(", ");
}

export function FfSelectionGrid({ queryId, legId, legQuotes, referencedFfs }: FfSelectionGridProps) {
  const [broaden, setBroaden] = useState(false);
  const [view, setView] = useState<"cards" | "table">("table");
  const [search, setSearch] = useState("");
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);
  const { data: eligible = [], isLoading } = useEligibleFfs(queryId, legId, broaden);
  const setSelection = useSetFfSelection(queryId, legId);

  const statusByFf = useMemo(
    () => new Map(legQuotes.map((q) => [q.freightForwarderId, q.status])),
    [legQuotes],
  );
  const frozen = useMemo(
    () => new Set(legQuotes.filter((q) => q.status !== "SELECT").map((q) => q.freightForwarderId)),
    [legQuotes],
  );

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(legQuotes.filter((q) => q.status === "SELECT").map((q) => q.freightForwarderId)),
  );
  useEffect(() => {
    if (setSelection.isPending) return;
    setSelected(new Set(legQuotes.filter((q) => q.status === "SELECT").map((q) => q.freightForwarderId)));
  }, [legQuotes, setSelection.isPending]);

  const display = useMemo(() => {
    const byId = new Map<string, FreightForwarderDto>();
    for (const f of eligible) byId.set(f.id, f);
    for (const f of referencedFfs) if (statusByFf.has(f.id) && !byId.has(f.id)) byId.set(f.id, f);
    return [...byId.values()];
  }, [eligible, referencedFfs, statusByFf]);

  const selectedCount = new Set([...selected, ...frozen]).size;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? display.filter(
          (f) =>
            f.companyName.toLowerCase().includes(q) ||
            f.modes.join(" ").toLowerCase().includes(q) ||
            countryText(f).toLowerCase().includes(q),
        )
      : display;
    return [...base].sort((a, b) =>
      sortAsc ? a.companyName.localeCompare(b.companyName) : b.companyName.localeCompare(a.companyName),
    );
  }, [display, search, sortAsc]);

  useEffect(() => setPage(1), [search, broaden, view]);

  const paged = view === "table" ? filtered.slice(0, page * PAGE_SIZE) : filtered;
  const hasMore = view === "table" && filtered.length > paged.length;

  function toggle(ffId: string, next: boolean) {
    if (frozen.has(ffId)) return;
    const nextSet = new Set(selected);
    if (next) nextSet.add(ffId);
    else nextSet.delete(ffId);
    setSelected(nextSet);
    setSelection.mutate([...nextSet]);
  }

  const isChecked = (id: string) => selected.has(id) || frozen.has(id);
  const toggleBtn = (v: "cards" | "table", label: string) => (
    <button
      type="button"
      onClick={() => setView(v)}
      aria-pressed={view === v}
      className={cn(
        "px-3 py-1 text-xs font-medium",
        view === v ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        <div className="flex items-center gap-3 text-muted-foreground">
          <span>Eligible {eligible.length}</span>
          <span>·</span>
          <span>Selected {selectedCount}</span>
          {broaden && (
            <Button variant="ghost" size="sm" onClick={() => setBroaden(false)}>Back to filtered</Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Search forwarders"
            placeholder="Search forwarder, mode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-56"
          />
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {toggleBtn("cards", "Cards")}
            {toggleBtn("table", "Table")}
          </div>
        </div>
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
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No forwarders match your search.</p>
      ) : view === "cards" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((f) => {
            const isFrozen = frozen.has(f.id);
            const status = statusByFf.get(f.id);
            return (
              <Card key={f.id} className={isFrozen ? "opacity-90" : ""}>
                <CardContent className="flex gap-3 p-4">
                  <Checkbox
                    aria-label={`Select ${f.companyName}`}
                    checked={isChecked(f.id)}
                    disabled={isFrozen}
                    onCheckedChange={(v) => toggle(f.id, v === true)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{f.companyName}</span>
                      {status && <ForwarderStatusBadge status={status} />}
                    </div>
                    <p className="text-xs text-muted-foreground">{countryText(f)} · {f.modes.join(", ")}</p>
                    {isFrozen && <RegeneratePortalLink queryId={queryId} freightForwarderId={f.id} />}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="w-10 px-4 py-2" />
                  <th scope="col" className="px-4 py-2 font-medium" aria-sort={sortAsc ? "ascending" : "descending"}>
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => setSortAsc((s) => !s)}>
                      Forwarder <span aria-hidden>{sortAsc ? "↑" : "↓"}</span>
                    </button>
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">Country</th>
                  <th scope="col" className="px-4 py-2 font-medium">Modes</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((f) => {
                  const isFrozen = frozen.has(f.id);
                  const status = statusByFf.get(f.id);
                  return (
                    <tr key={f.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                      <td className="px-4 py-2">
                        <Checkbox
                          aria-label={`Select ${f.companyName}`}
                          checked={isChecked(f.id)}
                          disabled={isFrozen}
                          onCheckedChange={(v) => toggle(f.id, v === true)}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-medium">{f.companyName}</span>
                        {isFrozen && (
                          <div className="mt-1"><RegeneratePortalLink queryId={queryId} freightForwarderId={f.id} /></div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{countryText(f)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{f.modes.join(", ")}</td>
                      <td className="px-4 py-2">{status ? <ForwarderStatusBadge status={status} /> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
            <span>Showing {paged.length} of {filtered.length} eligible</span>
            {hasMore && (
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => p + 1)}>Load 10 more</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
