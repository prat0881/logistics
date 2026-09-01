import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { vesselCreateSchema, MASTER_STATUSES, type VesselCreateInput } from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useVessel } from "../useMasters";
import { MasterForm, FormSection, Field, SelectField, masterErrorMessage } from "../form";
import { Input } from "@/components/ui/input";

export function VesselFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useVessel(id);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<VesselCreateInput>({
    resolver: zodResolver(vesselCreateSchema),
  });

  useEffect(() => {
    if (existing.data) {
      reset({
        name: existing.data.name,
        imoNumber: existing.data.imoNumber ?? undefined,
        shippingLine: existing.data.shippingLine ?? undefined,
        vesselType: existing.data.vesselType,
        status: existing.data.status,
      });
    }
  }, [existing.data, reset]);

  // Mirrors ChargeLineFormPage: without this catch a rejected save produced nothing at all —
  // the button simply stopped spinning. There is no toast system in this app, so an unhandled
  // rejection here is silence, and it swallowed every 409 (duplicate IMO number), every 400 and
  // every 403 alike.
  async function onSubmit(values: VesselCreateInput) {
    setSubmitError(null);
    try {
      if (id) await patchJson(`/api/vessels/${id}`, values);
      else await postJson("/api/vessels", values);
      navigate("/masters/vessels");
    } catch (err) {
      setSubmitError(masterErrorMessage(err, "Could not save this vessel"));
    }
  }

  const err = (name: keyof VesselCreateInput) => errors[name]?.message as string | undefined;

  return (
    <MasterForm
      title={id ? "Edit vessel" : "New vessel"}
      error={submitError}
      onSubmit={handleSubmit(onSubmit)}
      isSubmitting={isSubmitting}
      onCancel={() => navigate("/masters/vessels")}
      isDirty={isDirty}
      recordNoun="vessel"
    >
      <FormSection title="Vessel">
        <Field id="name" label="Name" error={err("name")}>
          <Input id="name" {...register("name")} />
        </Field>
        <Field id="imoNumber" label="IMO number" error={err("imoNumber")}>
          <Input
            id="imoNumber"
            {...register("imoNumber", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
          />
        </Field>
        <Field id="shippingLine" label="Shipping line" error={err("shippingLine")}>
          <Input id="shippingLine" {...register("shippingLine")} />
        </Field>
        <Field id="vesselType" label="Vessel type" error={err("vesselType")}>
          <Input id="vesselType" placeholder="Container Vessel" {...register("vesselType")} />
        </Field>
        <SelectField
          id="status"
          label="Status"
          error={err("status")}
          options={MASTER_STATUSES.map((s) => ({ value: s, label: s }))}
          registration={register("status")}
        />
      </FormSection>
    </MasterForm>
  );
}
