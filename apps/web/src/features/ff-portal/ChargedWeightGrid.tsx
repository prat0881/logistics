import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft, ManifestSnapshotCargo } from "@svyft/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NumberField } from "./NumberField";
import { fmtDecimal, fmtCbm } from "./format";

/** One FF-entered Charged Wt (kg) input per package (design §4.8.5 / principle #3 — Charged Wt
 *  replaces density-derived tonnes; the whole quote layer runs in kg, no tonne math). Gross/CBM
 *  are shown read-only for reference; keyed by packageId (package-grain, not cargoItemId). */
export function ChargedWeightGrid({ cargo }: { cargo: ManifestSnapshotCargo[] }) {
  const { control, setValue } = useFormContext<QuoteDraft>();
  const rows = useWatch({ control, name: "cargo" });
  const packageNoFor = (id: string) => cargo.find((c) => c.packageId === id)?.packageNo ?? id;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Package</TableHead>
            <TableHead className="text-right">Gross (kg)</TableHead>
            <TableHead className="text-right">CBM</TableHead>
            <TableHead className="text-right">Charged Wt (kg)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.packageId}>
              <TableCell className="font-mono">{packageNoFor(r.packageId)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums bg-muted/40">{fmtDecimal(r.grossWtKg, 0)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums bg-muted/40">{fmtCbm(r.cbm)}</TableCell>
              <TableCell className="text-right">
                <NumberField aria-label={`Charged Wt for ${packageNoFor(r.packageId)}`} className="w-28 text-right"
                  value={r.chargedWeightKg}
                  onChange={(v) => setValue(`cargo.${i}.chargedWeightKg`, v, { shouldDirty: true })} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
