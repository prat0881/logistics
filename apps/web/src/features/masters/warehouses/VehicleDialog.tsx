import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  warehouseVehicleUpsertSchema,
  TRUCK_TONNAGES,
  truckTonnageLabel,
  type WarehouseVehicleUpsert,
} from "@svyft/shared";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, SelectField } from "../form";

const TONNAGE_OPTIONS = TRUCK_TONNAGES.map((t) => ({ value: t, label: truckTonnageLabel(t) }));

// The tonnage control MUST be a SelectField over TRUCK_TONNAGES, never a free-text input.
// WarehouseVehicle.tonnage is a Prisma TruckTonnage enum, but warehouseVehicleUpsertSchema
// (packages/shared/src/masters/warehouse.ts) types it as z.string().min(1) — a pre-existing,
// out-of-scope gap that lets Zod accept ANY string and only fail at the Prisma layer, a
// 500-shaped failure where a 400 belongs. Task 5's own fixtures hit this with "10T". A free-text
// input here would make that latent bug user-facing the moment this screen shipped; constraining
// the UI to the real enum values is what keeps it from ever being submitted in the first place.
export function VehicleDialog({
  open,
  initial,
  onSave,
  onRemove,
  onClose,
}: {
  open: boolean;
  initial: WarehouseVehicleUpsert | null;
  onSave: (v: WarehouseVehicleUpsert) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const isExisting = initial !== null;
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<WarehouseVehicleUpsert>({
    resolver: zodResolver(warehouseVehicleUpsertSchema),
    // Same reasoning as ContactDialog: the dialog unmounts between openings (see the `key` prop
    // on <VehicleDialog> in VehiclesSection), so defaultValues are re-read fresh every time and
    // there is no stale-value window a reset() effect would need to guard against.
    defaultValues: initial ?? undefined,
  });
  const err = (n: keyof WarehouseVehicleUpsert) => errors[n]?.message as string | undefined;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isExisting ? "Edit vehicle" : "Add vehicle"}</DialogTitle>
        </DialogHeader>
        {/* stopPropagation is required, not cosmetic — same reasoning as ContactDialog: this
            <form> is rendered through a Radix Portal, so it sits outside WarehouseFormPage's own
            <form> in the raw DOM but still bubbles through the React tree. Without this, "Save
            vehicle" would also submit the whole page with stale values from before this dialog's
            onSave had run. */}
        <form
          onSubmit={(e) => {
            e.stopPropagation();
            void handleSubmit(onSave)(e);
          }}
          className="space-y-3"
        >
          <SelectField
            id="v-tonnage"
            label="Tonnage"
            error={err("tonnage")}
            options={TONNAGE_OPTIONS}
            placeholder="— Select —"
            registration={register("tonnage")}
          />
          <Field id="v-quantity" label="Quantity" error={err("quantity")}>
            <Input
              id="v-quantity"
              type="number"
              {...register("quantity", { setValueAs: (v: string) => (v === "" ? undefined : Number(v)) })}
            />
          </Field>
          <DialogFooter className="gap-2">
            {confirmingRemove ? (
              <>
                <span className="mr-auto self-center text-sm">Remove this vehicle?</span>
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
                    Remove vehicle
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit">Save vehicle</Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
