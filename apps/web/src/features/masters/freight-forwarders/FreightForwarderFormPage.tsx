import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import {
  freightForwarderCreateSchema,
  FREIGHT_MODES,
  COUNTRIES,
  CURRENCIES,
  type FreightForwarderCreateInput,
  type CountryCode,
  type CurrencyCode,
} from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useFreightForwarder } from "../useMasters";
import { MultiSelectCombobox } from "@/components/MultiSelectCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MODE_OPTS = FREIGHT_MODES.map((m) => ({ code: m, name: m }));
const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

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
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg space-y-4" aria-label="Freight forwarder form">
      <h1 className="font-display text-xl font-semibold tracking-tight">
        {id ? "Edit freight forwarder" : "New freight forwarder"}
      </h1>

      <div className="space-y-1">
        <Label htmlFor="companyName">Company name</Label>
        <Input id="companyName" {...register("companyName")} />
        {err("companyName")}
      </div>
      <div className="space-y-1">
        <Label htmlFor="companyAddress">Company address</Label>
        <Input id="companyAddress" {...register("companyAddress")} />
        {err("companyAddress")}
      </div>
      <div className="space-y-1">
        <Label htmlFor="pic">Person in charge</Label>
        <Input id="pic" {...register("pic")} />
        {err("pic")}
      </div>
      <div className="space-y-1">
        <Label htmlFor="contactNumber">Contact number</Label>
        <Input id="contactNumber" placeholder="+15551234567" {...register("contactNumber")} />
        {err("contactNumber")}
      </div>
      <div className="space-y-1">
        <Label htmlFor="email">Email</Label>
        <Input id="email" {...register("email")} />
        {err("email")}
      </div>

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

      <label className="flex items-center gap-2">
        <input type="checkbox" {...register("handleDg")} />
        <span className="text-sm">Handles Dangerous Goods (DG)</span>
      </label>

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
        <Input id="paymentTerms" placeholder="NET 30" {...register("paymentTerms")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="typicalLeadTime">Typical lead time</Label>
        <Input id="typicalLeadTime" placeholder="2d" {...register("typicalLeadTime")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="status">Status</Label>
        <select id="status" {...register("status")} className={selectClass}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
