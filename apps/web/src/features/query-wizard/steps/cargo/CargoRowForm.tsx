import { useRef } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  cargoCreateSchema,
  cargoUpdateSchema,
  REFERENCE_TAGS,
  referenceTagLabel,
  DIM_UNITS,
  WEIGHT_UNITS,
  cbmFromDims,
} from "@svyft/shared";
import type { CargoCreateInput, CargoUpdateInput, CargoDto, ReferenceTag, DimUnit } from "@svyft/shared";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { useCargo } from "./useCargo";

type CargoActions = ReturnType<typeof useCargo>;

interface CargoRowFormAddProps {
  mode: "add";
  onSubmit: (input: CargoCreateInput) => Promise<void>;
  onCancel: () => void;
  uploadMsds?: never;
}

interface CargoRowFormEditProps {
  mode: "edit";
  row: CargoDto;
  onSubmit: (cid: string, input: CargoUpdateInput) => Promise<void>;
  onCancel: () => void;
  uploadMsds: CargoActions["uploadMsds"];
}

type CargoRowFormProps = CargoRowFormAddProps | CargoRowFormEditProps;

function NumericInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string | number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Input
      type="number"
      placeholder={placeholder}
      className={className}
      value={value === undefined || value === "" ? "" : String(value)}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? undefined : Number(v));
      }}
    />
  );
}

function ReferenceTags({
  value,
  onChange,
}: {
  value: ReferenceTag[];
  onChange: (v: ReferenceTag[]) => void;
}) {
  const toggle = (tag: ReferenceTag) => {
    if (value.includes(tag)) {
      onChange(value.filter((t) => t !== tag));
    } else {
      onChange([...value, tag]);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {REFERENCE_TAGS.map((tag) => (
        <label key={tag} className="flex items-center gap-1 cursor-pointer select-none text-xs">
          <Checkbox
            checked={value.includes(tag)}
            onCheckedChange={() => toggle(tag)}
          />
          <span>{referenceTagLabel(tag)}</span>
        </label>
      ))}
    </div>
  );
}

/** Live CBM preview using unit-aware cbmFromDims */
function VolumeCbmPreview({
  dimL,
  dimW,
  dimH,
  qty,
  dimUnit,
}: {
  dimL: number | undefined;
  dimW: number | undefined;
  dimH: number | undefined;
  qty: number | undefined;
  dimUnit: DimUnit;
}) {
  const hasAll = dimL && dimW && dimH && qty && dimL > 0 && dimW > 0 && dimH > 0 && qty > 0;
  const cbm = hasAll ? cbmFromDims(dimL, dimW, dimH, qty, dimUnit) : null;
  return (
    <Input
      readOnly
      aria-label="Volume (CBM)"
      className="bg-muted font-mono tabular-nums"
      value={cbm !== null ? cbm.toFixed(4) : "—"}
    />
  );
}

/** Add mode form */
function AddForm({ onSubmit, onCancel }: { onSubmit: (input: CargoCreateInput) => Promise<void>; onCancel: () => void }) {
  const form = useForm<CargoCreateInput>({
    resolver: zodResolver(cargoCreateSchema),
    defaultValues: {
      poReference: "",
      productName: "",
      referenceTags: [],
      hsCode: "",
      packageType: "",
      isDangerous: false,
      qty: undefined as unknown as number,
      dimL: undefined as unknown as number,
      dimW: undefined as unknown as number,
      dimH: undefined as unknown as number,
      netWt: undefined,
      grossWt: undefined as unknown as number,
      dimUnit: "CM",
      weightUnit: "KG",
    },
  });

  const isDangerous = useWatch({ control: form.control, name: "isDangerous" });
  const dimL = useWatch({ control: form.control, name: "dimL" });
  const dimW = useWatch({ control: form.control, name: "dimW" });
  const dimH = useWatch({ control: form.control, name: "dimH" });
  const qty = useWatch({ control: form.control, name: "qty" });
  const dimUnit = useWatch({ control: form.control, name: "dimUnit" }) ?? "CM";

  const handleSubmit = form.handleSubmit(async (data) => {
    await onSubmit(data);
    form.reset();
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* PO / Reference */}
          <FormField
            control={form.control}
            name="poReference"
            render={({ field }) => (
              <FormItem>
                <FormLabel>PO / Reference</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="PO-001" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Product Name */}
          <FormField
            control={form.control}
            name="productName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Product Name <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <Input {...field} placeholder="Product name" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* HS Code */}
          <FormField
            control={form.control}
            name="hsCode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>HS / HSN Code</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ""} placeholder="8471.30" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Package Type */}
          <FormField
            control={form.control}
            name="packageType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Package Type <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <Input {...field} placeholder="Carton / Pallet / …" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Reference Tags */}
        <FormField
          control={form.control}
          name="referenceTags"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Reference Tags</FormLabel>
              <FormControl>
                <ReferenceTags value={field.value ?? []} onChange={field.onChange} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* DG checkbox */}
        <FormField
          control={form.control}
          name="isDangerous"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value ?? false}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <FormLabel className="cursor-pointer">Dangerous Goods (DG)</FormLabel>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* MSDS file input — shown when DG is ticked (but in add mode, upload happens after row is saved) */}
        {isDangerous && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-700">
            MSDS PDF required for DG cargo. Save this row first, then upload the MSDS from the table.
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {/* Qty */}
          <FormField
            control={form.control}
            name="qty"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Qty <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <NumericInput
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="1"
                    className="font-mono tabular-nums"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Dim L */}
          <FormField
            control={form.control}
            name="dimL"
            render={({ field }) => (
              <FormItem>
                <FormLabel>L <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <NumericInput value={field.value} onChange={field.onChange} placeholder="100" className="font-mono tabular-nums" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Dim W */}
          <FormField
            control={form.control}
            name="dimW"
            render={({ field }) => (
              <FormItem>
                <FormLabel>W <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <NumericInput value={field.value} onChange={field.onChange} placeholder="50" className="font-mono tabular-nums" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Dim H */}
          <FormField
            control={form.control}
            name="dimH"
            render={({ field }) => (
              <FormItem>
                <FormLabel>H <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <NumericInput value={field.value} onChange={field.onChange} placeholder="50" className="font-mono tabular-nums" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Dimension Unit */}
          <FormField
            control={form.control}
            name="dimUnit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Unit</FormLabel>
                <Select value={field.value ?? "CM"} onValueChange={field.onChange}>
                  <SelectTrigger aria-label="Dimension unit"><SelectValue /></SelectTrigger>
                  <SelectContent>{DIM_UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                </Select>
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {/* Net Wt */}
          <FormField
            control={form.control}
            name="netWt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Net Wt</FormLabel>
                <FormControl>
                  <NumericInput value={field.value ?? undefined} onChange={field.onChange} placeholder="50" className="font-mono tabular-nums" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Gross Wt */}
          <FormField
            control={form.control}
            name="grossWt"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Gross Wt <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <NumericInput value={field.value} onChange={field.onChange} placeholder="60" className="font-mono tabular-nums" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Weight Unit */}
          <FormField
            control={form.control}
            name="weightUnit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Unit</FormLabel>
                <Select value={field.value ?? "KG"} onValueChange={field.onChange}>
                  <SelectTrigger aria-label="Weight unit"><SelectValue /></SelectTrigger>
                  <SelectContent>{WEIGHT_UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                </Select>
              </FormItem>
            )}
          />

          {/* Volume CBM (live preview) */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Volume (CBM)</label>
            <VolumeCbmPreview dimL={dimL} dimW={dimW} dimH={dimH} qty={qty} dimUnit={dimUnit as DimUnit} />
          </div>
        </div>

        {/* Stage-4 read-only placeholder columns */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Freight Density</label>
            <Input readOnly className="bg-muted font-mono tabular-nums text-muted-foreground" value="" placeholder="Stage 4" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Chargeable Wt</label>
            <Input readOnly className="bg-muted font-mono tabular-nums text-muted-foreground" value="" placeholder="Stage 4" />
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            Save
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** Edit mode form for an existing cargo row */
function EditForm({
  row,
  onSubmit,
  onCancel,
  uploadMsds,
}: {
  row: CargoDto;
  onSubmit: (cid: string, input: CargoUpdateInput) => Promise<void>;
  onCancel: () => void;
  uploadMsds: CargoActions["uploadMsds"];
}) {
  const form = useForm<CargoUpdateInput>({
    resolver: zodResolver(cargoUpdateSchema),
    defaultValues: {
      poReference: row.poReference,
      productName: row.productName,
      referenceTags: row.referenceTags,
      hsCode: row.hsCode ?? undefined,
      packageType: row.packageType,
      isDangerous: row.isDangerous,
      qty: row.qty,
      dimL: Number(row.dimL),
      dimW: Number(row.dimW),
      dimH: Number(row.dimH),
      netWt: row.netWt !== null ? Number(row.netWt) : undefined,
      grossWt: Number(row.grossWt),
      dimUnit: row.dimUnit,
      weightUnit: row.weightUnit,
    },
  });

  const isDangerous = useWatch({ control: form.control, name: "isDangerous" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = form.handleSubmit(async (data) => {
    await onSubmit(row.id, data);
  });

  const handleMsdsChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadMsds(row.id, file);
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const cbm = row.volumeCbm !== null ? Number(row.volumeCbm) : null;

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField control={form.control} name="poReference" render={({ field }) => (
            <FormItem>
              <FormLabel>PO / Reference</FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="productName" render={({ field }) => (
            <FormItem>
              <FormLabel>Product Name <span className="text-destructive">*</span></FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="hsCode" render={({ field }) => (
            <FormItem>
              <FormLabel>HS / HSN Code</FormLabel>
              <FormControl><Input {...field} value={field.value ?? ""} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="packageType" render={({ field }) => (
            <FormItem>
              <FormLabel>Package Type <span className="text-destructive">*</span></FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        <FormField control={form.control} name="referenceTags" render={({ field }) => (
          <FormItem>
            <FormLabel>Reference Tags</FormLabel>
            <FormControl>
              <ReferenceTags value={field.value ?? []} onChange={field.onChange} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="isDangerous" render={({ field }) => (
          <FormItem className="flex items-center gap-2 space-y-0">
            <FormControl>
              <Checkbox checked={field.value ?? false} onCheckedChange={field.onChange} />
            </FormControl>
            <FormLabel className="cursor-pointer">Dangerous Goods (DG)</FormLabel>
            <FormMessage />
          </FormItem>
        )} />

        {isDangerous && (
          <div className="space-y-2">
            <label className="text-sm font-medium">
              MSDS (PDF){row.msdsFileId ? " — uploaded ✓" : " — required"}
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

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <FormField control={form.control} name="qty" render={({ field }) => (
            <FormItem>
              <FormLabel>Qty <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <NumericInput value={field.value} onChange={field.onChange} className="font-mono tabular-nums" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="dimL" render={({ field }) => (
            <FormItem>
              <FormLabel>L</FormLabel>
              <FormControl>
                <NumericInput value={field.value} onChange={field.onChange} className="font-mono tabular-nums" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="dimW" render={({ field }) => (
            <FormItem>
              <FormLabel>W</FormLabel>
              <FormControl>
                <NumericInput value={field.value} onChange={field.onChange} className="font-mono tabular-nums" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="dimH" render={({ field }) => (
            <FormItem>
              <FormLabel>H</FormLabel>
              <FormControl>
                <NumericInput value={field.value} onChange={field.onChange} className="font-mono tabular-nums" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          {/* Dimension Unit */}
          <FormField control={form.control} name="dimUnit" render={({ field }) => (
            <FormItem>
              <FormLabel>Unit</FormLabel>
              <Select value={field.value ?? "CM"} onValueChange={field.onChange}>
                <SelectTrigger aria-label="Dimension unit"><SelectValue /></SelectTrigger>
                <SelectContent>{DIM_UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </FormItem>
          )} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <FormField control={form.control} name="netWt" render={({ field }) => (
            <FormItem>
              <FormLabel>Net Wt</FormLabel>
              <FormControl>
                <NumericInput value={field.value ?? undefined} onChange={field.onChange} className="font-mono tabular-nums" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="grossWt" render={({ field }) => (
            <FormItem>
              <FormLabel>Gross Wt <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <NumericInput value={field.value} onChange={field.onChange} className="font-mono tabular-nums" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          {/* Weight Unit */}
          <FormField control={form.control} name="weightUnit" render={({ field }) => (
            <FormItem>
              <FormLabel>Unit</FormLabel>
              <Select value={field.value ?? "KG"} onValueChange={field.onChange}>
                <SelectTrigger aria-label="Weight unit"><SelectValue /></SelectTrigger>
                <SelectContent>{WEIGHT_UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </FormItem>
          )} />

          <div className="space-y-2">
            <label className="text-sm font-medium">Volume (CBM)</label>
            <Input
              readOnly
              aria-label="Volume (CBM)"
              className="bg-muted font-mono tabular-nums"
              value={cbm !== null ? cbm.toFixed(4) : "—"}
            />
          </div>
        </div>

        {/* Stage-4 placeholder columns */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Freight Density</label>
            <Input readOnly className="bg-muted font-mono tabular-nums text-muted-foreground" value="" placeholder="Stage 4" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Chargeable Wt</label>
            <Input readOnly className="bg-muted font-mono tabular-nums text-muted-foreground" value="" placeholder="Stage 4" />
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="submit" size="sm">Save</Button>
        </div>
      </form>
    </Form>
  );
}

/**
 * CargoRowForm — renders either an "add" form (mode="add") or an "edit" inline
 * form (mode="edit") for a saved cargo row.
 */
export function CargoRowForm(props: CargoRowFormProps) {
  if (props.mode === "add") {
    return <AddForm onSubmit={props.onSubmit} onCancel={props.onCancel} />;
  }
  return (
    <EditForm
      row={props.row}
      onSubmit={props.onSubmit}
      onCancel={props.onCancel}
      uploadMsds={props.uploadMsds}
    />
  );
}
