import { useState } from "react";
import type { QueryLegDto, QueryPointDto, QuoteDto, FreightForwarderDto } from "@svyft/shared";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { LegStatusBadge } from "./statusBadges";
import { FfSelectionGrid } from "./FfSelectionGrid";
import { DistributeLegAction } from "./DistributeLegAction";

interface LegPanelProps {
  queryId: string;
  leg: QueryLegDto;
  points: QueryPointDto[];
  legQuotes: QuoteDto[];
  referencedFfs: FreightForwarderDto[];
}

/** "YYYY-MM-DDTHH:mm" (local) for <input type="datetime-local">, defaulted +48h. */
export function defaultDeadlineLocal(nowMs?: number): string {
  const d = new Date((nowMs ?? Date.now()) + 48 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pointName(points: QueryPointDto[], id: string | null): string {
  if (!id) return "—";
  const p = points.find((x) => x.id === id);
  return p?.name ?? ([p?.city, p?.country].filter(Boolean).join(", ") || "—");
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export function LegPanel({ queryId, leg, points, legQuotes, referencedFfs }: LegPanelProps) {
  const [open, setOpen] = useState(true);
  const [deadline, setDeadline] = useState(defaultDeadlineLocal());

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-mono text-xs text-muted-foreground">{leg.legCode}</span>
        <span className="font-medium">{leg.legName ?? "Unnamed leg"}</span>
        {leg.mode && <Badge variant="secondary">{leg.mode}</Badge>}
        <span className="ml-auto"><LegStatusBadge status={leg.status} /></span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Origin</dt>
              <dd>{pointName(points, leg.originPointId)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Destination</dt>
              <dd>{pointName(points, leg.destinationPointId)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Ready</dt>
              <dd>{fmtDate(leg.readyDate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Target delivery</dt>
              <dd>{fmtDate(leg.targetDelivery)}</dd>
            </div>
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-xs text-muted-foreground">Manifest totals</dt>
              <dd>
                {leg.rollup.totalPackages} pkg · {leg.rollup.totalCbm} CBM ·{" "}
                {leg.rollup.totalGrossWt} kg gross · {leg.rollup.totalNetWt} kg net
              </dd>
            </div>
          </dl>

          <FfSelectionGrid
            queryId={queryId}
            legId={leg.id}
            legQuotes={legQuotes.map((q) => ({ freightForwarderId: q.freightForwarderId, status: q.status }))}
            referencedFfs={referencedFfs}
          />

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
            <div className="space-y-1">
              <Label htmlFor={`deadline-${leg.id}`}>Submission deadline</Label>
              <Input
                id={`deadline-${leg.id}`}
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-56"
              />
            </div>
            <DistributeLegAction
              queryId={queryId}
              legId={leg.id}
              deadlineLocal={deadline}
              canDistribute={legQuotes.some((q) => q.status === "SELECT")}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
