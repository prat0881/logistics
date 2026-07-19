import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect } from "react";
import { vesselCreateSchema, VESSEL_TYPES, type VesselCreateInput } from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useVessel } from "../useMasters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function VesselFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useVessel(id);
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

  async function onSubmit(values: VesselCreateInput) {
    if (id) await patchJson(`/api/vessels/${id}`, values);
    else await postJson("/api/vessels", values);
    navigate("/masters/vessels");
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-md space-y-4" aria-label="Vessel form">
      <h1 className="font-display text-xl font-semibold tracking-tight">
        {id ? "Edit vessel" : "New vessel"}
      </h1>
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
        <select
          id="vesselType"
          {...register("vesselType")}
          className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {VESSEL_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {errors.vesselType && (
          <p role="alert" className="text-sm text-destructive">
            {errors.vesselType.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
