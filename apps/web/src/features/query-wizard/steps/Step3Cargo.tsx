import { useEffect, useState, Fragment } from "react";
import type { CargoDto, PackageDto, ItemDto } from "@svyft/shared";
import {
  fromCanonicalWeight,
  fromCanonicalDim,
  cargoLabel,
  packageTypeLabel,
  uomLabel,
} from "@svyft/shared";
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
import { ChevronDown, ChevronRight } from "lucide-react";
import { useWizard } from "../WizardContext";
import { useCargo } from "./cargo/useCargo";
import { CargoPopup } from "./cargo/CargoPopup";
import type { StepSaveFn } from "./Step1Client";

interface Step3CargoProps {
  registerSave: (fn: StepSaveFn) => void;
}

/** Format a number for display, or "—" when it isn't finite. */
function fmtNum(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(decimals);
}

/** "<product> ×<qty>" for one item, falling back to whichever half is present. */
function fmtItem(item: ItemDto): string {
  const product = item.product?.trim() || "Item";
  return item.qty ? `${product} ×${item.qty}` : product;
}

/** Contents summary = every item across the given packages, joined readably. */
function contentsOf(packages: PackageDto[]): string {
  const items = packages.flatMap((p) => p.items);
  if (items.length === 0) return "—";
  return items.map(fmtItem).join(", ");
}

/**
 * Step 3 — Cargo Details
 *
 * One row per Cargo (detail.cargos), expanding to a packages sub-table, each package
 * expanding to an items sub-table. Rows persist immediately server-side (the cargo/
 * package/item hooks POST/PATCH/DELETE + invalidate), so registerSave is a no-op —
 * the shell's Save/Next doesn't need to persist anything for this step.
 *
 * Add/Edit open CargoPopup (Task 13), the nested cargo -> package -> item entry dialog.
 * The retired flat CargoRowForm is no longer used anywhere in this step.
 */
export function Step3Cargo({ registerSave }: Step3CargoProps) {
  const { detail, queryId } = useWizard();
  const cargoActions = useCargo(queryId ?? "");

  const [expandedCargo, setExpandedCargo] = useState<Set<string>>(new Set());
  const [expandedPackage, setExpandedPackage] = useState<Set<string>>(new Set());
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupCargo, setPopupCargo] = useState<CargoDto | undefined>(undefined);

  // Cargo/package/item rows are already saved on the server — registerSave is a no-op
  useEffect(() => {
    registerSave(async () => undefined);
  }, [registerSave]);

  const cargoRows: CargoDto[] = detail?.cargos ?? [];

  const toggleCargo = (id: string) =>
    setExpandedCargo((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const togglePackage = (id: string) =>
    setExpandedPackage((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openAddCargo = () => {
    setPopupCargo(undefined);
    setPopupOpen(true);
  };

  const openEditCargo = (row: CargoDto) => {
    setPopupCargo(row);
    setPopupOpen(true);
  };

  const handleRemove = async (cargoId: string) => {
    const ok = window.confirm("Remove this cargo row?");
    if (!ok) return;
    await cargoActions.remove(cargoId);
  };

  const handleExport = async () => {
    await cargoActions.exportXlsx();
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
          <Button variant="outline" size="sm" onClick={handleExport}>
            Export to Excel
          </Button>
          <Button size="sm" onClick={openAddCargo}>
            + Add Cargo
          </Button>
        </div>
      </div>

      {/* Keyed so every open gets a fresh CargoPopup instance — its cargoRow/addingPackage
          state is seeded from `cargo` at mount and never re-syncs from prop changes while
          mounted (Dialog keeps this component alive even when visually closed). Remounting
          on each open (key flips through "closed" in between) avoids stale state leaking
          from a previous Add/Edit session into the next. */}
      <CargoPopup
        key={popupOpen ? (popupCargo?.id ?? "add") : "closed"}
        open={popupOpen}
        onOpenChange={setPopupOpen}
        queryId={queryId}
        cargo={popupCargo}
        existingPackageNos={cargoRows.flatMap((c) => c.packages.map((p) => p.packageNo))}
      />

      {/* Cargo table */}
      {cargoRows.length > 0 ? (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>#</TableHead>
                <TableHead>PO / Ref</TableHead>
                <TableHead className="font-mono tabular-nums">Package Count</TableHead>
                <TableHead>Contents</TableHead>
                <TableHead className="font-mono tabular-nums">Σ Gross</TableHead>
                <TableHead className="font-mono tabular-nums">Σ Volume</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead className="text-muted-foreground font-mono tabular-nums">
                  Chargeable
                </TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cargoRows.map((row) => {
                const isOpen = expandedCargo.has(row.id);
                const label = row.poReference || cargoLabel(row);
                return (
                  <Fragment key={row.id}>
                    <TableRow>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={`Expand cargo ${label}`}
                          aria-expanded={isOpen}
                          onClick={() => toggleCargo(row.id)}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell className="font-mono tabular-nums text-muted-foreground">
                        {row.rowIndex + 1}
                      </TableCell>
                      <TableCell>{row.poReference || "—"}</TableCell>
                      <TableCell className="font-mono tabular-nums">{row.packageCount}</TableCell>
                      <TableCell className="max-w-xs truncate" title={contentsOf(row.packages)}>
                        {contentsOf(row.packages)}
                      </TableCell>
                      <TableCell className="font-mono tabular-nums">
                        {fmtNum(fromCanonicalWeight(Number(row.grossWeightKg), row.weightUnit))}{" "}
                        <span className="text-muted-foreground text-xs">{row.weightUnit}</span>
                      </TableCell>
                      <TableCell className="font-mono tabular-nums">
                        {fmtNum(Number(row.volumeCbm), 4)}
                      </TableCell>
                      <TableCell>
                        <ReferenceTagIcons tags={row.tags} />
                      </TableCell>
                      {/* Chargeable weight is Stage 4 — always null at Stage 3 */}
                      <TableCell
                        className="font-mono tabular-nums text-muted-foreground"
                        title="Available in Stage 4"
                      />
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="outline" size="sm" onClick={() => openEditCargo(row)}>
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
                    {isOpen && (
                      <TableRow>
                        <TableCell colSpan={10} className="bg-muted/30 p-0">
                          <PackagesTable
                            cargo={row}
                            expandedPackage={expandedPackage}
                            onTogglePackage={togglePackage}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No cargo rows yet. Click &quot;+ Add Cargo&quot; to add one.
        </div>
      )}
    </div>
  );
}

/** The packages sub-table for one expanded Cargo row. Dims/weights are shown in the
 *  cargo's own entry unit (dimUnit/weightUnit) — packages are always stored+entered
 *  in that same unit, converted from canonical cm/kg for display. */
function PackagesTable({
  cargo,
  expandedPackage,
  onTogglePackage,
}: {
  cargo: CargoDto;
  expandedPackage: Set<string>;
  onTogglePackage: (id: string) => void;
}) {
  return (
    <div className="px-4 py-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Package No</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="font-mono tabular-nums">L</TableHead>
            <TableHead className="font-mono tabular-nums">W</TableHead>
            <TableHead className="font-mono tabular-nums">H</TableHead>
            <TableHead className="font-mono tabular-nums">Gross</TableHead>
            <TableHead className="font-mono tabular-nums">Net</TableHead>
            <TableHead className="font-mono tabular-nums">Vol (CBM)</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>Contents</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cargo.packages.map((pkg) => {
            const isOpen = expandedPackage.has(pkg.id);
            return (
              <Fragment key={pkg.id}>
                <TableRow>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={`Expand package ${pkg.packageNo}`}
                      aria-expanded={isOpen}
                      onClick={() => onTogglePackage(pkg.id)}
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell>{pkg.packageNo}</TableCell>
                  <TableCell>{packageTypeLabel(pkg.packageType)}</TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {fmtNum(fromCanonicalDim(Number(pkg.dimL), cargo.dimUnit), 0)}{" "}
                    <span className="text-muted-foreground text-xs">{cargo.dimUnit}</span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {fmtNum(fromCanonicalDim(Number(pkg.dimW), cargo.dimUnit), 0)}{" "}
                    <span className="text-muted-foreground text-xs">{cargo.dimUnit}</span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {fmtNum(fromCanonicalDim(Number(pkg.dimH), cargo.dimUnit), 0)}{" "}
                    <span className="text-muted-foreground text-xs">{cargo.dimUnit}</span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {fmtNum(fromCanonicalWeight(Number(pkg.grossWt), cargo.weightUnit))}{" "}
                    <span className="text-muted-foreground text-xs">{cargo.weightUnit}</span>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {pkg.netWt !== null ? (
                      <>
                        {fmtNum(fromCanonicalWeight(Number(pkg.netWt), cargo.weightUnit))}{" "}
                        <span className="text-muted-foreground text-xs">{cargo.weightUnit}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {pkg.volumeCbm !== null ? fmtNum(Number(pkg.volumeCbm), 4) : "—"}
                  </TableCell>
                  <TableCell>
                    <ReferenceTagIcons tags={pkg.effectiveTags} />
                  </TableCell>
                  <TableCell className="max-w-xs truncate" title={contentsOf([pkg])}>
                    {contentsOf([pkg])}
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={11} className="bg-muted/50 p-0">
                      <ItemsTable pkg={pkg} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** The items sub-table for one expanded Package row. */
function ItemsTable({ pkg }: { pkg: PackageDto }) {
  if (pkg.items.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-muted-foreground">No items on this package yet.</div>
    );
  }
  return (
    <div className="px-4 py-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SN</TableHead>
            <TableHead>Product</TableHead>
            <TableHead className="font-mono tabular-nums">Qty</TableHead>
            <TableHead>UoM</TableHead>
            <TableHead>HSN</TableHead>
            <TableHead>Tags</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pkg.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="font-mono tabular-nums text-muted-foreground">
                {item.rowIndex + 1}
              </TableCell>
              <TableCell>{item.product ?? "—"}</TableCell>
              <TableCell className="font-mono tabular-nums">{item.qty ?? "—"}</TableCell>
              <TableCell>{item.uom ? uomLabel(item.uom) : "—"}</TableCell>
              <TableCell>{item.hsCode ?? "—"}</TableCell>
              <TableCell>
                <ReferenceTagIcons tags={item.tags} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
