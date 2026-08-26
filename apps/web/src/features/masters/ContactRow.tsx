import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  contactUpdateSchema,
  POC_LEVELS,
  type ContactUpdateInput,
  type ContactDto,
} from "@svyft/shared";
import { ApiError, del, patchJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PROMOTION_HINT = " Demote the current primary contact first, then set this one.";

export type ActiveRowAction = { type: "edit" | "delete"; id: string } | null;

export function ContactRow({
  contact: c,
  ownerPath,
  ownerId,
  active,
  onStartEdit,
  onStartDelete,
  onCancel,
  onMutated,
  onError,
}: {
  contact: ContactDto;
  ownerPath: string;
  ownerId: string;
  active: ActiveRowAction;
  onStartEdit: (id: string) => void;
  onStartDelete: (id: string) => void;
  onCancel: () => void;
  onMutated: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const isEditing = active?.type === "edit" && active.id === c.id;
  const isDeleting = active?.type === "delete" && active.id === c.id;

  const { register, handleSubmit, formState: { dirtyFields, isSubmitting } } =
    useForm<ContactUpdateInput>({
      resolver: zodResolver(contactUpdateSchema),
      defaultValues: {
        name: c.name,
        email: c.email,
        contactNo: c.contactNo,
        whatsappAvailable: c.whatsappAvailable,
        wechatAvailable: c.wechatAvailable,
        botimAvailable: c.botimAvailable,
        pocLevel: c.pocLevel,
      },
    });

  async function onSave(values: ContactUpdateInput) {
    // PATCH sends only the fields the user actually changed — sending the whole
    // contact back would clobber fields another user changed since load.
    const patch: Record<string, unknown> = {};
    (Object.keys(dirtyFields) as (keyof ContactUpdateInput)[]).forEach((key) => {
      if (dirtyFields[key]) patch[key] = values[key];
    });
    try {
      await patchJson(`/api/${ownerPath}/${ownerId}/contacts/${c.id}`, patch);
      await onMutated();
    } catch (err) {
      onError(
        err instanceof ApiError
          ? err.message + (err.status === 409 ? PROMOTION_HINT : "")
          : "Could not save this contact",
      );
    }
  }

  async function onDelete() {
    try {
      await del(`/api/${ownerPath}/${ownerId}/contacts/${c.id}`);
      await onMutated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not remove this contact");
    }
  }

  if (isDeleting) {
    return (
      <li className="flex items-center justify-between gap-2 text-sm">
        <span>Remove {c.name}?</span>
        <span className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="destructive" size="sm" onClick={onDelete}>Remove</Button>
        </span>
      </li>
    );
  }

  if (isEditing) {
    return (
      <li>
        <form
          onSubmit={handleSubmit(onSave)}
          aria-label={`Edit ${c.name}`}
          className="space-y-3 rounded-md border p-3"
        >
          <div className="space-y-1">
            <Label htmlFor={`edit-${c.id}-name`}>Name</Label>
            <Input id={`edit-${c.id}-name`} {...register("name")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`edit-${c.id}-email`}>Email</Label>
            <Input id={`edit-${c.id}-email`} {...register("email")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`edit-${c.id}-phone`}>Phone</Label>
            <Input id={`edit-${c.id}-phone`} placeholder="+971501234567" {...register("contactNo")} />
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
            <Label htmlFor={`edit-${c.id}-level`}>POC level</Label>
            <select
              id={`edit-${c.id}-level`}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              {...register("pocLevel")}
            >
              {POC_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={isSubmitting}>Save contact</Button>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span>
        {c.name} — {c.email} — {c.contactNo}
        {c.pocLevel !== "NONE" && <span className="ml-2 text-muted-foreground">{c.pocLevel}</span>}
      </span>
      <span className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" aria-label={`Edit ${c.name}`} onClick={() => onStartEdit(c.id)}>
          Edit
        </Button>
        <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${c.name}`} onClick={() => onStartDelete(c.id)}>
          Remove
        </Button>
      </span>
    </li>
  );
}
