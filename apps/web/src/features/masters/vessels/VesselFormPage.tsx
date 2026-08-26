import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { vesselCreateSchema, type VesselCreateInput } from "@svyft/shared";
import { ApiError, postJson, patchJson } from "@/lib/api";
import { useVessel } from "../useMasters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function VesselFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useVessel(id);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
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
      setSubmitError(err instanceof ApiError ? err.message : "Could not save this vessel");
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-md space-y-4" aria-label="Vessel form">
      <h1 className="font-display text-xl font-semibold tracking-tight">
        {id ? "Edit vessel" : "New vessel"}
      </h1>
      {submitError && (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      )}
      <div className="space-y-1">
        <Label htmlFor="name">Name</Label>
        <Input id="name" {...register("name")} />
        {errors.name && (
          <p role="alert" className="text-sm text-destructive">
            {errors.name.message}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="imoNumber">IMO number</Label>
        <Input
          id="imoNumber"
          {...register("imoNumber", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
        />
        {errors.imoNumber && (
          <p role="alert" className="text-sm text-destructive">
            {errors.imoNumber.message}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="shippingLine">Shipping line</Label>
        <Input id="shippingLine" {...register("shippingLine")} />
        {errors.shippingLine && (
          <p role="alert" className="text-sm text-destructive">
            {errors.shippingLine.message}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="vesselType">Vessel type</Label>
        <Input id="vesselType" placeholder="Container Vessel" {...register("vesselType")} />
        {errors.vesselType && (
          <p role="alert" className="text-sm text-destructive">{errors.vesselType.message}</p>
        )}
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
