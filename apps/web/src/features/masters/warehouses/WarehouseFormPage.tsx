import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import {
  warehouseCreateSchema,
  WAREHOUSE_MASTER_TYPES,
  CAPACITY_UNITS,
  HANDLING_UNITS,
  STORAGE_UNITS,
  WAREHOUSE_CAPABILITIES,
  CONTRACTED_TYPES,
  CURRENCIES,
  warehouseVehicleSchema,
  type WarehouseCreateInput,
  type WarehouseVehicleInput,
} from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useWarehouse } from "../useMasters";
import { ContactList } from "../ContactList";
import { Button } from "@/components/ui/button";
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

function VehicleSubForm({ id }: { id: string }) {
  const qc = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<WarehouseVehicleInput>({ resolver: zodResolver(warehouseVehicleSchema) });

  async function onAdd(values: WarehouseVehicleInput) {
    await postJson(`/api/warehouses/${id}/vehicles`, values);
    reset();
    await qc.invalidateQueries({ queryKey: ["warehouse", id] });
  }

  return (
    <form onSubmit={handleSubmit(onAdd)} className="flex flex-wrap items-end gap-3" aria-label="Add vehicle">
      <div className="space-y-1">
        <Label htmlFor="vehicle-tonnage">Tonnage</Label>
        <Input id="vehicle-tonnage" placeholder="10T" {...register("tonnage")} />
        {errors.tonnage && (
          <p role="alert" className="text-sm text-destructive">{errors.tonnage.message}</p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="vehicle-quantity">Quantity</Label>
        <Input
          id="vehicle-quantity"
          type="number"
          {...register("quantity", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
        />
        {errors.quantity && (
          <p role="alert" className="text-sm text-destructive">{errors.quantity.message}</p>
        )}
      </div>
      <Button type="submit" disabled={isSubmitting} variant="outline">
        Add vehicle
      </Button>
    </form>
  );
}

export function WarehouseFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useWarehouse(id);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<WarehouseCreateInput>({
    resolver: zodResolver(warehouseCreateSchema),
    defaultValues: { capabilities: [], isBonded: false, weekendWorking: false, freeStorageDays: 0 },
  });

  const type = useWatch({ control, name: "type" });
  const isContracted = CONTRACTED_TYPES.includes(type as (typeof CONTRACTED_TYPES)[number]);

  useEffect(() => {
    if (existing.data) {
      const d = existing.data;
      reset({
        name: d.name,
        type: d.type,
        streetAddress: d.streetAddress,
        country: d.country,
        city: d.city,
        pinCode: d.pinCode,
        capacity: Number(d.capacity),
        capacityUnit: d.capacityUnit,
        capabilities: d.capabilities ?? [],
        freeStorageDays: d.freeStorageDays,
        status: d.status,
      });
    }
  }, [existing.data, reset]);

  async function onSubmit(values: WarehouseCreateInput) {
    if (id) await patchJson(`/api/warehouses/${id}`, values);
    else await postJson("/api/warehouses", values);
    navigate("/masters/warehouses");
  }

  const errorMessages = Object.values(errors)
    .map((e) => (e as { message?: string } | undefined)?.message)
    .filter((m): m is string => Boolean(m));

  return (
    <div className="max-w-2xl space-y-8">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" aria-label="Warehouse form">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {id ? "Edit warehouse" : "New warehouse"}
        </h1>

        {errorMessages.length > 0 && (
          <div
            role="alert"
            className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <p className="font-medium">Fix the following before saving:</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {errorMessages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {existing.data?.freightForwarderId || existing.data?.clientId ? (
          <p className="text-sm text-muted-foreground">
            Assigned to {existing.data.freightForwarderId ? "a freight forwarder" : "a client"}.
            Change this from that record.
          </p>
        ) : null}

        <section className="space-y-3">
          <h2 className={sectionTitleClass}>Warehouse</h2>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="name">Warehouse name</Label>
              <Input id="name" {...register("name")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="type">Type of warehouse</Label>
              <select id="type" {...register("type")} className={selectClass} defaultValue="">
                <option value="" disabled>
                  — Select —
                </option>
                {WAREHOUSE_MASTER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="status">Status</Label>
              <select id="status" {...register("status")} className={selectClass}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className={sectionTitleClass}>Address</h2>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="streetAddress">Street address</Label>
              <Input id="streetAddress" {...register("streetAddress")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="city">City</Label>
              <Input id="city" {...register("city")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="country">Country</Label>
              <Input id="country" {...register("country")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pinCode">Pin code</Label>
              <Input id="pinCode" {...register("pinCode")} />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className={sectionTitleClass}>Capacity &amp; capabilities</h2>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="capacity">Capacity</Label>
              <Input
                id="capacity"
                type="number"
                step="any"
                {...register("capacity", {
                  // `capacity` is required (z.number().positive()), unlike the optional numeric
                  // fields below. Mapping a blank box to `undefined` makes zod report
                  // `invalid_type` for it — and a ZodEffects refinement (the agreement/insurance
                  // date invariant below) is SKIPPED entirely whenever the base object parse
                  // aborts, which `invalid_type` does but `too_small` does not. Mapping blank to
                  // 0 instead keeps the object parse merely "dirty": capacity correctly reports
                  // "must be greater than 0" AND the invariant issue still surfaces, instead of
                  // the invariant being silently swallowed behind capacity's own error.
                  setValueAs: (v: string) => (v === "" ? 0 : Number(v)),
                })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="capacityUnit">Capacity unit</Label>
              <select id="capacityUnit" {...register("capacityUnit")} className={selectClass}>
                {CAPACITY_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm text-foreground">Capabilities</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {WAREHOUSE_CAPABILITIES.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" value={c} {...register("capabilities")} />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
        </section>

        {isContracted && (
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
              </div>
              <div className="space-y-1">
                <Label htmlFor="freeStorageDays">Free storage days</Label>
                <Input
                  id="freeStorageDays"
                  type="number"
                  {...register("freeStorageDays", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...register("isBonded")} /> Bonded warehouse
              </label>
              <div className="space-y-1">
                <Label htmlFor="workingEmployees">Working employees</Label>
                <Input
                  id="workingEmployees"
                  type="number"
                  {...register("workingEmployees", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="forkLiftCount">Forklift count</Label>
                <Input
                  id="forkLiftCount"
                  type="number"
                  {...register("forkLiftCount", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dipTrayCount">Dip tray count</Label>
                <Input
                  id="dipTrayCount"
                  type="number"
                  {...register("dipTrayCount", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...register("weekendWorking")} /> Weekend working
              </label>
              <div className="space-y-1">
                <Label htmlFor="weekendWorkingFee">Weekend working fee</Label>
                <Input
                  id="weekendWorkingFee"
                  type="number"
                  step="any"
                  {...register("weekendWorkingFee", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
                />
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
              </div>
              <div className="space-y-1">
                <Label htmlFor="storageRate">Storage rate</Label>
                <Input
                  id="storageRate"
                  type="number"
                  step="any"
                  {...register("storageRate", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
                />
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
              </div>
            </div>
          </section>
        )}

        {id && (
          <p className="text-sm text-muted-foreground">
            Total vehicles: <span className="font-medium text-foreground">{existing.data?.totalVehicles ?? 0}</span>
          </p>
        )}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </form>

      {id && (
        <section aria-label="Vehicles" className="space-y-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">Vehicles</h2>
          <ul className="space-y-1 text-sm">
            {existing.data?.vehicles?.map((v) => (
              <li key={v.id}>
                {v.tonnage} × {v.quantity}
              </li>
            ))}
          </ul>
          <VehicleSubForm id={id} />
        </section>
      )}

      <ContactList ownerPath="warehouses" ownerId={id} />
    </div>
  );
}
