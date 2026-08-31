import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  contactCreateSchema,
  PocLevel,
  POC_LEVELS,
  type ContactCreateInput,
  type ContactDto,
} from "@svyft/shared";
import { ApiError, fetchJson, postJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ContactRow, type ActiveRowAction } from "./ContactRow";

export function ContactList({ ownerPath, ownerId }: { ownerPath: string; ownerId?: string }) {
  const qc = useQueryClient();
  const key = [ownerPath, ownerId, "contacts"];
  const contacts = useQuery({
    queryKey: key,
    queryFn: () => fetchJson<ContactDto[]>(`/api/${ownerPath}/${ownerId}/contacts`),
    enabled: Boolean(ownerId),
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveRowAction>(null);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<ContactCreateInput>({
      resolver: zodResolver(contactCreateSchema),
      defaultValues: { pocLevel: PocLevel.NONE },
    });

  async function onAdd(values: ContactCreateInput) {
    setSubmitError(null);
    try {
      await postJson(`/api/${ownerPath}/${ownerId}/contacts`, values);
      reset({ pocLevel: PocLevel.NONE });
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Failed to add contact");
    }
  }

  async function onMutated() {
    setSubmitError(null);
    setActive(null);
    await qc.invalidateQueries({ queryKey: key });
  }

  if (!ownerId) {
    return <p className="text-sm text-muted-foreground">Save this record before adding contacts.</p>;
  }

  return (
    <section aria-label="Contacts" className="space-y-4">
      <h2 className="font-display text-lg font-semibold tracking-tight">Contacts</h2>
      {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
      <ul className="space-y-1">
        {contacts.data?.map((c) => (
          <ContactRow
            key={c.id}
            contact={c}
            ownerPath={ownerPath}
            ownerId={ownerId}
            active={active}
            onStartEdit={(id) => setActive({ type: "edit", id })}
            onStartDelete={(id) => setActive({ type: "delete", id })}
            onCancel={() => setActive(null)}
            onMutated={onMutated}
            onError={setSubmitError}
          />
        ))}
      </ul>
      {!active && (
        <form onSubmit={handleSubmit(onAdd)} className="space-y-3" aria-label="Add contact">
          <div className="space-y-1">
            <Label htmlFor="contact-name">Name</Label>
            <Input id="contact-name" {...register("name")} />
            {errors.name && <p role="alert" className="text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="contact-email">Email</Label>
            <Input id="contact-email" {...register("email")} />
            {errors.email && <p role="alert" className="text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="contact-phone">Phone</Label>
            <Input id="contact-phone" placeholder="+971501234567" {...register("contactNo")} />
            {errors.contactNo && <p role="alert" className="text-sm text-destructive">{errors.contactNo.message}</p>}
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("whatsappAvailable")} /> WhatsApp
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("wechatAvailable")} /> WeChat
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("botimAvailable")} /> Botim
            </label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="contact-level">POC level</Label>
            <select id="contact-level" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" {...register("pocLevel")}>
              {POC_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <Button type="submit" disabled={isSubmitting}>Add contact</Button>
        </form>
      )}
    </section>
  );
}
