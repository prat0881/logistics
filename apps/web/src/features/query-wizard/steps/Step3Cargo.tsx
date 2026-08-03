import { useEffect, useState } from "react";
import type { CargoDto, CargoCreateInput, CargoUpdateInput } from "@svyft/shared";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";
import { useWizard } from "../WizardContext";
import { useCargo } from "./cargo/useCargo";
import { CargoRowForm } from "./cargo/CargoRowForm";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { StepSaveFn } from "./Step1Client";

interface Step3CargoProps {
  registerSave: (fn: StepSaveFn) => void;
}

/** Format a Prisma Decimal string (or null) as a display number */
function fmtDecimal(v: string | null, decimals = 4): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (isNaN(n)) return "—";
  return n.toFixed(decimals);
}

function fmtNum(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/**
 * Step 3 — Cargo Details
 *
 * Rows persist immediately (POST on add / PATCH on edit / DELETE on remove).
 * registerSave is a no-op that resolves immediately — rows are already on the
 * server so the shell's Save/Next doesn't need to persist cargo.
 */
export function Step3Cargo({ registerSave }: Step3CargoProps) {
  const { detail, queryId } = useWizard();
  const cargo = useCargo(queryId ?? "");

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Cargo rows are already saved on the server — registerSave is a no-op
  useEffect(() => {
    registerSave(async () => undefined);
  }, [registerSave]);

  const cargoRows: CargoDto[] = detail?.cargo ?? [];

  const handleAdd = async (input: CargoCreateInput) => {
    await cargo.add(input);
    setShowAddForm(false);
  };

  const handleUpdate = async (cid: string, input: CargoUpdateInput) => {
    await cargo.update(cid, input);
    setEditingId(null);
  };

  const handleRemove = async (cid: string) => {
    const ok = window.confirm("Remove this cargo row?");
    if (!ok) return;
    await cargo.remove(cid);
  };

  const handleExport = async () => {
    await cargo.exportXlsx();
  };

  if (!queryId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Save the query first to add cargo rows.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Cargo Details</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
          >
            Export to Excel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setShowAddForm(true);
              setEditingId(null);
            }}
          >
            + Add Row
          </Button>
        </div>
      </div>

      {/* Add / Edit dialog */}
      <Dialog
        open={showAddForm || editingId !== null}
        onOpenChange={(o) => { if (!o) { setShowAddForm(false); setEditingId(null); } }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Cargo Row" : "Add Cargo Row"}</DialogTitle>
          </DialogHeader>
          {editingId ? (
            (() => {
              const row = cargoRows.find((r) => r.id === editingId);
              return row ? (
                <CargoRowForm mode="edit" row={row} onSubmit={handleUpdate}
                  onCancel={() => setEditingId(null)} uploadMsds={cargo.uploadMsds} />
              ) : null;
            })()
          ) : (
            <CargoRowForm mode="add" onSubmit={handleAdd} onCancel={() => setShowAddForm(false)} />
          )}
        </DialogContent>
      </Dialog>

      {/* Cargo table */}
      {cargoRows.length > 0 ? (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>PO / Ref</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Pkg Type</TableHead>
                <TableHead className="font-mono tabular-nums">Qty</TableHead>
                <TableHead className="font-mono tabular-nums">L</TableHead>
                <TableHead className="font-mono tabular-nums">W</TableHead>
                <TableHead className="font-mono tabular-nums">H</TableHead>
                <TableHead className="font-mono tabular-nums">Net Wt</TableHead>
                <TableHead className="font-mono tabular-nums">Gross Wt</TableHead>
                <TableHead className="font-mono tabular-nums">Vol (CBM)</TableHead>
                <TableHead className="text-muted-foreground font-mono tabular-nums">Freight Density</TableHead>
                <TableHead className="text-muted-foreground font-mono tabular-nums">Chargeable Wt</TableHead>
                <TableHead>Reference Tags</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cargoRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono tabular-nums text-muted-foreground">
                    {row.rowIndex + 1}
                  </TableCell>
                  <TableCell>{row.poReference}</TableCell>
                  <TableCell>{row.productName}</TableCell>
                  <TableCell>{row.packageType}</TableCell>
                  <TableCell className="font-mono tabular-nums">{fmtNum(row.qty)}</TableCell>
                  <TableCell className="font-mono tabular-nums">{fmtDecimal(row.dimL, 0)} <span className="text-muted-foreground text-xs">{row.dimUnit}</span></TableCell>
                  <TableCell className="font-mono tabular-nums">{fmtDecimal(row.dimW, 0)} <span className="text-muted-foreground text-xs">{row.dimUnit}</span></TableCell>
                  <TableCell className="font-mono tabular-nums">{fmtDecimal(row.dimH, 0)} <span className="text-muted-foreground text-xs">{row.dimUnit}</span></TableCell>
                  <TableCell className="font-mono tabular-nums">{fmtDecimal(row.netWt, 2)} <span className="text-muted-foreground text-xs">{row.netWt !== null ? row.weightUnit : ""}</span></TableCell>
                  <TableCell className="font-mono tabular-nums">{fmtDecimal(row.grossWt, 2)} <span className="text-muted-foreground text-xs">{row.weightUnit}</span></TableCell>
                  <TableCell className="font-mono tabular-nums">{fmtDecimal(row.volumeCbm, 4)}</TableCell>
                  {/* Stage 4 — read-only empty with hint */}
                  <TableCell
                    className="font-mono tabular-nums text-muted-foreground"
                    title="Available in Stage 4"
                  />
                  <TableCell
                    className="font-mono tabular-nums text-muted-foreground"
                    title="Available in Stage 4"
                  />
                  <TableCell>
                    <ReferenceTagIcons tags={row.referenceTags} isDangerous={row.isDangerous} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setEditingId(row.id); setShowAddForm(false); }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRemove(row.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No cargo rows yet. Click &quot;+ Add Row&quot; to add one.
        </div>
      )}
    </div>
  );
}
