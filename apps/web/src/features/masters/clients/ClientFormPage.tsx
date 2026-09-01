import { useEffect, useState } from "react";
import { useForm, Controller, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import {
  clientCreateSchema,
  contactUpsertSchema,
  atMostOnePrimary,
  MASTER_STATUSES,
  PRIMARY_REQUIRED_MESSAGE,
  PRIMARY_DUPLICATE_MESSAGE,
  type ClientCreateInput,
} from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useClient, useOwnerWarehouses } from "../useMasters";
import { ContactsSection } from "../contacts/ContactsSection";
import { WarehousePicker } from "../WarehousePicker";
import { MasterForm, FormSection, Field, SelectField, saveErrorMessage } from "../form";
import { Input } from "@/components/ui/input";

// clientCreateSchema's own `contacts` rule (.min(1).refine(exactlyOnePrimary)) is unconditional
// — it cannot distinguish "this record never had a primary" (state 3 below, must still save)
// from "the user just demoted the only one away" (state 2, must block). That distinction needs
// `loadedWithPrimary`, which only the component has (read off `existing.data`, not the live
// draft). So the resolver here validates every field exactly as clientCreateSchema does —
// including each individual contact's own shape (name/email/E.164 phone/etc, via
// contactUpsertSchema) — EXCEPT the create-time "exactly one" rule, which `onSubmit` below
// enforces itself using all three states of design decision C4. `atMostOnePrimary` stays:
// nothing in the UI can produce a two-PRIMARY draft (ContactsSection demotes the incumbent the
// moment a second contact is set PRIMARY), but keeping it costs nothing and means a bug in that
// demotion logic would fail loudly here rather than reach the server's own 400.
const clientFormSchema = clientCreateSchema.extend({
  contacts: z.array(contactUpsertSchema).refine(atMostOnePrimary, { message: PRIMARY_DUPLICATE_MESSAGE }),
});

export function ClientFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useClient(id);
  const ownedWarehouses = useOwnerWarehouses("clients", id);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    reset,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ClientCreateInput>({
    resolver: zodResolver(clientFormSchema),
    defaultValues: { contacts: [], warehouseIds: [] },
  });

  // The single most dangerous line in this effect is `contacts:` below. The API treats "absent
  // from the array" as "delete", so omitting this mapping would leave the draft's contacts
  // empty and the very next unrelated PATCH (e.g. fixing a typo in the city) would silently
  // delete every contact on the record — the same silent-overwrite hazard WarehouseFormPage's
  // own reset() comment warns about for its rate fields.
  useEffect(() => {
    if (!existing.data) return;
    const d = existing.data;
    reset({
      companyName: d.companyName,
      country: d.country,
      industry: d.industry ?? undefined,
      streetAddress: d.streetAddress,
      city: d.city,
      postalCode: d.postalCode ?? undefined,
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
      warehouseIds: (ownedWarehouses.data ?? []).map((w) => w.id),
    });
  }, [existing.data, ownedWarehouses.data, reset]);

  // Captured off `existing.data` (the server's record), NOT the live draft — this is what lets
  // the three-state rule below tell "this record never had a primary" (state 3, save allowed)
  // from "the user just demoted the only one away" (state 2, must block). A live-draft read
  // could not make that distinction: both end up with zero PRIMARY contacts in the draft.
  const loadedWithPrimary = (existing.data?.contacts ?? []).some((c) => c.pocLevel === "PRIMARY");
  const showNoPrimaryBanner = Boolean(existing.data) && !loadedWithPrimary;

  // Mirrors ChargeLineFormPage: without a try/catch a rejected save produced nothing at all —
  // the button simply stopped spinning. There is no toast system in this app, so an unhandled
  // rejection here is silence, and it swallowed every 409 (duplicate company name), every 400
  // and every 403 alike.
  async function onValidSubmit(values: ClientCreateInput) {
    setSubmitError(null);
    // Edit mode only — a create page has nothing to fetch and must never be blocked. The same
    // shape as FreightForwarderFormPage's contacts gate, and for the same reason: `warehouseIds`
    // is seeded `[]` by defaultValues and only filled in by the load effect's
    // `(ownedWarehouses.data ?? []).map(...)`. If that query has failed (after react-query's
    // retries `data` stays undefined forever — WarehousePicker's seeding effect is guarded on a
    // truthy `assignedSignature` so it never fires either; this is permanent, not a race) or is
    // still pending while `existing.data` has already landed, the draft carries an explicit
    // empty array. `warehouseIds` is a declared schema field, so `[]` survives the resolver and
    // reaches the wire; server-side `if (warehouseIds)` passes (`Boolean([])` is `true`) and
    // setWarehousesTx runs `updateMany({ where: { clientId, id: { notIn: [] } } })`, which
    // matches EVERY row and detaches every warehouse from this client. Blocking here is what
    // stops that empty draft from ever reaching the PATCH.
    if (id && !ownedWarehouses.isSuccess) {
      setSubmitError(
        ownedWarehouses.isError
          ? "Could not load this client's assigned warehouses. Please retry before saving."
          : "This client's assigned warehouses are still loading. Please wait a moment and try again.",
      );
      return;
    }
    const hasPrimary = values.contacts.some((c) => c.pocLevel === "PRIMARY");
    // State 1 (create) and state 2 (editing a record that loaded WITH a primary) both block.
    // State 3 (editing a record that loaded WITHOUT one) does not — a legacy client must never
    // become un-editable, because the only place to fix it is this very screen.
    if ((!id || loadedWithPrimary) && !hasPrimary) {
      setSubmitError(PRIMARY_REQUIRED_MESSAGE);
      return;
    }
    try {
      if (id) await patchJson(`/api/clients/${id}`, values);
      else await postJson("/api/clients", values);
      navigate("/masters/clients");
    } catch (err) {
      setSubmitError(saveErrorMessage(err, "Could not save this client"));
    }
  }

  const err = (name: keyof ClientCreateInput) => errors[name]?.message as string | undefined;

  // Nothing renders `errors.contacts` — it's a Controller-driven ContactsSection, not a Field,
  // and the seven scalar Fields above only ever surface their own errors. Without this handler,
  // a contact that fails validation (most likely a `ClientContact` row that predates the
  // tightened E.164 rule, loaded in verbatim by the effect above) makes `zodResolver` reject the
  // whole submit and RHF never calls `onValidSubmit` at all — the exact "rejected save produced
  // nothing at all" failure the try/catch below exists to prevent, except this path bypasses
  // that catch entirely because it never reaches it. And it lands on precisely the legacy record
  // whose only repair surface is this screen.
  function onInvalidSubmit(formErrors: FieldErrors<ClientCreateInput>) {
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
    setSubmitError("This client has errors that need fixing before it can be saved.");
  }

  return (
    <MasterForm
      title={id ? "Edit client" : "New client"}
      error={submitError}
      banner={
        showNoPrimaryBanner ? (
          <p role="status" className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
            This client has no primary contact. Add one so quotes can address correspondence.
          </p>
        ) : undefined
      }
      onSubmit={handleSubmit(onValidSubmit, onInvalidSubmit)}
      isSubmitting={isSubmitting}
      onCancel={() => navigate("/masters/clients")}
    >
      <FormSection title="Company">
        <Field id="companyName" label="Company name" error={err("companyName")}>
          <Input id="companyName" {...register("companyName")} />
        </Field>
        <Field id="industry" label="Industry" error={err("industry")}>
          <Input id="industry" {...register("industry")} />
        </Field>
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
        <Field id="postalCode" label="Postal code" error={err("postalCode")}>
          <Input id="postalCode" {...register("postalCode")} />
        </Field>
      </FormSection>

      <Controller
        control={control}
        name="contacts"
        render={({ field }) => (
          <ContactsSection value={field.value ?? []} onChange={field.onChange} ownerNoun="client" />
        )}
      />

      <Controller
        control={control}
        name="warehouseIds"
        render={({ field }) => (
          <WarehousePicker
            ownerPath="clients"
            value={field.value ?? []}
            onChange={field.onChange}
            assigned={ownedWarehouses.data ?? []}
          />
        )}
      />
    </MasterForm>
  );
}
