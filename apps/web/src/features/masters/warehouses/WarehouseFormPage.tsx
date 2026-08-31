import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import {
  warehouseCreateSchema,
  WAREHOUSE_MASTER_TYPES,
  CAPACITY_UNITS,
  WAREHOUSE_CAPABILITIES,
  CONTRACTED_TYPES,
  warehouseVehicleSchema,
  type WarehouseCreateInput,
  type WarehouseVehicleInput,
  type CurrencyCode,
} from "@svyft/shared";
import { postJson, patchJson, ApiError } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useWarehouse } from "../useMasters";
import { ContactList } from "../ContactList";
import { ContractAndRatesSection } from "./ContractAndRatesSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const sectionTitleClass = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

function VehicleSubForm({ id }: { id: string }) {
  const qc = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<WarehouseVehicleInput>({ resolver: zodResolver(warehouseVehicleSchema) });

  async function onAdd(values: WarehouseVehicleInput) {
    setSubmitError(null);
    try {
      await postJson(`/api/warehouses/${id}/vehicles`, values);
      reset();
      await qc.invalidateQueries({ queryKey: ["warehouse", id] });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Failed to add vehicle");
    }
  }

  return (
    <form onSubmit={handleSubmit(onAdd)} className="space-y-3" aria-label="Add vehicle">
      {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
      <div className="flex flex-wrap items-end gap-3">
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
      </div>
    </form>
  );
}

export function WarehouseFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useWarehouse(id);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    clearErrors,
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
        // Contract & rate fields — every one of these must be loaded, not just the ones the
        // Contract section renders. Skipping any of them means an unrelated edit on an existing
        // record silently overwrites it back to the field's `.default()`/`undefined` on the
        // next PATCH: `isBonded` is the sharpest case (compliance data quietly cleared to
        // `false`), and leaving the dates unloaded blanks the Contract section entirely and
        // makes every re-submit of an OWNED/CONTRACTED record fail the "Required for owned and
        // contracted warehouses" invariant the server would otherwise have accepted.
        agreementValidUntil: d.agreementValidUntil ?? undefined,
        insuranceValidUntil: d.insuranceValidUntil ?? undefined,
        isBonded: d.isBonded,
        weekendWorking: d.weekendWorking,
        weekendWorkingFee: d.weekendWorkingFee != null ? Number(d.weekendWorkingFee) : undefined,
        workingEmployees: d.workingEmployees ?? undefined,
        forkLiftCount: d.forkLiftCount ?? undefined,
        dipTrayCount: d.dipTrayCount ?? undefined,
        freeStorageDays: d.freeStorageDays,
        rateCurrency: (d.rateCurrency ?? undefined) as CurrencyCode | undefined,
        handlingRate: d.handlingRate != null ? Number(d.handlingRate) : undefined,
        handlingUnit: d.handlingUnit ?? undefined,
        storageRate: d.storageRate != null ? Number(d.storageRate) : undefined,
        storageUnit: d.storageUnit ?? undefined,
        status: d.status,
      });
    }
  }, [existing.data, reset]);

  // Byte-for-byte the mechanism already fixed in ChargeLineFormPage's mode/category/variant
  // effect: a field whose only renderer has unmounted keeps its registered value (react-hook-
  // form's `shouldUnregister` defaults to false), and `refineWarehouseInvariants` applies the
  // rate rules for EVERY type, not just OWNED/CONTRACTED. So entering a handling rate with no
  // unit on an OWNED warehouse and then switching type to CLIENT left a validation error on
  // `handlingUnit` — a field ContractAndRatesSection is the only renderer of, and which is no
  // longer on screen — and Save silently did nothing. Clearing the six rate fields (and their
  // errors) when the type leaves OWNED/CONTRACTED keeps the registered values and what's
  // visually shown in agreement, exactly as the charge-line fix does.
  //
  // Only on an actual transition, never on the first observed type: the load effect above sets
  // `type` from an existing record, and clearing on that pass would blank a stored rate card on
  // the next unrelated PATCH — the same silent-overwrite hazard that effect's own comment warns
  // about. `agreementValidUntil`/`insuranceValidUntil` are deliberately left alone: their
  // invariant fires only while the type IS contracted, i.e. only while the section is on screen.
  const prevType = useRef<WarehouseCreateInput["type"] | undefined>(undefined);
  useEffect(() => {
    const wasContracted = CONTRACTED_TYPES.includes(
      prevType.current as (typeof CONTRACTED_TYPES)[number],
    );
    prevType.current = type;
    if (!wasContracted || isContracted) return;
    const rateFields = [
      "rateCurrency", "handlingRate", "handlingUnit",
      "storageRate", "storageUnit", "weekendWorkingFee",
    ] as const;
    for (const f of rateFields) setValue(f, undefined);
    clearErrors([...rateFields]);
  }, [type, isContracted, setValue, clearErrors]);

  // Mirrors ChargeLineFormPage: without this catch a rejected save produced nothing at all —
  // the button simply stopped spinning. There is no toast system in this app, so an unhandled
  // rejection here is silence, and it swallowed every 409 (duplicate warehouse name, second
  // primary contact), every 400 and every 403 alike. VehicleSubForm above already caught its
  // own; the main form did not.
  async function onSubmit(values: WarehouseCreateInput) {
    setSubmitError(null);
    try {
      if (id) await patchJson(`/api/warehouses/${id}`, values);
      else await postJson("/api/warehouses", values);
      navigate("/masters/warehouses");
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not save this warehouse");
    }
  }

  const err = (name: keyof WarehouseCreateInput) =>
    errors[name] ? (
      <p role="alert" className="text-sm text-destructive">
        {errors[name]?.message as string}
      </p>
    ) : null;

  return (
    <div className="max-w-2xl space-y-8">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" aria-label="Warehouse form">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {id ? "Edit warehouse" : "New warehouse"}
        </h1>
        {submitError && (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
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
              {err("name")}
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
              {err("type")}
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
              {err("streetAddress")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="city">City</Label>
              <Input id="city" {...register("city")} />
              {err("city")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="country">Country</Label>
              <Input id="country" {...register("country")} />
              {err("country")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="pinCode">Pin code</Label>
              <Input id="pinCode" {...register("pinCode")} />
              {err("pinCode")}
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
                {...register("capacity", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
              />
              {err("capacity")}
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

        {/*
          Headcount/equipment and weekend-working are operational facts of the physical site,
          not contract or rate terms — CONTRACTED_TYPES' own docstring scopes that constant to
          "contract and rate fields", and the API accepts these four for every warehouse type.
          Gating them behind isContracted would make it impossible to record staffing or
          equipment for a CLIENT/FF warehouse through this form, so they stay visible always.
        */}
        <section className="space-y-3">
          <h2 className={sectionTitleClass}>Operations</h2>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="workingEmployees">Working employees</Label>
              <Input
                id="workingEmployees"
                type="number"
                {...register("workingEmployees", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
              />
              {err("workingEmployees")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="forkLiftCount">Forklift count</Label>
              <Input
                id="forkLiftCount"
                type="number"
                {...register("forkLiftCount", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
              />
              {err("forkLiftCount")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="dipTrayCount">Dip tray count</Label>
              <Input
                id="dipTrayCount"
                type="number"
                {...register("dipTrayCount", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
              />
              {err("dipTrayCount")}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("weekendWorking")} /> Weekend working
            </label>
          </div>
        </section>

        {isContracted && <ContractAndRatesSection control={control} register={register} errors={errors} />}

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
