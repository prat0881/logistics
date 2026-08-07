import type { QueryLegDto, QueryPointDto, CargoDto, PackageDto } from "@svyft/shared";
import { fromCanonicalDim, packageTypeLabel } from "@svyft/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";

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

/** Format a number for display, or "—" when it isn't finite. */
function fmtNum(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(decimals);
}

/** Every package assigned to this leg, paired with the CargoDto that owns it (needed for
 *  its dimUnit — PackageDto itself only carries canonical cm/kg values). */
function assignedRows(
  cargo: CargoDto[],
  assignedPackageIds: string[],
): { cargo: CargoDto; pkg: PackageDto }[] {
  const rows: { cargo: CargoDto; pkg: PackageDto }[] = [];
  for (const c of cargo) {
    for (const pkg of c.packages) {
      if (assignedPackageIds.includes(pkg.id)) rows.push({ cargo: c, pkg });
    }
  }
  return rows;
}

export function PreviewRfqDialog({
  open,
  onOpenChange,
  leg,
  points,
  cargo,
}: PreviewRfqDialogProps) {
  const rows = assignedRows(cargo, leg.assignedPackageIds);
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
                  <th className="px-3 py-2 font-medium">Package No</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">L</th>
                  <th className="px-3 py-2 font-medium">W</th>
                  <th className="px-3 py-2 font-medium">H</th>
                  <th className="px-3 py-2 font-medium">Gross</th>
                  <th className="px-3 py-2 font-medium">Net</th>
                  <th className="px-3 py-2 font-medium">CBM</th>
                  <th className="px-3 py-2 font-medium">Tags</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map(({ cargo: c, pkg }) => (
                    <tr key={pkg.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono">{pkg.packageNo}</td>
                      <td className="px-3 py-2">{packageTypeLabel(pkg.packageType)}</td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {fmtNum(fromCanonicalDim(Number(pkg.dimL), c.dimUnit), 0)}{" "}
                        <span className="text-xs text-muted-foreground">{c.dimUnit}</span>
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {fmtNum(fromCanonicalDim(Number(pkg.dimW), c.dimUnit), 0)}{" "}
                        <span className="text-xs text-muted-foreground">{c.dimUnit}</span>
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {fmtNum(fromCanonicalDim(Number(pkg.dimH), c.dimUnit), 0)}{" "}
                        <span className="text-xs text-muted-foreground">{c.dimUnit}</span>
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {fmtNum(Number(pkg.grossWt))} kg
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {pkg.netWt !== null ? `${fmtNum(Number(pkg.netWt))} kg` : "—"}
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {pkg.volumeCbm !== null ? fmtNum(Number(pkg.volumeCbm), 4) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <ReferenceTagIcons tags={pkg.effectiveTags} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                      No cargo assigned to this leg.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
