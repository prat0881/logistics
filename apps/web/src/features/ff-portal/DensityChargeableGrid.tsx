import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft, ManifestSnapshotCargo } from "@svyft/shared";
import { computeChargeableWeight } from "@svyft/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NumberField } from "./NumberField";
import { fmtDecimal, fmtWeight } from "./format";

export function DensityChargeableGrid({ cargo }: { cargo: ManifestSnapshotCargo[] }) {
  const { control, setValue } = useFormContext<QuoteDraft>();
  const rows = useWatch({ control, name: "cargo" });
  const poFor = (id: string) => cargo.find((c) => c.cargoItemId === id)?.poReference ?? id;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>PO / Ref</TableHead><TableHead className="text-right">Gross (t)</TableHead>
            <TableHead className="text-right">CBM</TableHead><TableHead className="text-right">Density (kg/CBM)</TableHead>
            <TableHead className="text-right">Chargeable (t)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => {
            const cw = r.freightDensity == null ? null : computeChargeableWeight(r.grossWtT, r.cbm, r.freightDensity);
            return (
              <TableRow key={r.cargoItemId}>
                <TableCell className="font-mono">{poFor(r.cargoItemId)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums bg-muted/40">{fmtDecimal(r.grossWtT, 2)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums bg-muted/40">{r.cbm.toFixed(4)}</TableCell>
                <TableCell className="text-right">
                  <NumberField aria-label={`Density for ${poFor(r.cargoItemId)}`} className="w-28 text-right"
                    value={r.freightDensity}
                    onChange={(v) => setValue(`cargo.${i}.freightDensity`, v, { shouldDirty: true })} />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums font-medium">{cw == null ? "—" : fmtWeight(cw)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
