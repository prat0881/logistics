import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  contactUpsertSchema,
  POC_LEVELS,
  MASTER_STATUSES,
  type ContactUpsertInput,
} from "@svyft/shared";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, SelectField } from "../form";

export function ContactDialog({
  open,
  initial,
  onSave,
  onRemove,
  onClose,
}: {
  open: boolean;
  initial: ContactUpsertInput | null;
  onSave: (c: ContactUpsertInput) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const isExisting = initial !== null;
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<ContactUpsertInput>({
    resolver: zodResolver(contactUpsertSchema),
    // `initial ?? {...}` and a `key` on <ContactDialog> in the parent, NOT a reset() effect:
    // the dialog unmounts between openings, so defaultValues are re-read every time and there
    // is no stale-value window to guard against.
    defaultValues: initial ?? { pocLevel: "NONE", status: "ACTIVE" },
  });
  const err = (n: keyof ContactUpsertInput) => errors[n]?.message as string | undefined;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isExisting ? "Edit contact" : "Add contact"}</DialogTitle>
        </DialogHeader>
        {/* stopPropagation is required, not cosmetic: DialogContent renders through a Radix
            Portal, so this <form> sits outside any enclosing <form> in the raw DOM — but React
            bubbles events through the *React tree*, not the DOM tree, for elements rendered via
            createPortal. Once ContactsSection is used inside a real page-level <form>
            (MasterForm, from Task 8 on), this dialog's own submit would otherwise also reach
            that outer form's onSubmit on every "Save contact" click, submitting the whole page
            with whatever stale values it had *before* this dialog's onSave/onChange had run. */}
        <form
          onSubmit={(e) => {
            e.stopPropagation();
            void handleSubmit(onSave)(e);
          }}
          className="space-y-3"
        >
          <Field id="c-name" label="Name" error={err("name")}>
            <Input id="c-name" {...register("name")} />
          </Field>
          <Field id="c-designation" label="Designation" error={err("designation")}>
            <Input id="c-designation" {...register("designation")} />
          </Field>
          <Field id="c-email" label="Email" error={err("email")}>
            <Input id="c-email" {...register("email")} />
          </Field>
          <Field id="c-phone" label="Phone" error={err("contactNo")}>
            <Input id="c-phone" placeholder="+971501234567" {...register("contactNo")} />
          </Field>
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
          <SelectField
            id="c-poc"
            label="POC level"
            error={err("pocLevel")}
            options={POC_LEVELS.map((l) => ({ value: l, label: l }))}
            registration={register("pocLevel")}
          />
          <SelectField
            id="c-status"
            label="Status"
            error={err("status")}
            options={MASTER_STATUSES.map((s) => ({ value: s, label: s }))}
            registration={register("status")}
          />
          <DialogFooter className="gap-2">
            {confirmingRemove ? (
              <>
                <span className="mr-auto self-center text-sm">Remove this contact?</span>
                <Button type="button" variant="outline" onClick={() => setConfirmingRemove(false)}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" onClick={onRemove}>
                  Remove
                </Button>
              </>
            ) : (
              <>
                {isExisting && (
                  <Button
                    type="button"
                    variant="destructive"
                    className="mr-auto"
                    onClick={() => setConfirmingRemove(true)}
                  >
                    Remove contact
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit">Save contact</Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
