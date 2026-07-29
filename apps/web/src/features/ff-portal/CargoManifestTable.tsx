import type { ManifestSnapshotCargo } from "@svyft/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { fmtDecimal, fmtCbm } from "./format";

export function CargoManifestTable({ cargo }: { cargo: ManifestSnapshotCargo[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>PO / Ref</TableHead><TableHead>Product</TableHead><TableHead>HS</TableHead>
            <TableHead>Package</TableHead><TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Dims (m)</TableHead><TableHead className="text-right">Gross (kg)</TableHead>
            <TableHead className="text-right">CBM</TableHead><TableHead>DG</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cargo.length === 0 ? (
            <TableRow><TableCell colSpan={9} className="py-6 text-center text-muted-foreground">No cargo on this leg.</TableCell></TableRow>
          ) : cargo.map((c) => (
            <TableRow key={c.cargoItemId}>
              <TableCell className="font-mono">{c.poReference}</TableCell>
              <TableCell>{c.productName}</TableCell>
              <TableCell className="font-mono">{c.hsCode ?? "—"}</TableCell>
              <TableCell>{c.packageType}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{c.qty}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtDecimal(c.dimL,2)}×{fmtDecimal(c.dimW,2)}×{fmtDecimal(c.dimH,2)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtDecimal(c.grossWt,0)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtCbm(c.volumeCbm)}</TableCell>
              <TableCell>{c.isDangerous ? <Badge variant="warning">DG</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
