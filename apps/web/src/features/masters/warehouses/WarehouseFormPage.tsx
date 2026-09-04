import { useEffect, useRef, useState } from "react";
import { useForm, useWatch, Controller, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import {
  warehouseCreateSchema,
  refineWarehouseInvariants,
  contactUpsertSchema,
  atMostOnePrimary,
  PRIMARY_REQUIRED_MESSAGE,
  PRIMARY_DUPLICATE_MESSAGE,
  WAREHOUSE_MASTER_TYPES,
  CAPACITY_UNITS,
  WAREHOUSE_CAPABILITIES,
  CONTRACTED_TYPES,
  MASTER_STATUSES,
  type WarehouseCreateInput,
  type CurrencyCode,
} from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useWarehouse } from "../useMasters";
import { ContactsSection } from "../contacts/ContactsSection";
import { VehiclesSection } from "./VehiclesSection";
import { ContractAndRatesSection } from "./ContractAndRatesSection";
import { MasterForm, FormSection, Field, SelectField, masterErrorMessage } from "../form";
import { Input } from "@/components/ui/input";

// warehouseCreateSchema's own `contacts` rule (.min(1).refine(exactlyOnePrimary)) is
// unconditional — it can't distinguish "this record never had a primary" (state 3 below, must
// still save) from "the user just demoted the only one away" (state 2, must block). That
// distinction needs `loadedWithPrimary`, which only the component has (read off
// `existing.data`, not the live draft) — see ClientFormPage's identical comment. `.innerType()`
// unwraps the ZodEffects that `warehouseCreateSchema`'s own `.superRefine(refineWarehouseInvariants)`
// produces, getting back the plain ZodObject so `.extend()` is available; `refineWarehouseInvariants`
// (the agreement/insurance-date and rate-currency/unit invariants, which must still fire for
// every save regardless of create/edit) is then reapplied on top.
const warehouseFormSchema = warehouseCreateSchema
  .innerType()
  .extend({
    contacts: z.array(contactUpsertSchema).refine(atMostOnePrimary, { message: PRIMARY_DUPLICATE_MESSAGE }),
  })
  .superRefine(refineWarehouseInvariants);

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
    getValues,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<WarehouseCreateInput>({
    resolver: zodResolver(warehouseFormSchema),
    defaultValues: {
      capabilities: [],
      isBonded: false,
      weekendWorking: false,
      freeStorageDays: 0,
      contacts: [],
      vehicles: [],
    },
  });

  const type = useWatch({ control, name: "type" });
  const isContracted = CONTRACTED_TYPES.includes(type as (typeof CONTRACTED_TYPES)[number]);
  // The fee is a charge for working a weekend — it is meaningless on a warehouse that does not.
  // The checkbox lives in Operations (an operational fact of the site, shown for every type) and
  // the fee in Contract & rates (OWNED/CONTRACTED only), so the gate is the conjunction.
  const weekendWorking = useWatch({ control, name: "weekendWorking" });

  // The single most dangerous lines in this effect are `contacts:` and `vehicles:` below. The
  // API treats "absent from the array" as "delete", so omitting either mapping would leave the
  // draft's contacts/vehicles empty and the very next unrelated PATCH (e.g. fixing a typo in the
  // city) would silently delete every contact and vehicle on the record — the same
  // silent-overwrite hazard the contract/rate fields below warn about.
  //
  // Every contract/rate field below must be loaded too, not just the ones the Contract section
  // renders. Skipping any of them means an unrelated edit on an existing record silently
  // overwrites it back to the field's `.default()`/`undefined` on the next PATCH: `isBonded` is
  // the sharpest case (compliance data quietly cleared to `false`), and leaving the dates
  // unloaded blanks the Contract section entirely and makes every re-submit of an
  // OWNED/CONTRACTED record fail the "Required for owned and contracted warehouses" invariant
  // the server would otherwise have accepted.
  useEffect(() => {
    if (!existing.data) return;
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
      contacts: (d.contacts ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        designation: c.designation ?? undefined,
        email: c.email,
        contactNo: c.contactNo,
        whatsappAvailable: c.whatsappAvailable,
        wechatAvailable: c.wechatAvailable,
        botimAvailable: c.botimAvailable,
        pocLevel: c.pocLevel,
        status: c.status,
      })),
      vehicles: (d.vehicles ?? []).map((v) => ({ id: v.id, tonnage: v.tonnage, quantity: v.quantity })),
    });
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

  // The same shape as the type effect above, for the same reason: `weekendWorkingFee`'s only
  // renderer unmounts when the box is unchecked, and react-hook-form keeps an unmounted field's
  // registered value (`shouldUnregister` defaults to false). Without this, unchecking Weekend
  // working would still save the fee that is no longer on screen.
  //
  // Only on a real user transition (true -> false), never on the first observed value. The load
  // effect sets `weekendWorking` from the stored record, and clearing on that pass would blank a
  // stored fee on the next unrelated PATCH — the silent-overwrite hazard that effect's own
  // comment warns about. So a legacy row carrying a fee with `weekendWorking: false` keeps it
  // until someone actually toggles the box; the fee is simply not offered for editing until then.
  const prevWeekendWorking = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const was = prevWeekendWorking.current;
    prevWeekendWorking.current = weekendWorking;
    if (was !== true || weekendWorking) return;
    setValue("weekendWorkingFee", undefined);
    clearErrors("weekendWorkingFee");
  }, [weekendWorking, setValue, clearErrors]);

  // Captured off `existing.data` (the server's record), NOT the live draft — this is what lets
  // the three-state rule below tell "this record never had a primary" (state 3, save allowed)
  // from "the user just demoted the only one away" (state 2, must block). A live-draft read
  // could not make that distinction: both end up with zero PRIMARY contacts in the draft.
  const loadedWithPrimary = (existing.data?.contacts ?? []).some((c) => c.pocLevel === "PRIMARY");
  const showNoPrimaryBanner = Boolean(existing.data) && !loadedWithPrimary;

  // Mirrors ChargeLineFormPage: without a try/catch a rejected save produced nothing at all —
  // the button simply stopped spinning. There is no toast system in this app, so an unhandled
  // rejection here is silence, and it swallowed every 409 (duplicate warehouse name, second
  // primary contact), every 400 and every 403 alike.
  async function onValidSubmit(values: WarehouseCreateInput) {
    setSubmitError(null);
    const hasPrimary = (values.contacts ?? []).some((c) => c.pocLevel === "PRIMARY");
    // State 1 (create) and state 2 (editing a record that loaded WITH a primary) both block.
    // State 3 (editing a record that loaded WITHOUT one) does not — a legacy warehouse must
    // never become un-editable, because the only place to fix it is this very screen.
    if ((!id || loadedWithPrimary) && !hasPrimary) {
      setSubmitError(PRIMARY_REQUIRED_MESSAGE);
      return;
    }
    try {
      if (id) await patchJson(`/api/warehouses/${id}`, values);
      else await postJson("/api/warehouses", values);
      navigate("/masters/warehouses");
    } catch (err) {
      setSubmitError(masterErrorMessage(err, "Could not save this warehouse"));
    }
  }

  const err = (name: keyof WarehouseCreateInput) => errors[name]?.message as string | undefined;

  // Nothing renders `errors.contacts` — it's a Controller-driven ContactsSection, not a Field,
  // and the scalar Fields elsewhere only ever surface their own errors. Without this handler, a
  // contact that fails validation (most likely a legacy WarehouseContact row that predates the
  // tightened E.164 rule, loaded in verbatim by the effect above) makes zodResolver reject the
  // whole submit and RHF never calls `onValidSubmit` at all — the exact "rejected save produced
  // nothing at all" failure the try/catch above exists to prevent, except this path bypasses
  // that catch entirely because it never reaches it. And it lands on precisely the legacy record
  // whose only repair surface is this screen.
  function onInvalidSubmit(formErrors: FieldErrors<WarehouseCreateInput>) {
    const contactsError = formErrors.contacts;
    if (Array.isArray(contactsError)) {
      const index = contactsError.findIndex((c) => c);
      if (index !== -1) {
        const fieldErrors = contactsError[index] as Record<string, { message?: string }> | undefined;
        const field = fieldErrors ? Object.keys(fieldErrors)[0] : undefined;
        const message = field ? fieldErrors?.[field]?.message : undefined;
        const name = getValues(`contacts.${index}.name`) || `contact #${index + 1}`;
        setSubmitError(
          `"${name}"${field ? ` — ${field}` : ""}: ${message ?? "has an invalid value"}. Fix it in Contacts before saving.`,
        );
        return;
      }
    } else if (contactsError && "message" in contactsError && contactsError.message) {
      // The atMostOnePrimary array-level refine (not reachable via the UI today, but defensive)
      // attaches its message directly to `contacts`, not to any index.
      setSubmitError(contactsError.message as string);
      return;
    }
    setSubmitError("This warehouse has errors that need fixing before it can be saved.");
  }

  return (
    <MasterForm
      title={id ? "Edit warehouse" : "New warehouse"}
      error={submitError}
      banner={
        showNoPrimaryBanner ? (
          <p role="status" className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
            This warehouse has no primary contact. Add one so quotes can address correspondence.
          </p>
        ) : undefined
      }
      onSubmit={handleSubmit(onValidSubmit, onInvalidSubmit)}
      isSubmitting={isSubmitting}
      onCancel={() => navigate("/masters/warehouses")}
      isDirty={isDirty}
      recordNoun="warehouse"
    >
      {existing.data?.freightForwarderId || existing.data?.clientId ? (
        <p className="text-sm text-muted-foreground">
          Assigned to {existing.data.freightForwarderId ? "a freight forwarder" : "a client"}.
          Change this from that record.
        </p>
      ) : null}

      <FormSection title="Warehouse">
        <Field id="name" label="Warehouse name" error={err("name")}>
          <Input id="name" {...register("name")} />
        </Field>
        <SelectField
          id="type"
          label="Type of warehouse"
          error={err("type")}
          placeholder="— Select —"
          options={WAREHOUSE_MASTER_TYPES.map((t) => ({ value: t, label: t }))}
          registration={register("type")}
        />
        <SelectField
          id="status"
          label="Status"
          error={err("status")}
          options={MASTER_STATUSES.map((s) => ({ value: s, label: s }))}
          registration={register("status")}
        />
      </FormSection>

      <FormSection title="Address">
        <Field id="streetAddress" label="Street address" error={err("streetAddress")}>
          <Input id="streetAddress" {...register("streetAddress")} />
        </Field>
        <Field id="city" label="City" error={err("city")}>
          <Input id="city" {...register("city")} />
        </Field>
        <Field id="country" label="Country" error={err("country")}>
          <Input id="country" {...register("country")} />
        </Field>
        <Field id="pinCode" label="Pin code" error={err("pinCode")}>
          <Input id="pinCode" {...register("pinCode")} />
        </Field>
      </FormSection>

      <FormSection title="Capacity & capabilities">
        <Field id="capacity" label="Capacity" error={err("capacity")}>
          <Input
            id="capacity"
            type="number"
            step="any"
            {...register("capacity", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
        </Field>
        <SelectField
          id="capacityUnit"
          label="Capacity unit"
          error={err("capacityUnit")}
          options={CAPACITY_UNITS.map((u) => ({ value: u, label: u }))}
          registration={register("capacityUnit")}
        />
        <fieldset className="space-y-1 sm:col-span-2">
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
      </FormSection>

      {/*
        Headcount/equipment and weekend-working are operational facts of the physical site,
        not contract or rate terms — CONTRACTED_TYPES' own docstring scopes that constant to
        "contract and rate fields", and the API accepts these four for every warehouse type.
        Gating them behind isContracted would make it impossible to record staffing or
        equipment for a CLIENT/FF warehouse through this form, so they stay visible always.
      */}
      <FormSection title="Operations">
        <Field id="workingEmployees" label="Working employees" error={err("workingEmployees")}>
          <Input
            id="workingEmployees"
            type="number"
            {...register("workingEmployees", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
        </Field>
        <Field id="forkLiftCount" label="Forklift count" error={err("forkLiftCount")}>
          <Input
            id="forkLiftCount"
            type="number"
            {...register("forkLiftCount", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
        </Field>
        <Field id="dipTrayCount" label="Dip tray count" error={err("dipTrayCount")}>
          <Input
            id="dipTrayCount"
            type="number"
            {...register("dipTrayCount", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...register("weekendWorking")} /> Weekend working
        </label>
      </FormSection>

      {isContracted && (
        <ContractAndRatesSection
          control={control}
          register={register}
          errors={errors}
          showWeekendWorkingFee={Boolean(weekendWorking)}
        />
      )}

      <Controller
        control={control}
        name="vehicles"
        render={({ field }) => (
          <div className="space-y-2">
            <VehiclesSection value={field.value ?? []} onChange={field.onChange} />
            {/* The total number of vehicles, not the number of tonnage rows — three 5T trucks
                and two 9T trucks is five, which the `.length` this replaced reported as 2. Same
                figure the API derives and returns as `totalVehicles` (WarehousesService.get:
                `vehicles.reduce((sum, v) => sum + v.quantity, 0)`), so the draft and the saved
                record agree. `quantity` is a required positive int and VehicleDialog validates
                each row against `warehouseVehicleUpsertSchema` before it reaches this array, so
                there is no partial row to guard against. */}
            <p className="text-sm text-muted-foreground">
              Total vehicles:{" "}
              <span className="font-medium text-foreground">
                {(field.value ?? []).reduce((sum, v) => sum + v.quantity, 0)}
              </span>
            </p>
          </div>
        )}
      />

      <Controller
        control={control}
        name="contacts"
        render={({ field }) => (
          <ContactsSection value={field.value ?? []} onChange={field.onChange} ownerNoun="warehouse" />
        )}
      />
    </MasterForm>
  );
}
