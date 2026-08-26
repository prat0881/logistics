import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect } from "react";
import { clientCreateSchema, type ClientCreateInput } from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useClient } from "../useMasters";
import { ContactList } from "../ContactList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ClientFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useClient(id);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ClientCreateInput>({
    resolver: zodResolver(clientCreateSchema),
  });

  useEffect(() => {
    if (existing.data) {
      reset({
        companyName: existing.data.companyName,
        country: existing.data.country,
        industry: existing.data.industry ?? undefined,
        streetAddress: existing.data.streetAddress,
        city: existing.data.city,
        postalCode: existing.data.postalCode ?? undefined,
      });
    }
  }, [existing.data, reset]);

  async function onSubmit(values: ClientCreateInput) {
    if (id) await patchJson(`/api/clients/${id}`, values);
    else await postJson("/api/clients", values);
    navigate("/masters/clients");
  }

  return (
    <div className="max-w-md space-y-8">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" aria-label="Client form">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {id ? "Edit client" : "New client"}
        </h1>
        <div className="space-y-1">
          <Label htmlFor="companyName">Company name</Label>
          <Input id="companyName" {...register("companyName")} />
          {errors.companyName && (
            <p role="alert" className="text-sm text-destructive">
              {errors.companyName.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="country">Country</Label>
          <Input id="country" {...register("country")} />
          {errors.country && (
            <p role="alert" className="text-sm text-destructive">
              {errors.country.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="industry">Industry</Label>
          <Input id="industry" {...register("industry")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="streetAddress">Street address</Label>
          <Input id="streetAddress" {...register("streetAddress")} />
          {errors.streetAddress && (
            <p role="alert" className="text-sm text-destructive">
              {errors.streetAddress.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="city">City</Label>
          <Input id="city" {...register("city")} />
          {errors.city && (
            <p role="alert" className="text-sm text-destructive">
              {errors.city.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="postalCode">Postal code</Label>
          <Input id="postalCode" {...register("postalCode")} />
        </div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </form>
      <ContactList ownerPath="clients" ownerId={id} />
    </div>
  );
}
