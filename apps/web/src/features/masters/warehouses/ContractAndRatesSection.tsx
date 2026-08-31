import { Controller, type Control, type FieldErrors, type UseFormRegister } from "react-hook-form";
import { CURRENCIES, HANDLING_UNITS, STORAGE_UNITS, type WarehouseCreateInput } from "@svyft/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const sectionTitleClass = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

// Converts a plain <input type="date"> value ("YYYY-MM-DD") to the ISO datetime string the
// schema's z.string().datetime() expects, and back. Warehouses don't have a per-record
// timezone (unlike legs/points), so midnight UTC is the simplest, unambiguous round trip —
// there's no ZonedDateTimeField-style "zone" concept to anchor this to.
function dateToIso(v: string): string | undefined {
  return v ? `${v}T00:00:00.000Z` : undefined;
}
function isoToDate(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : "";
}

interface Props {
  control: Control<WarehouseCreateInput>;
  register: UseFormRegister<WarehouseCreateInput>;
  errors: FieldErrors<WarehouseCreateInput>;
}

/**
 * The contract- and rate-specific fields, shown only for OWNED/CONTRACTED warehouses
 * (`CONTRACTED_TYPES` in the caller). Split out of WarehouseFormPage because this block alone
 * was pushing that file past 400 lines against ~100 for each sibling master form.
 *
 * Per-field inline `role="alert"` errors, not a single form-level summary: with ~20 inputs on
 * this form, an error needs to be associated with its field both visually and for a screen
 * reader (proximity + DOM order), which a page-level summary can't provide. This also matches
 * every sibling master form (Client/Vessel/FreightForwarder) and `ContactsSection`/`VehiclesSection`
 * within this same feature.
 */
export function ContractAndRatesSection({ control, register, errors }: Props) {
  const err = (name: keyof WarehouseCreateInput) =>
    errors[name] ? (
      <p role="alert" className="text-sm text-destructive">
        {errors[name]?.message as string}
      </p>
    ) : null;

  return (
    <section className="space-y-3">
      <h2 className={sectionTitleClass}>Contract &amp; rates</h2>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="agreementValidUntil">Agreement valid until</Label>
          <Controller
            control={control}
            name="agreementValidUntil"
            render={({ field }) => (
              <Input
                id="agreementValidUntil"
                type="date"
                value={isoToDate(field.value as string | undefined)}
                onChange={(e) => field.onChange(dateToIso(e.target.value))}
              />
            )}
          />
          {err("agreementValidUntil")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="insuranceValidUntil">Insurance valid until</Label>
          <Controller
            control={control}
            name="insuranceValidUntil"
            render={({ field }) => (
              <Input
                id="insuranceValidUntil"
                type="date"
                value={isoToDate(field.value as string | undefined)}
                onChange={(e) => field.onChange(dateToIso(e.target.value))}
              />
            )}
          />
          {err("insuranceValidUntil")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="freeStorageDays">Free storage days</Label>
          <Input
            id="freeStorageDays"
            type="number"
            {...register("freeStorageDays", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
          {err("freeStorageDays")}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...register("isBonded")} /> Bonded warehouse
        </label>
        <div className="space-y-1">
          <Label htmlFor="weekendWorkingFee">Weekend working fee</Label>
          <Input
            id="weekendWorkingFee"
            type="number"
            step="any"
            {...register("weekendWorkingFee", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
          {err("weekendWorkingFee")}
        </div>
      </div>

      <h3 className="text-sm font-medium text-foreground">Rate card</h3>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="rateCurrency">Rate currency</Label>
          <select
            id="rateCurrency"
            {...register("rateCurrency", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
            className={selectClass}
          >
            <option value="">—</option>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
          {err("rateCurrency")}
        </div>
        <div />
        <div className="space-y-1">
          <Label htmlFor="handlingRate">Handling rate</Label>
          <Input
            id="handlingRate"
            type="number"
            step="any"
            {...register("handlingRate", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
          {err("handlingRate")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="handlingUnit">Handling unit</Label>
          <select
            id="handlingUnit"
            {...register("handlingUnit", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
            className={selectClass}
          >
            <option value="">—</option>
            {HANDLING_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          {err("handlingUnit")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="storageRate">Storage rate</Label>
          <Input
            id="storageRate"
            type="number"
            step="any"
            {...register("storageRate", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
          {err("storageRate")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="storageUnit">Storage unit</Label>
          <select
            id="storageUnit"
            {...register("storageUnit", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
            className={selectClass}
          >
            <option value="">—</option>
            {STORAGE_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          {err("storageUnit")}
        </div>
      </div>
    </section>
  );
}
