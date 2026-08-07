import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft, ManifestSnapshotCargo } from "@svyft/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";
import { NumberField } from "./NumberField";
import { fmtDecimal, fmtCbm } from "./format";
import { toNumOrNull } from "./numeric";

/** Merged cargo + chargeable-weight table (design §6 finding #2): replaces the old two-table
 *  CargoManifestTable + ChargedWeightGrid pairing in the editable quote form with one — per-package
 *  read-only rows (frozen packing-list snapshot, package-grain) → a Totals row (Σ Gross, Σ CBM) →
 *  the single leg-level Chargeable Weight (kg) input (v3: QuoteDraft.chargedWeightKg — one figure
 *  per leg, not one per package; no density/tonne math anywhere in the quote layer). */
export function CargoWeightTable({ manifest }: { manifest: ManifestSnapshotCargo[] }) {
  const { control, setValue } = useFormContext<QuoteDraft>();
  const chargedWeightKg = useWatch({ control, name: "chargedWeightKg" });

  const totalGross = manifest.reduce((s, c) => s + (toNumOrNull(c.grossWt) ?? 0), 0);
  const totalCbm = manifest.reduce((s, c) => s + (toNumOrNull(c.volumeCbm) ?? 0), 0);

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SN</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">L/W/H (cm)</TableHead>
            <TableHead className="text-right">Gross (kg)</TableHead>
            <TableHead className="text-right">CBM</TableHead>
            <TableHead>Tags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {manifest.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                No cargo on this leg.
              </TableCell>
            </TableRow>
          ) : (
            manifest.map((c, i) => (
              <TableRow key={c.packageId}>
                <TableCell className="font-mono tabular-nums">{i + 1}</TableCell>
                <TableCell>{c.packageType}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {fmtDecimal(c.dimL, 0)}×{fmtDecimal(c.dimW, 0)}×{fmtDecimal(c.dimH, 0)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {fmtDecimal(c.grossWt, 0)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {fmtCbm(c.volumeCbm)}
                </TableCell>
                <TableCell>
                  <ReferenceTagIcons tags={c.tags} />
                </TableCell>
              </TableRow>
            ))
          )}
          <TableRow className="bg-muted/40 font-semibold">
            <TableCell colSpan={3}>Totals</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {fmtDecimal(totalGross, 0)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{fmtCbm(totalCbm)}</TableCell>
            <TableCell />
          </TableRow>
          <TableRow>
            <TableCell colSpan={5} className="text-right font-medium">
              Chargeable Weight (kg)
            </TableCell>
            <TableCell className="text-right">
              <NumberField
                aria-label="Chargeable Weight (kg)"
                className="w-28 text-right"
                value={chargedWeightKg}
                onChange={(v) => setValue("chargedWeightKg", v, { shouldDirty: true })}
              />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
