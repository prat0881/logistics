import { useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import {
  clientCreateSchema,
  contactUpsertSchema,
  MASTER_STATUSES,
  PRIMARY_REQUIRED_MESSAGE,
  type ClientCreateInput,
} from "@svyft/shared";
import { ApiError, postJson, patchJson } from "@/lib/api";
import { useClient, useOwnerWarehouses } from "../useMasters";
import { ContactsSection } from "../contacts/ContactsSection";
import { WarehousePicker } from "../WarehousePicker";
import { MasterForm, FormSection, Field, SelectField } from "../form";
import { Input } from "@/components/ui/input";

// clientCreateSchema's own `contacts` rule (.min(1).refine(exactlyOnePrimary)) is unconditional
// — it cannot distinguish "this record never had a primary" (state 3 below, must still save)
// from "the user just demoted the only one away" (state 2, must block). That distinction needs
// `loadedWithPrimary`, which only the component has (read off `existing.data`, not the live
// draft). So the resolver here validates every field exactly as clientCreateSchema does —
// including each individual contact's own shape (name/email/E.164 phone/etc, via
// contactUpsertSchema) — EXCEPT the array-level primary rule, which `onSubmit` below enforces
// itself using all three states of design decision C4.
const clientFormSchema = clientCreateSchema.extend({
  contacts: z.array(contactUpsertSchema),
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
      setSubmitError(err instanceof ApiError ? err.message : "Could not save this client");
    }
  }

  const err = (name: keyof ClientCreateInput) => errors[name]?.message as string | undefined;

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
      onSubmit={handleSubmit(onValidSubmit)}
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
