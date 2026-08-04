import { useState } from "react";
import type { QueryLegDto, QueryPointDto, QuoteDto, FreightForwarderDto, CargoDto } from "@svyft/shared";
import { getCountryName } from "@svyft/shared";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight } from "lucide-react";
import { LegStatusBadge } from "./statusBadges";
import { FfSelectionGrid } from "./FfSelectionGrid";
import { DistributeLegAction } from "./DistributeLegAction";
import { PreviewRfqDialog } from "./PreviewRfqDialog";
import { useChargeCatalogue } from "./useChargeConfig";
import { ConfigureChargesPopover } from "./ConfigureChargesPopover";
import { WarehouseHandlingToggle, legTouchesWarehouse } from "./WarehouseHandlingToggle";

interface LegPanelProps {
  queryId: string;
  leg: QueryLegDto;
  points: QueryPointDto[];
  legQuotes: QuoteDto[];
  referencedFfs: FreightForwarderDto[];
  cargo: CargoDto[];
  open: boolean;
  onToggle: () => void;
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

function pointCountryName(points: QueryPointDto[], id: string | null): string {
  const code = id ? (points.find((x) => x.id === id)?.country ?? null) : null;
  return code ? getCountryName(code) : "—";
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export function LegPanel({ queryId, leg, points, legQuotes, referencedFfs, cargo, open, onToggle }: LegPanelProps) {
  const [deadline, setDeadline] = useState(defaultDeadlineLocal());
  const [previewOpen, setPreviewOpen] = useState(false);
  const catalogue = useChargeCatalogue();
  const hasSent = legQuotes.some((q) => q.status !== "SELECT");
  const route = `${pointName(points, leg.originPointId)} → ${pointName(points, leg.destinationPointId)}`;
  const originCountry = pointCountryName(points, leg.originPointId);
  const destCountry = pointCountryName(points, leg.destinationPointId);

  return (
    <Card id={`legcard-${leg.id}`} className="scroll-mt-4 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">{leg.legCode}</span>
        <span className="font-medium">{route}</span>
        {leg.mode && <Badge variant="secondary">{leg.mode}</Badge>}
        <span className="ml-auto"><LegStatusBadge status={leg.status} /></span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Ready</dt>
              <dd>{fmtDate(leg.readyDate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Target delivery</dt>
              <dd>{fmtDate(leg.targetDelivery)}</dd>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <dt className="text-xs text-muted-foreground">Manifest</dt>
              <dd>
                {leg.rollup.totalPackages} pkg · {leg.rollup.totalCbm} CBM · {leg.rollup.totalGrossWt} kg gross
                {leg.rollup.totalNetWt > 0 && <> · {leg.rollup.totalNetWt} kg net</>}
              </dd>
            </div>
          </dl>

          <div className="space-y-3 border-b border-border pb-4">
            {catalogue.data && (
              <ConfigureChargesPopover queryId={queryId} leg={leg} catalogue={catalogue.data} disabled={hasSent} />
            )}
            {legTouchesWarehouse(leg, points) && (
              <WarehouseHandlingToggle queryId={queryId} leg={leg} disabled={hasSent} />
            )}
          </div>

          <div className="space-y-2">
            <div className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
              Forwarders covering {originCountry} → {destCountry}
            </div>
            <FfSelectionGrid
              queryId={queryId}
              legId={leg.id}
              legQuotes={legQuotes.map((q) => ({ freightForwarderId: q.freightForwarderId, status: q.status }))}
              referencedFfs={referencedFfs}
            />
          </div>

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
            {!hasSent && <Button variant="outline" onClick={() => setPreviewOpen(true)}>Preview RFQ</Button>}
            <DistributeLegAction
              queryId={queryId}
              legId={leg.id}
              deadlineLocal={deadline}
              canDistribute={legQuotes.some((q) => q.status === "SELECT")}
            />
          </div>
        </div>
      )}
      <PreviewRfqDialog open={previewOpen} onOpenChange={setPreviewOpen} leg={leg} points={points} cargo={cargo} />
    </Card>
  );
}
