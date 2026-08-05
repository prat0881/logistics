import { useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  packageCreateSchema,
  packageUpdateSchema,
  PACKAGE_TYPES,
  packageTypeLabel,
  effectiveTags,
  fromCanonicalDim,
  fromCanonicalWeight,
} from "@svyft/shared";
import type {
  PackageCreateInput,
  PackageUpdateInput,
  PackageDto,
  ItemDto,
  DimUnit,
  WeightUnit,
} from "@svyft/shared";
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
import { NumericInput, ReferenceTags, VolumeCbmPreview } from "./cargo-form-fields";
import { usePackages } from "./usePackages";
import { ItemsMiniTable } from "./ItemsMiniTable";

interface PackageEditorProps {
  queryId: string;
  cargoId: string;
  cargoDimUnit: DimUnit;
  cargoWeightUnit: WeightUnit;
  /** Present = edit this existing package (+ its items). Absent = a fresh draft row. */
  pkg?: PackageDto;
  /** Add-mode only: a starting suggestion for packageNo (stays fully editable). */
  suggestedPackageNo?: string;
  onSaved: (pkg: PackageDto) => void;
  onRemoved?: (packageId: string) => void;
  onCopies?: (clones: PackageDto[]) => void;
  onCancelAdd?: () => void;
}

/**
 * PackageEditor (Task 14) — one package's fields + its ItemsMiniTable (Task 15).
 *
 * Dispatches to a fixed-mode Add/Edit form, mirroring the retired CargoRowForm's
 * AddForm/EditForm split: react-hook-form's zodResolver type is fixed per mounted
 * instance (packageCreateSchema vs packageUpdateSchema produce different TS shapes), and
 * `pkg` never flips within one instance's lifetime — CargoPopup mounts a *fresh*
 * PackageEditor once a draft is saved (the draft slot unmounts; the new saved package
 * renders as its own row), so a single component body never needs to switch resolvers
 * across renders.
 */
export function PackageEditor(props: PackageEditorProps) {
  if (!props.pkg) {
    return (
      <PackageAddForm
        queryId={props.queryId}
        cargoId={props.cargoId}
        cargoDimUnit={props.cargoDimUnit}
        cargoWeightUnit={props.cargoWeightUnit}
        suggestedPackageNo={props.suggestedPackageNo}
        onSaved={props.onSaved}
        onCancelAdd={props.onCancelAdd}
      />
    );
  }
  return (
    <PackageEditForm
      queryId={props.queryId}
      cargoId={props.cargoId}
      cargoDimUnit={props.cargoDimUnit}
      cargoWeightUnit={props.cargoWeightUnit}
      pkg={props.pkg}
      onSaved={props.onSaved}
      onRemoved={props.onRemoved}
      onCopies={props.onCopies}
    />
  );
}

function PackageAddForm({
  queryId,
  cargoId,
  cargoDimUnit,
  cargoWeightUnit,
  suggestedPackageNo,
  onSaved,
  onCancelAdd,
}: {
  queryId: string;
  cargoId: string;
  cargoDimUnit: DimUnit;
  cargoWeightUnit: WeightUnit;
  suggestedPackageNo?: string;
  onSaved: (pkg: PackageDto) => void;
  onCancelAdd?: () => void;
}) {
  const packageActions = usePackages(queryId, cargoId);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<PackageCreateInput>({
    resolver: zodResolver(packageCreateSchema),
    defaultValues: {
      packageNo: suggestedPackageNo ?? "",
      packageType: undefined as unknown as PackageCreateInput["packageType"],
      dimL: undefined as unknown as number,
      dimW: undefined as unknown as number,
      dimH: undefined as unknown as number,
      grossWt: undefined as unknown as number,
      netWt: undefined,
      tags: [],
    },
  });

  const dimL = useWatch({ control: form.control, name: "dimL" });
  const dimW = useWatch({ control: form.control, name: "dimW" });
  const dimH = useWatch({ control: form.control, name: "dimH" });
  const tags = useWatch({ control: form.control, name: "tags" }) ?? [];
  const isEffectivelyDG = effectiveTags({ tags, items: [] }).includes("DG");

  const handleSubmit = form.handleSubmit(async (data) => {
    try {
      setError(null);
      const created = await packageActions.add(data);
      onSaved(created);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save failed");
    }
  });

  return (
    <div className="rounded-md border p-3 space-y-3">
      <Form {...form}>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <FormField
              control={form.control}
              name="packageNo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Package No</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="P-1" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="packageType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Package Type</FormLabel>
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger aria-label="Package Type">
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {PACKAGE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {packageTypeLabel(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="grossWt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Gross Wt</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="420"
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="netWt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Net Wt</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Dims/weights are entered in the cargo&apos;s own unit ({cargoDimUnit} /{" "}
            {cargoWeightUnit}).
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <FormField
              control={form.control}
              name="dimL"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>L</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dimW"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>W</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dimH"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>H</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <label className="text-sm font-medium">Volume (CBM)</label>
              <VolumeCbmPreview dimL={dimL} dimW={dimW} dimH={dimH} dimUnit={cargoDimUnit} />
            </div>
          </div>

          <FormField
            control={form.control}
            name="tags"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tags</FormLabel>
                <FormControl>
                  <div data-testid="package-tags">
                    <ReferenceTags value={field.value ?? []} onChange={field.onChange} />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {isEffectivelyDG && (
            <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2">
              <label className="text-sm font-medium" htmlFor="msds-draft-input">
                MSDS (PDF)
              </label>
              <input
                id="msds-draft-input"
                type="file"
                accept="application/pdf"
                aria-label="Upload MSDS PDF"
                disabled
                className="block text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Save this package first, then upload the MSDS.
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2 justify-end">
            {onCancelAdd && (
              <Button type="button" variant="ghost" size="sm" onClick={onCancelAdd}>
                Cancel
              </Button>
            )}
            <Button type="submit" size="sm">
              Save Package
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

function PackageEditForm({
  queryId,
  cargoId,
  cargoDimUnit,
  cargoWeightUnit,
  pkg,
  onSaved,
  onRemoved,
  onCopies,
}: {
  queryId: string;
  cargoId: string;
  cargoDimUnit: DimUnit;
  cargoWeightUnit: WeightUnit;
  pkg: PackageDto;
  onSaved: (pkg: PackageDto) => void;
  onRemoved?: (packageId: string) => void;
  onCopies?: (clones: PackageDto[]) => void;
}) {
  const packageActions = usePackages(queryId, cargoId);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ItemDto[]>(pkg.items);
  const [msdsFileId, setMsdsFileId] = useState<string | null>(pkg.msdsFileId);
  const [copyCount, setCopyCount] = useState(2);
  const [copyError, setCopyError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<PackageUpdateInput>({
    resolver: zodResolver(packageUpdateSchema),
    defaultValues: {
      packageNo: pkg.packageNo,
      packageType: pkg.packageType,
      dimL: fromCanonicalDim(Number(pkg.dimL), cargoDimUnit),
      dimW: fromCanonicalDim(Number(pkg.dimW), cargoDimUnit),
      dimH: fromCanonicalDim(Number(pkg.dimH), cargoDimUnit),
      grossWt: fromCanonicalWeight(Number(pkg.grossWt), cargoWeightUnit),
      netWt: pkg.netWt !== null ? fromCanonicalWeight(Number(pkg.netWt), cargoWeightUnit) : null,
      tags: pkg.tags,
    },
  });

  const dimL = useWatch({ control: form.control, name: "dimL" });
  const dimW = useWatch({ control: form.control, name: "dimW" });
  const dimH = useWatch({ control: form.control, name: "dimH" });
  const tags = useWatch({ control: form.control, name: "tags" }) ?? [];
  const isEffectivelyDG = effectiveTags({ tags, items }).includes("DG");

  const handleSubmit = form.handleSubmit(async (data) => {
    try {
      setError(null);
      const updated = await packageActions.update(pkg.id, data);
      setItems(updated.items);
      setMsdsFileId(updated.msdsFileId);
      onSaved(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save failed");
    }
  });

  const handleRemove = async () => {
    if (!window.confirm(`Remove package ${pkg.packageNo}?`)) return;
    try {
      setError(null);
      await packageActions.remove(pkg.id);
      onRemoved?.(pkg.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Remove failed");
    }
  };

  const handleMsdsChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setError(null);
      const updated = await packageActions.uploadMsds(pkg.id, file);
      setMsdsFileId(updated.msdsFileId);
      setItems(updated.items);
      onSaved(updated);
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : "Upload failed");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleCopy = async () => {
    try {
      setCopyError(null);
      const clones = await packageActions.copy(pkg.id, copyCount);
      onCopies?.(clones);
    } catch (e) {
      setCopyError(e instanceof ApiError ? e.message : "Copy failed");
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-3">
      <Form {...form}>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <FormField
              control={form.control}
              name="packageNo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Package No</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="packageType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Package Type</FormLabel>
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger aria-label="Package Type">
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {PACKAGE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {packageTypeLabel(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="grossWt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Gross Wt</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="netWt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Net Wt</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Dims/weights are entered in the cargo&apos;s own unit ({cargoDimUnit} /{" "}
            {cargoWeightUnit}).
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <FormField
              control={form.control}
              name="dimL"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>L</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dimW"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>W</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dimH"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>H</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      className="font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <label className="text-sm font-medium">Volume (CBM)</label>
              <VolumeCbmPreview
                dimL={dimL ?? undefined}
                dimW={dimW ?? undefined}
                dimH={dimH ?? undefined}
                dimUnit={cargoDimUnit}
              />
            </div>
          </div>

          <FormField
            control={form.control}
            name="tags"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tags</FormLabel>
                <FormControl>
                  <div data-testid="package-tags">
                    <ReferenceTags value={field.value ?? []} onChange={field.onChange} />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {isEffectivelyDG && (
            <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2">
              <label className="text-sm font-medium">
                MSDS (PDF){msdsFileId ? " — uploaded" : " — required"}
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                aria-label="Upload MSDS PDF"
                onChange={handleMsdsChange}
                className="block text-sm"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="flex items-center gap-2">
              <NumericInput
                value={copyCount}
                onChange={(v) => setCopyCount(v ?? 2)}
                ariaLabel="Number of copies"
                className="h-8 w-16 font-mono tabular-nums"
              />
              <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
                Add N copies
              </Button>
              {copyError && (
                <p role="alert" className="text-xs text-destructive">
                  {copyError}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="destructive" size="sm" onClick={handleRemove}>
                Remove
              </Button>
              <Button type="submit" size="sm">
                Save
              </Button>
            </div>
          </div>
        </form>
      </Form>

      <div className="border-t pt-3">
        <ItemsMiniTable
          queryId={queryId}
          cargoId={cargoId}
          packageId={pkg.id}
          items={items}
          onItemsChange={setItems}
        />
      </div>
    </div>
  );
}
