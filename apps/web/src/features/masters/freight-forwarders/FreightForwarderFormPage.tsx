import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import {
  freightForwarderCreateSchema,
  contactUpsertSchema,
  atMostOnePrimary,
  PRIMARY_REQUIRED_MESSAGE,
  PRIMARY_DUPLICATE_MESSAGE,
  MASTER_STATUSES,
  FREIGHT_MODES,
  COUNTRIES,
  CURRENCIES,
  PAYMENT_TERMS,
  PAYMENT_TERM_LABELS,
  type FreightForwarderCreateInput,
  type CountryCode,
  type CurrencyCode,
} from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useFreightForwarder, useFreightForwarderContacts, useOwnerWarehouses } from "../useMasters";
import { ContactsSection, type ContactDraft } from "../contacts/ContactsSection";
import { WarehousePicker } from "../WarehousePicker";
import { MultiSelectCombobox } from "@/components/MultiSelectCombobox";
import { MasterForm, FormSection, Field, SelectField, saveErrorMessage } from "../form";
import { Input } from "@/components/ui/input";

const MODE_OPTS = FREIGHT_MODES.map((m) => ({ code: m, name: m }));

// freightForwarderCreateSchema's own `contacts` rule (exactlyOnePrimary-when-supplied) can't
// distinguish "this record never had a primary" (state 3 below, must still save) from "the
// user just demoted the only one away" (state 2, must block) — see ClientFormPage's identical
// comment. This form's resolver relaxes that to atMostOnePrimary, exactly like
// freightForwarderUpdateSchema already does server-side; onValidSubmit below enforces the real
// three-state rule itself. Unlike Client, create mode can never actually violate it: the
// mirrored array always carries exactly one PRIMARY (the synthetic row), so this relaxation
// only matters for edit mode's state 3.
const freightForwarderFormSchema = freightForwarderCreateSchema.extend({
  contacts: z.array(contactUpsertSchema).refine(atMostOnePrimary, { message: PRIMARY_DUPLICATE_MESSAGE }).optional(),
});

export function FreightForwarderFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useFreightForwarder(id);
  const contactsQuery = useFreightForwarderContacts(id);
  const ownedWarehouses = useOwnerWarehouses("freight-forwarders", id);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    reset,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FreightForwarderCreateInput>({
    resolver: zodResolver(freightForwarderFormSchema),
    defaultValues: { availableCountries: [], modes: [], handleDg: false, contacts: [], warehouseIds: [] },
  });

  useEffect(() => {
    if (!existing.data) return;
    const d = existing.data;
    reset({
      companyName: d.companyName,
      companyAddress: d.companyAddress ?? undefined,
      city: d.city ?? undefined,
      postalCode: d.postalCode ?? undefined,
      country: d.country ?? undefined,
      pic: d.pic,
      contactNumber: d.contactNumber,
      email: d.email,
      availableCountries: d.availableCountries as CountryCode[],
      modes: d.modes,
      handleDg: d.handleDg,
      vatTrnEori: d.vatTrnEori ?? undefined,
      whLocation: d.whLocation ?? undefined,
      defaultCurrency: (d.defaultCurrency ?? undefined) as CurrencyCode | undefined,
      paymentTerms: d.paymentTerms ?? undefined,
      typicalLeadTime: d.typicalLeadTime ?? undefined,
      status: d.status,
      // FreightForwarderDto doesn't embed contacts the way ClientDto does (see
      // useFreightForwarderContacts) — this mapping is the same silent-delete hazard
      // ClientFormPage's load effect warns about: the API treats "absent from the array" as
      // "delete", so omitting it would let the next unrelated PATCH wipe every contact.
      contacts: (contactsQuery.data ?? []).map((c) => ({
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
  }, [existing.data, contactsQuery.data, ownedWarehouses.data, reset]);

  // Create mode only. The three fields are the FF's own columns AND the source of the primary
  // contact the API seeds (FreightForwardersService.create), so the contacts table shows that
  // row live rather than making the user type the same person twice. On an existing record the
  // three fields are disabled and syncPrimaryContactColumns is the only writer, so there is
  // nothing to mirror — `contacts` comes from the server via contactsQuery above.
  const [pic, contactNumber, email] = useWatch({ control, name: ["pic", "contactNumber", "email"] });
  const contacts = useWatch({ control, name: "contacts" }) ?? [];
  // Suppressed while all three source fields are still blank: without this, a brand-new /new
  // page renders a ghost PRIMARY row with an empty name/email/phone before the user has typed
  // anything, and ContactsSection's "No contacts yet" empty state can never appear in create
  // mode. As soon as any one of the three has content, the mirror (partially filled) takes over.
  const hasMirror = !id && Boolean(pic || contactNumber || email);
  const mirroredContacts: ContactDraft[] = useMemo(() => {
    if (!hasMirror) return contacts;
    const mirror: ContactDraft = {
      name: pic ?? "",
      email: email ?? "",
      contactNo: contactNumber ?? "",
      pocLevel: "PRIMARY",
    };
    return [mirror, ...contacts];
  }, [hasMirror, contacts, pic, contactNumber, email]);

  // Captured off the SERVER's loaded contacts (contactsQuery.data), NOT the live draft — same
  // reasoning as ClientFormPage's loadedWithPrimary: this is what distinguishes "never had a
  // primary" (state 3, save allowed) from "just demoted the only one away" (state 2, blocked).
  const loadedWithPrimary = (contactsQuery.data ?? []).some((c) => c.pocLevel === "PRIMARY");
  const showNoPrimaryBanner = Boolean(existing.data) && !loadedWithPrimary;

  // Mirrors ChargeLineFormPage: without a try/catch a rejected save produced nothing at all —
  // the button simply stopped spinning. There is no toast system in this app, so an unhandled
  // rejection here is silence, and it swallowed every 409 (duplicate company name), every 400
  // and every 403 alike.
  async function onValidSubmit(values: FreightForwarderCreateInput) {
    setSubmitError(null);
    // Edit mode only: FreightForwarderDto doesn't embed contacts (see useFreightForwarderContacts
    // above), so this page always makes a SECOND request for them. Unlike ClientFormPage — where
    // `existing.data` present implies contacts are present, because they're the same response —
    // that second request can still be loading or can have failed while `existing.data` has
    // already resolved and the rest of the form is fully valid. Left unguarded, the load effect's
    // `contacts: (contactsQuery.data ?? []).map(...)` would reset the draft to an empty contacts
    // array, and the API (freight-forwarders.service.ts: `if (contacts)` — `Boolean([])` is
    // `true`) treats a present-but-empty array as "delete every contact", not "leave unchanged".
    // Blocking here, rather than only in the load effect, is what stops that empty draft from
    // ever reaching the PATCH.
    if (id && !contactsQuery.isSuccess) {
      setSubmitError(
        contactsQuery.isError
          ? "Could not load this forwarder's contacts. Please retry before saving."
          : "This forwarder's contacts are still loading. Please wait a moment and try again.",
      );
      return;
    }
    // The same hazard, one query over: `warehouseIds` is seeded `[]` by defaultValues and only
    // filled in by the load effect's `(ownedWarehouses.data ?? []).map(...)`. If that query has
    // failed (after react-query's retries `data` stays undefined forever — WarehousePicker's
    // seeding effect is guarded on a truthy `assignedSignature` so it never fires either; this
    // is permanent, not a race) or is still pending while `existing.data` has landed, the draft
    // carries an explicit empty array. It is a declared schema field, so `[]` survives the
    // resolver and reaches the wire; server-side `if (warehouseIds)` passes (`Boolean([])` is
    // `true`) and setWarehousesTx runs `updateMany({ where: { freightForwarderId, id: { notIn:
    // [] } } })`, which matches EVERY row and detaches every warehouse. On this page it also
    // blanks `whLocation` (setWarehousesTx is its sole writer), which rfq.service.ts snapshots
    // into every future RFQ. Edit mode only — a create page has nothing to fetch.
    if (id && !ownedWarehouses.isSuccess) {
      setSubmitError(
        ownedWarehouses.isError
          ? "Could not load this forwarder's assigned warehouses. Please retry before saving."
          : "This forwarder's assigned warehouses are still loading. Please wait a moment and try again.",
      );
      return;
    }
    // Create mode sends the FULL mirrored array — [mirror, ...extras] — never `contacts: []`.
    // freightForwarderCreateSchema.contacts is `.array(...).refine(exactlyOnePrimary).optional()`
    // — an explicit empty array has zero primaries and is rejected with a 400; the mirrored
    // array always carries exactly one, so it's always accepted, and sending it uniformly means
    // there's no special case for "the user added no extra contacts".
    // Not typed as FreightForwarderCreateInput: that alias is z.infer (output-shaped), which
    // demands contactCoreSchema's defaulted fields (status, whatsappAvailable, ...) be present
    // on every contact. postJson/patchJson take `body?: unknown`, so there's nothing to gain
    // from forcing the narrower type here — the mirror below deliberately supplies only the
    // three columns it derives from, exactly like ContactDraft (the input shape) elsewhere.
    const payload = id
      ? values
      : {
          ...values,
          contacts: [
            { name: values.pic, email: values.email, contactNo: values.contactNumber, pocLevel: "PRIMARY" as const },
            ...(values.contacts ?? []),
          ],
        };
    const hasPrimary = (payload.contacts ?? []).some((c) => c.pocLevel === "PRIMARY");
    // State 1 (create) and state 2 (editing a record that loaded WITH a primary) both block.
    // State 3 (editing a record that loaded WITHOUT one) does not — a legacy forwarder must
    // never become un-editable, because the only place to fix it is this very screen. State 1
    // can never actually reach the block: the mirrored array above always has exactly one
    // PRIMARY. The check stays anyway so the rule is uniform across all three contact-bearing
    // masters and the code path exists even though it's unreachable from this UI.
    if ((!id || loadedWithPrimary) && !hasPrimary) {
      setSubmitError(PRIMARY_REQUIRED_MESSAGE);
      return;
    }
    try {
      if (id) await patchJson(`/api/freight-forwarders/${id}`, payload);
      else await postJson("/api/freight-forwarders", payload);
      navigate("/masters/freight-forwarders");
    } catch (err) {
      setSubmitError(saveErrorMessage(err, "Could not save this freight forwarder"));
    }
  }

  const err = (name: keyof FreightForwarderCreateInput) => errors[name]?.message as string | undefined;

  // Nothing renders `errors.contacts` — it's a Controller-driven ContactsSection, not a Field,
  // and the scalar Fields above only ever surface their own errors. Without this handler, a
  // contact that fails validation (most likely a legacy FreightForwarderContact row that
  // predates the tightened E.164 rule, loaded in verbatim by the effect above) makes
  // zodResolver reject the whole submit and RHF never calls `onValidSubmit` at all — the exact
  // "rejected save produced nothing at all" failure the try/catch above exists to prevent,
  // except this path bypasses that catch entirely because it never reaches it. And it lands on
  // precisely the legacy record whose only repair surface is this screen.
  function onInvalidSubmit(formErrors: FieldErrors<FreightForwarderCreateInput>) {
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
    setSubmitError("This freight forwarder has errors that need fixing before it can be saved.");
  }

  return (
    <MasterForm
      title={id ? "Edit freight forwarder" : "New freight forwarder"}
      error={submitError}
      banner={
        showNoPrimaryBanner ? (
          <p role="status" className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
            This freight forwarder has no primary contact. Add one so quotes can address
            correspondence.
          </p>
        ) : undefined
      }
      onSubmit={handleSubmit(onValidSubmit, onInvalidSubmit)}
      isSubmitting={isSubmitting}
      onCancel={() => navigate("/masters/freight-forwarders")}
    >
      <FormSection title="Company & contact">
        <Field id="companyName" label="Company name" error={err("companyName")}>
          <Input id="companyName" {...register("companyName")} />
        </Field>
        {id && (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            Person in charge, contact number and email are managed as the primary contact below.
          </p>
        )}
        {/* Read-only once the record exists: pic/contactNumber/email are derived from the
            primary contact (FreightForwardersService.syncPrimaryContactColumns is their sole
            writer after create) — editing them here would be silently reverted by the next
            unrelated contact write. Plain HTML `disabled`, not react-hook-form's register-option
            `disabled`, so the loaded value still round-trips through validation/submit unchanged
            rather than being dropped. */}
        <Field id="pic" label="Person in charge" error={err("pic")}>
          <Input id="pic" disabled={Boolean(id)} {...register("pic")} />
        </Field>
        <Field id="contactNumber" label="Contact number" error={err("contactNumber")}>
          <Input id="contactNumber" placeholder="+15551234567" disabled={Boolean(id)} {...register("contactNumber")} />
        </Field>
        <Field id="email" label="Email" error={err("email")}>
          <Input id="email" disabled={Boolean(id)} {...register("email")} />
        </Field>
      </FormSection>

      <FormSection title="Address">
        <Field id="companyAddress" label="Street address" error={err("companyAddress")}>
          <Input id="companyAddress" {...register("companyAddress")} />
        </Field>
        <Field id="city" label="City" error={err("city")}>
          <Input id="city" {...register("city")} />
        </Field>
        <Field id="postalCode" label="Postal code" error={err("postalCode")}>
          <Input id="postalCode" {...register("postalCode")} />
        </Field>
        <Field id="country" label="Country" error={err("country")}>
          <Input id="country" {...register("country")} />
        </Field>
      </FormSection>

      <FormSection title="Service & commercial">
        <Field id="availableCountries" label="Available countries" error={err("availableCountries")}>
          <Controller
            control={control}
            name="availableCountries"
            render={({ field }) => (
              <MultiSelectCombobox value={field.value ?? []} options={COUNTRIES} onChange={field.onChange} ariaLabel="Countries" />
            )}
          />
        </Field>
        <Field id="modes" label="Modes" error={err("modes")}>
          <Controller
            control={control}
            name="modes"
            render={({ field }) => (
              <MultiSelectCombobox value={field.value ?? []} options={MODE_OPTS} onChange={field.onChange} ariaLabel="Modes" />
            )}
          />
        </Field>
        <SelectField
          id="defaultCurrency"
          label="Default currency"
          error={err("defaultCurrency")}
          placeholder="—"
          options={CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))}
          registration={register("defaultCurrency", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
        />
        <Field id="vatTrnEori" label="VAT / TRN / EORI" error={err("vatTrnEori")}>
          <Input id="vatTrnEori" {...register("vatTrnEori")} />
        </Field>
        {/* Read-only once the record exists: whLocation is derived from the assigned
            warehouses (FreightForwardersService.setWarehouses is its sole writer after create)
            — editing it here would be silently reverted by the next warehouse assignment, and
            worse, could itself blank out a value the picker had just set (see setWarehouses's
            update() comment). Same disabled-once-id pattern as pic/contactNumber/email above. */}
        <Field id="whLocation" label="Warehouse location" error={err("whLocation")}>
          <Input id="whLocation" disabled={Boolean(id)} {...register("whLocation")} />
          {id && (
            <p className="text-sm text-muted-foreground">Set by the warehouses assigned below.</p>
          )}
        </Field>
        <SelectField
          id="paymentTerms"
          label="Payment terms"
          error={err("paymentTerms")}
          placeholder="—"
          options={PAYMENT_TERMS.map((t) => ({ value: t, label: PAYMENT_TERM_LABELS[t] }))}
          registration={register("paymentTerms", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
        />
        <Field id="typicalLeadTime" label="Typical lead time (days)" error={err("typicalLeadTime")}>
          <Input
            id="typicalLeadTime"
            type="number"
            placeholder="2"
            {...register("typicalLeadTime", {
              // Not `valueAsNumber: true` (the brief's literal suggestion): on an empty number
              // input, the DOM's `valueAsNumber` is NaN rather than undefined, and NaN fails the
              // field's `z.number().int().optional()` check — silently blocking submit whenever
              // this optional field is left blank. setValueAs maps "" to undefined instead.
              setValueAs: (v: string) => (v === "" ? undefined : Number(v)),
            })}
          />
        </Field>
        <SelectField
          id="status"
          label="Status"
          error={err("status")}
          options={MASTER_STATUSES.map((s) => ({ value: s, label: s }))}
          registration={register("status")}
        />
        <label className="flex items-center gap-2 sm:col-span-2">
          <input type="checkbox" {...register("handleDg")} />
          <span className="text-sm">Handles Dangerous Goods (DG)</span>
        </label>
      </FormSection>

      <Controller
        control={control}
        name="contacts"
        render={({ field }) => (
          <ContactsSection
            value={mirroredContacts}
            onChange={(next) => {
              if (!hasMirror) {
                field.onChange(next);
                return;
              }
              // The mirror at index 0 is synthetic — synthesized above from pic/contactNumber/
              // email, never stored in the `contacts` field — so it's dropped here rather than
              // written back. ContactsSection's own demote-the-incumbent logic (upsert(), in
              // ContactsSection.tsx) demotes whichever row IT thinks is the incumbent primary,
              // including this synthetic row at index 0, the moment a second contact is marked
              // PRIMARY; that demotion is discarded along with the rest of index 0. Any surviving
              // PRIMARY in the tail is force-demoted to SECONDARY here too: the mirror is
              // definitionally the forwarder's one and only primary while creating, so nothing
              // else may hold that badge, regardless of what the dialog briefly allowed.
              field.onChange(
                next.slice(1).map((c) => (c.pocLevel === "PRIMARY" ? { ...c, pocLevel: "SECONDARY" } : c)),
              );
            }}
            ownerNoun="freight forwarder"
            lockedFirstRow={hasMirror}
          />
        )}
      />

      <Controller
        control={control}
        name="warehouseIds"
        render={({ field }) => (
          <WarehousePicker
            ownerPath="freight-forwarders"
            value={field.value ?? []}
            onChange={field.onChange}
            assigned={ownedWarehouses.data ?? []}
          />
        )}
      />
    </MasterForm>
  );
}
