import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";

export function WarehouseStaging(): JSX.Element | null {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const { fields } = useFieldArray({ control, name: "warehouse" });
  const rows = useWatch({ control, name: "warehouse" });

  if (fields.length === 0) return null;

  return (
    <div className="space-y-4">
      {fields.map((field, i) => {
        const row = rows[i];
        const amtId = `wh-amount-${field.warehousePointId}`;
        const windowId = `wh-window-${field.warehousePointId}`;
        return (
          <div key={field.id} className="space-y-2">
            <span className="text-sm font-medium">{row?.label ?? field.label}</span>
            <div className="grid grid-cols-[1fr,1fr] gap-4">
              <div className="space-y-1">
                <Label htmlFor={amtId}>Amount for {row?.label ?? field.label}</Label>
                <NumberField
                  id={amtId}
                  value={row?.amount ?? null}
                  onChange={(v) => setValue(`warehouse.${i}.amount`, v, { shouldDirty: true })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={windowId}>Cargo acceptance window for {row?.label ?? field.label}</Label>
                <Input
                  id={windowId}
                  placeholder="e.g. 2025-08-01 09:00"
                  {...register(`warehouse.${i}.cargoAcceptanceWindow` as const)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
