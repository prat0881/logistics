import { Fragment, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  cargoCreateSchema,
  cargoUpdateSchema,
  DIM_UNITS,
  WEIGHT_UNITS,
  cargoLabel,
  packageTypeLabel,
  fromCanonicalDim,
  fromCanonicalWeight,
} from "@svyft/shared";
import type { CargoCreateInput, CargoUpdateInput, CargoDto, PackageDto } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";
import { useCargo } from "./useCargo";
import { usePackages } from "./usePackages";
import { PackageEditor } from "./PackageEditor";

interface CargoPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  /** Present = edit this existing cargo (+ its packages). Absent = Add mode. */
  cargo?: CargoDto;
  /**
   * Every packageNo already in use ACROSS THE WHOLE QUERY (all cargos). Package No is
   * unique per query (V-5), and the FF sees packages with no cargo context — so numbers
   * must stay unambiguous query-wide. Used to auto-suggest the next free "P-N" so adding a
   * package to a second cargo never collides with the first.
   */
  existingPackageNos?: string[];
}

/** Next free "P-N" across the whole query — the max numeric suffix + 1 (defaults to P-1). */
function nextPackageNo(nos: string[]): string {
  let max = 0;
  for (const n of nos) {
    const m = /^P-(\d+)$/i.exec(n.trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `P-${max + 1}`;
}

/**
 * CargoPopup (Task 13, redesigned) — the cargo → package → item entry dialog.
 *
 * Cargo-level fields on top; once a cargoId exists, a compact PACKAGE TABLE. Each package is
 * a read-only summary row (No / Type / dims / weights / CBM / tags / item count) with inline
 * Edit + Remove; Edit expands the row into the full PackageEditor (fields + its ItemsMiniTable)
 * so items live under their package. "+ Add package" reveals an inline add form pre-filled with
 * the next query-wide packageNo. This mirrors the item table one level up — add/edit/remove in
 * place — instead of stacking an always-open form per package.
 *
 * Save-flow / birth order: a package write needs a real cargoId (and an item write a real
 * packageId, handled inside PackageEditor). Add mode shows ONLY the cargo fields first; saving
 * mints the cargo, after which the package table appears. Packages/items persist on their own
 * Save (usePackages/useItems); this popup's cargo-level Save only touches the 4 cargo fields.
 */
export function CargoPopup({
  open,
  onOpenChange,
  queryId,
  cargo,
  existingPackageNos = [],
}: CargoPopupProps) {
  const [cargoRow, setCargoRow] = useState<CargoDto | undefined>(cargo);

  const isEdit = !!cargoRow;

  const handlePackageSaved = (pkg: PackageDto) => {
    setCargoRow((prev) => {
      if (!prev) return prev;
      const exists = prev.packages.some((p) => p.id === pkg.id);
      const nextPackages = exists
        ? prev.packages.map((p) => (p.id === pkg.id ? pkg : p))
        : [...prev.packages, pkg];
      return { ...prev, packages: nextPackages };
    });
  };

  const handlePackageRemoved = (pid: string) => {
    setCargoRow((prev) =>
      prev ? { ...prev, packages: prev.packages.filter((p) => p.id !== pid) } : prev,
    );
  };

  const handlePackageCopies = (clones: PackageDto[]) => {
    setCargoRow((prev) => (prev ? { ...prev, packages: [...prev.packages, ...clones] } : prev));
  };

  const title = cargoRow ? `Edit ${cargoRow.poReference || cargoLabel(cargoRow)}` : "Add Cargo";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {isEdit ? (
          <CargoEditFields queryId={queryId} cargo={cargoRow} onUpdated={setCargoRow} />
        ) : (
          <CargoAddFields queryId={queryId} onCreated={setCargoRow} />
        )}

        {cargoRow ? (
          <PackagesTable
            queryId={queryId}
            cargo={cargoRow}
            existingPackageNos={existingPackageNos}
            onSaved={handlePackageSaved}
            onRemoved={handlePackageRemoved}
            onCopies={handlePackageCopies}
          />
        ) : (
          <p className="text-sm text-muted-foreground border-t pt-4">
            Save the cargo above to start adding packages.
          </p>
        )}

        <div className="flex justify-end pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The compact package table for one cargo: summary rows with inline Edit/Remove (Edit expands
 *  the full PackageEditor + its items), plus a "+ Add package" inline form. */
function PackagesTable({
  queryId,
  cargo,
  existingPackageNos,
  onSaved,
  onRemoved,
  onCopies,
}: {
  queryId: string;
  cargo: CargoDto;
  existingPackageNos: string[];
  onSaved: (pkg: PackageDto) => void;
  onRemoved: (packageId: string) => void;
  onCopies: (clones: PackageDto[]) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const packageActions = usePackages(queryId, cargo.id);

  const packages = cargo.packages;
  const suggestedPackageNo = nextPackageNo([
    ...existingPackageNos,
    ...packages.map((p) => p.packageNo),
  ]);

  const dim = (canonical: string) => fromCanonicalDim(Number(canonical), cargo.dimUnit);
  const wt = (canonical: string | null) =>
    canonical === null ? null : fromCanonicalWeight(Number(canonical), cargo.weightUnit);

  const handleRemoveRow = async (pkg: PackageDto) => {
    if (!window.confirm(`Remove package ${pkg.packageNo}?`)) return;
    try {
      setRowError(null);
      await packageActions.remove(pkg.id);
      if (expandedId === pkg.id) setExpandedId(null);
      onRemoved(pkg.id);
    } catch (e) {
      setRowError(e instanceof ApiError ? e.message : "Remove failed");
    }
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Packages</h3>
        {!adding && (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            + Add package
          </Button>
        )}
      </div>

      {rowError && (
        <p role="alert" className="text-sm text-destructive">
          {rowError}
        </p>
      )}

      {packages.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>No</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">L×W×H ({cargo.dimUnit})</TableHead>
                <TableHead className="text-right">Gross ({cargo.weightUnit})</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">CBM</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {packages.map((pkg) => {
                const netWt = wt(pkg.netWt);
                return (
                  <Fragment key={pkg.id}>
                    <TableRow>
                      <TableCell className="font-mono">{pkg.packageNo}</TableCell>
                      <TableCell>{packageTypeLabel(pkg.packageType)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {dim(pkg.dimL)}×{dim(pkg.dimW)}×{dim(pkg.dimH)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {wt(pkg.grossWt)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {netWt ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {pkg.volumeCbm ?? "—"}
                      </TableCell>
                      <TableCell>
                        <ReferenceTagIcons tags={pkg.effectiveTags} />
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {pkg.items.length}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-expanded={expandedId === pkg.id}
                            onClick={() => setExpandedId((cur) => (cur === pkg.id ? null : pkg.id))}
                          >
                            {expandedId === pkg.id ? "Close" : "Edit"}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => handleRemoveRow(pkg)}
                          >
                            Remove
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedId === pkg.id && (
                      <TableRow>
                        <TableCell colSpan={9} className="bg-muted/30">
                          <PackageEditor
                            queryId={queryId}
                            cargoId={cargo.id}
                            cargoDimUnit={cargo.dimUnit}
                            cargoWeightUnit={cargo.weightUnit}
                            pkg={pkg}
                            onSaved={onSaved}
                            onRemoved={(id) => {
                              setExpandedId(null);
                              onRemoved(id);
                            }}
                            onCopies={onCopies}
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
      )}

      {adding && (
        <PackageEditor
          queryId={queryId}
          cargoId={cargo.id}
          cargoDimUnit={cargo.dimUnit}
          cargoWeightUnit={cargo.weightUnit}
          suggestedPackageNo={suggestedPackageNo}
          onSaved={(pkg) => {
            setAdding(false);
            onSaved(pkg);
          }}
          onCancelAdd={() => setAdding(false)}
        />
      )}

      {packages.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">
          No packages yet. Click &quot;+ Add package&quot; to add one.
        </p>
      )}
    </div>
  );
}

/** Add-mode cargo fields — persists via useCargo(queryId).add(...) to mint a real cargoId
 * (birth order: packages need it). Mirrors the retired CargoRowForm's AddForm/EditForm
 * split — a fixed-mode component keeps react-hook-form's zodResolver type simple (no
 * union of Create/Update input shapes in one useForm<T> call). */
function CargoAddFields({
  queryId,
  onCreated,
}: {
  queryId: string;
  onCreated: (cargo: CargoDto) => void;
}) {
  const cargoActions = useCargo(queryId);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<CargoCreateInput>({
    resolver: zodResolver(cargoCreateSchema),
    defaultValues: { poReference: "", label: "", dimUnit: "CM", weightUnit: "KG" },
  });

  const handleSubmit = form.handleSubmit(async (data) => {
    try {
      setError(null);
      const created = await cargoActions.add(data);
      onCreated(created);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save failed");
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <CargoFieldRows control={form.control} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="sm">
            Save
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** Edit-mode cargo fields — PATCHes via useCargo(queryId).update(cargo.id, ...). */
function CargoEditFields({
  queryId,
  cargo,
  onUpdated,
}: {
  queryId: string;
  cargo: CargoDto;
  onUpdated: (cargo: CargoDto) => void;
}) {
  const cargoActions = useCargo(queryId);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<CargoUpdateInput>({
    resolver: zodResolver(cargoUpdateSchema),
    defaultValues: {
      poReference: cargo.poReference ?? "",
      label: cargo.label ?? "",
      dimUnit: cargo.dimUnit,
      weightUnit: cargo.weightUnit,
    },
  });

  const handleSubmit = form.handleSubmit(async (data) => {
    try {
      setError(null);
      const updated = await cargoActions.update(cargo.id, data);
      onUpdated(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save failed");
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <CargoFieldRows control={form.control} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="sm">
            Save
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** The 4 cargo-level field rows, shared by Add/Edit (each wraps it in its own
 * fixed-type <Form>/<form onSubmit>). */
function CargoFieldRows<T extends CargoCreateInput | CargoUpdateInput>({
  control,
}: {
  control: import("react-hook-form").Control<T>;
}) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField
          control={control}
          name={"poReference" as import("react-hook-form").Path<T>}
          render={({ field }) => (
            <FormItem>
              <FormLabel>PO / Reference</FormLabel>
              <FormControl>
                <Input {...field} value={(field.value as string) ?? ""} placeholder="PO-001" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={"label" as import("react-hook-form").Path<T>}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Label</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  value={(field.value as string) ?? ""}
                  placeholder="Optional label"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={control}
          name={"dimUnit" as import("react-hook-form").Path<T>}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Dimension Unit</FormLabel>
              <Select value={(field.value as string) ?? "CM"} onValueChange={field.onChange}>
                <SelectTrigger aria-label="Dimension Unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIM_UNITS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={"weightUnit" as import("react-hook-form").Path<T>}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Weight Unit</FormLabel>
              <Select value={(field.value as string) ?? "KG"} onValueChange={field.onChange}>
                <SelectTrigger aria-label="Weight Unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEIGHT_UNITS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </>
  );
}
