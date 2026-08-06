import type { ManifestSnapshotCargo } from "@svyft/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";
import { fmtDecimal, fmtCbm } from "./format";

/** Read-only per-package manifest table (design §4.8.5): the frozen packing-list snapshot,
 *  package-grain — no PO/product/HS (executive-side cargo detail, not shown to the FF). */
export function CargoManifestTable({ cargo }: { cargo: ManifestSnapshotCargo[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SN</TableHead><TableHead className="text-right">Count</TableHead>
            <TableHead>Type</TableHead><TableHead className="text-right">L/W/H (cm)</TableHead>
            <TableHead className="text-right">Net (kg)</TableHead><TableHead className="text-right">Gross (kg)</TableHead>
            <TableHead className="text-right">CBM</TableHead><TableHead>Tags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cargo.length === 0 ? (
            <TableRow><TableCell colSpan={8} className="py-6 text-center text-muted-foreground">No cargo on this leg.</TableCell></TableRow>
          ) : cargo.map((c, i) => (
            <TableRow key={c.packageId}>
              <TableCell className="font-mono tabular-nums">{i + 1}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{c.packageCount}</TableCell>
              <TableCell>{c.packageType}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtDecimal(c.dimL,0)}×{fmtDecimal(c.dimW,0)}×{fmtDecimal(c.dimH,0)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtDecimal(c.netWt,0)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtDecimal(c.grossWt,0)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtCbm(c.volumeCbm)}</TableCell>
              <TableCell><ReferenceTagIcons tags={c.tags} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
