import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  cargoCreateSchema,
  cargoUpdateSchema,
  DIM_UNITS,
  WEIGHT_UNITS,
  cargoLabel,
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCargo } from "./useCargo";
import { PackageEditor } from "./PackageEditor";

interface CargoPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryId: string;
  /** Present = edit this existing cargo (+ its packages). Absent = Add mode. */
  cargo?: CargoDto;
}

/**
 * CargoPopup (Task 13) — the nested cargo -> package -> item entry dialog. Wraps the
 * cargo-level fields (PO/Ref, label, Dimension/Weight Unit) and, once a cargoId exists,
 * a PackageEditor list (Task 14, which itself nests ItemsMiniTable, Task 15).
 *
 * Save-flow / birth order: a package write needs a real cargoId, and an item write needs
 * a real packageId (same constraint one level down, handled inside PackageEditor). Add
 * mode therefore shows ONLY the cargo fields first; saving them calls
 * useCargo(queryId).add(...) to mint the cargo, after which the Packages section appears.
 * Edit mode already has a cargoId (from the passed CargoDto) so packages are available
 * immediately. Packages/items persist on their own Save (usePackages/useItems), same as
 * the main cargo table's rows — this popup's own cargo-level Save only ever touches the
 * 4 cargo fields.
 */
export function CargoPopup({ open, onOpenChange, queryId, cargo }: CargoPopupProps) {
  const [cargoRow, setCargoRow] = useState<CargoDto | undefined>(cargo);
  const [addingPackage, setAddingPackage] = useState(false);

  const isEdit = !!cargoRow;
  const packages: PackageDto[] = cargoRow?.packages ?? [];
  const suggestedPackageNo = `P-${packages.length + 1}`;

  const handlePackageSaved = (pkg: PackageDto) => {
    setCargoRow((prev) => {
      if (!prev) return prev;
      const exists = prev.packages.some((p) => p.id === pkg.id);
      const nextPackages = exists
        ? prev.packages.map((p) => (p.id === pkg.id ? pkg : p))
        : [...prev.packages, pkg];
      return { ...prev, packages: nextPackages };
    });
    setAddingPackage(false);
  };

  const handlePackageRemoved = (pid: string) => {
    setCargoRow((prev) =>
      prev ? { ...prev, packages: prev.packages.filter((p) => p.id !== pid) } : prev,
    );
  };

  const handlePackageCopies = (clones: PackageDto[]) => {
    setCargoRow((prev) => (prev ? { ...prev, packages: [...prev.packages, ...clones] } : prev));
  };

  const handleDialogChange = (next: boolean) => {
    if (!next) setAddingPackage(false);
    onOpenChange(next);
  };

  const title = cargoRow ? `Edit ${cargoRow.poReference || cargoLabel(cargoRow)}` : "Add Cargo";

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {isEdit ? (
          <CargoEditFields queryId={queryId} cargo={cargoRow} onUpdated={setCargoRow} />
        ) : (
          <CargoAddFields queryId={queryId} onCreated={setCargoRow} />
        )}

        {cargoRow ? (
          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Packages</h3>
              {!addingPackage && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAddingPackage(true)}
                >
                  + Add Package
                </Button>
              )}
            </div>

            <div className="space-y-3">
              {packages.map((pkg) => (
                <PackageEditor
                  key={pkg.id}
                  queryId={queryId}
                  cargoId={cargoRow.id}
                  cargoDimUnit={cargoRow.dimUnit}
                  cargoWeightUnit={cargoRow.weightUnit}
                  pkg={pkg}
                  onSaved={handlePackageSaved}
                  onRemoved={handlePackageRemoved}
                  onCopies={handlePackageCopies}
                />
              ))}
              {addingPackage && (
                <PackageEditor
                  queryId={queryId}
                  cargoId={cargoRow.id}
                  cargoDimUnit={cargoRow.dimUnit}
                  cargoWeightUnit={cargoRow.weightUnit}
                  suggestedPackageNo={suggestedPackageNo}
                  onSaved={handlePackageSaved}
                  onCancelAdd={() => setAddingPackage(false)}
                />
              )}
              {packages.length === 0 && !addingPackage && (
                <p className="text-sm text-muted-foreground">
                  No packages yet. Click &quot;+ Add Package&quot; to add one.
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground border-t pt-4">
            Save the cargo above to start adding packages.
          </p>
        )}

        <div className="flex justify-end pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => handleDialogChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
