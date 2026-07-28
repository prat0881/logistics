import type { QueryLegDto, QueryPointDto, CargoDto } from "@svyft/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

interface PreviewRfqDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  leg: QueryLegDto;
  points: QueryPointDto[];
  cargo: CargoDto[];
}

function name(points: QueryPointDto[], id: string | null): string {
  const p = id ? points.find((x) => x.id === id) : undefined;
  return p?.name ?? p?.country ?? "—";
}

export function PreviewRfqDialog({ open, onOpenChange, leg, points, cargo }: PreviewRfqDialogProps) {
  const rows = cargo.filter((c) => leg.assignedCargoIds?.includes(c.id));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>RFQ preview — {leg.legName ?? leg.legCode}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {name(points, leg.originPointId)} → {name(points, leg.destinationPointId)}
            {leg.mode ? ` · ${leg.mode}` : ""}
          </p>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-left">
              <thead className="bg-muted text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">PO</th>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">Pkg</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Gross</th>
                  <th className="px-3 py-2 font-medium">DG</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono">{c.poReference}</td>
                    <td className="px-3 py-2">{c.productName}</td>
                    <td className="px-3 py-2">{c.packageType}</td>
                    <td className="px-3 py-2">{c.qty}</td>
                    <td className="px-3 py-2">{c.grossWt}</td>
                    <td className="px-3 py-2">{c.isDangerous ? <Badge variant="destructive">DG</Badge> : "—"}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No cargo assigned to this leg.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
