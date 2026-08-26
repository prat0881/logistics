import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import {
  freightForwarderCreateSchema,
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
import { useFreightForwarder } from "../useMasters";
import { ContactList } from "../ContactList";
import { MultiSelectCombobox } from "@/components/MultiSelectCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MODE_OPTS = FREIGHT_MODES.map((m) => ({ code: m, name: m }));
const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const sectionTitleClass = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export function FreightForwarderFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useFreightForwarder(id);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FreightForwarderCreateInput>({
    resolver: zodResolver(freightForwarderCreateSchema),
    defaultValues: { availableCountries: [], modes: [], handleDg: false },
  });

  useEffect(() => {
    if (existing.data) {
      reset({
        companyName: existing.data.companyName,
        companyAddress: existing.data.companyAddress ?? undefined,
        city: existing.data.city ?? undefined,
        postalCode: existing.data.postalCode ?? undefined,
        country: existing.data.country ?? undefined,
        pic: existing.data.pic,
        contactNumber: existing.data.contactNumber,
        email: existing.data.email,
        availableCountries: existing.data.availableCountries as CountryCode[],
        modes: existing.data.modes,
        handleDg: existing.data.handleDg,
        vatTrnEori: existing.data.vatTrnEori ?? undefined,
        whLocation: existing.data.whLocation ?? undefined,
        defaultCurrency: (existing.data.defaultCurrency ?? undefined) as CurrencyCode | undefined,
        paymentTerms: existing.data.paymentTerms ?? undefined,
        typicalLeadTime: existing.data.typicalLeadTime ?? undefined,
        status: existing.data.status,
      });
    }
  }, [existing.data, reset]);

  async function onSubmit(values: FreightForwarderCreateInput) {
    if (id) await patchJson(`/api/freight-forwarders/${id}`, values);
    else await postJson("/api/freight-forwarders", values);
    navigate("/masters/freight-forwarders");
  }

  const err = (name: keyof FreightForwarderCreateInput) =>
    errors[name] ? (
      <p role="alert" className="text-sm text-destructive">
        {errors[name]?.message as string}
      </p>
    ) : null;

  return (
    <div className="max-w-2xl space-y-8">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" aria-label="Freight forwarder form">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {id ? "Edit freight forwarder" : "New freight forwarder"}
        </h1>

        <section className="space-y-3">
          <h2 className={sectionTitleClass}>Company &amp; contact</h2>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="companyName">Company name</Label>
              <Input id="companyName" {...register("companyName")} />
              {err("companyName")}
            </div>
            <div className="space-y-1 sm:col-span-2">
              {id && (
                <p className="text-sm text-muted-foreground">
                  Person in charge, contact number and email are managed as the primary
                  contact below.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="pic">Person in charge</Label>
              {/* Read-only once the record exists: pic/contactNumber/email are derived from
                  the primary contact (FreightForwardersService.syncPrimaryContactColumns is
                  their sole writer after create) — editing them here would be silently
                  reverted by the next unrelated contact write. Plain HTML `disabled`, not
                  react-hook-form's register-option `disabled`, so the loaded value still
                  round-trips through validation/submit unchanged rather than being dropped. */}
              <Input id="pic" disabled={Boolean(id)} {...register("pic")} />
              {err("pic")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactNumber">Contact number</Label>
              <Input
                id="contactNumber"
                placeholder="+15551234567"
                disabled={Boolean(id)}
                {...register("contactNumber")}
              />
              {err("contactNumber")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" disabled={Boolean(id)} {...register("email")} />
              {err("email")}
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className={sectionTitleClass}>Address</h2>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="companyAddress">Street Address</Label>
              <Input id="companyAddress" {...register("companyAddress")} />
              {err("companyAddress")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="city">City</Label>
              <Input id="city" {...register("city")} />
              {err("city")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="postalCode">Postal code</Label>
              <Input id="postalCode" {...register("postalCode")} />
              {err("postalCode")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="country">Country</Label>
              <Input id="country" {...register("country")} />
              {err("country")}
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className={sectionTitleClass}>Service &amp; commercial</h2>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Available countries</Label>
              <Controller
                control={control}
                name="availableCountries"
                render={({ field }) => (
                  <MultiSelectCombobox value={field.value ?? []} options={COUNTRIES} onChange={field.onChange} ariaLabel="Countries" />
                )}
              />
              {err("availableCountries")}
            </div>
            <div className="space-y-1">
              <Label>Modes</Label>
              <Controller
                control={control}
                name="modes"
                render={({ field }) => (
                  <MultiSelectCombobox value={field.value ?? []} options={MODE_OPTS} onChange={field.onChange} ariaLabel="Modes" />
                )}
              />
              {err("modes")}
            </div>
            <div className="space-y-1">
              <Label htmlFor="defaultCurrency">Default currency</Label>
              <select id="defaultCurrency" {...register("defaultCurrency", { setValueAs: (v: string) => (v === "" ? undefined : v) })} className={selectClass}>
                <option value="">—</option>
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="vatTrnEori">VAT / TRN / EORI</Label>
              <Input id="vatTrnEori" {...register("vatTrnEori")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="whLocation">Warehouse location</Label>
              <Input id="whLocation" {...register("whLocation")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="paymentTerms">Payment terms</Label>
              <select
                id="paymentTerms"
                {...register("paymentTerms", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
                className={selectClass}
              >
                <option value="">—</option>
                {PAYMENT_TERMS.map((t) => (
                  <option key={t} value={t}>{PAYMENT_TERM_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="typicalLeadTime">Typical lead time (days)</Label>
              <Input
                id="typicalLeadTime"
                type="number"
                placeholder="2"
                {...register("typicalLeadTime", {
                  // Not `valueAsNumber: true` (the brief's literal suggestion): on an empty
                  // number input, the DOM's `valueAsNumber` is NaN rather than undefined, and
                  // NaN fails the field's `z.number().int().optional()` check — silently
                  // blocking submit whenever this optional field is left blank. setValueAs
                  // maps "" to undefined instead.
                  setValueAs: (v: string) => (v === "" ? undefined : Number(v)),
                })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="status">Status</Label>
              <select id="status" {...register("status")} className={selectClass}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" {...register("handleDg")} />
              <span className="text-sm">Handles Dangerous Goods (DG)</span>
            </label>
          </div>
        </section>

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </form>
      <ContactList ownerPath="freight-forwarders" ownerId={id} />
    </div>
  );
}
