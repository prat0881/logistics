import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { fxRateCreateSchema, CURRENCY_CODES, viewerZone, type FxRateCreateInput } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { useCreateFxRate } from "./useFxRates";
import { MasterForm, FormSection, Field, SelectField } from "../form";
import { Input } from "@/components/ui/input";
import { Form } from "@/components/ui/form";
import { ZonedDateTimeField } from "@/components/ZonedDateTimeField";

const CURRENCY_OPTIONS = CURRENCY_CODES.filter((c) => c !== "USD");

export function FxRateFormPage() {
  const navigate = useNavigate();
  const zone = viewerZone();
  const createRate = useCreateFxRate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<FxRateCreateInput>({
    resolver: zodResolver(fxRateCreateSchema),
  });
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;

  // Mirrors VesselFormPage: without this catch a rejected save produced nothing at all — the
  // button simply stopped spinning. There is no toast system in this app, so an unhandled
  // rejection here is silence.
  async function onSubmit(values: FxRateCreateInput) {
    setSubmitError(null);
    try {
      await createRate.mutateAsync(values);
      navigate("/masters/fx-rates");
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not save this FX rate");
    }
  }

  const err = (name: keyof FxRateCreateInput) => errors[name]?.message as string | undefined;

  return (
    <Form {...form}>
      <MasterForm
        title="New FX rate"
        error={submitError}
        onSubmit={handleSubmit(onSubmit)}
        isSubmitting={isSubmitting}
        onCancel={() => navigate("/masters/fx-rates")}
      >
        <FormSection title="Rate">
          <SelectField
            id="currency"
            label="Currency"
            error={err("currency")}
            placeholder="Select currency…"
            options={CURRENCY_OPTIONS.map((c) => ({ value: c, label: c }))}
            registration={register("currency")}
          />
          <Field id="unitsPerUsd" label="Units/USD" error={err("unitsPerUsd")}>
            <Input
              id="unitsPerUsd"
              type="number"
              step="any"
              {...register("unitsPerUsd", { valueAsNumber: true })}
            />
          </Field>
          <ZonedDateTimeField
            control={control}
            name="effectiveFrom"
            label="Effective from"
            zone={zone}
          />
          <Field id="note" label="Note" error={err("note")}>
            <Input
              id="note"
              {...register("note", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
            />
          </Field>
        </FormSection>
      </MasterForm>
    </Form>
  );
}
