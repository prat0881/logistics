import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { toDatetimeLocal, fromDatetimeLocal, nowDatetimeLocal } from "./format";

export function WarehouseStaging(): JSX.Element | null {
  const { control, setValue } = useFormContext<QuoteDraft>();
  const { fields } = useFieldArray({ control, name: "warehouse" });
  const rows = useWatch({ control, name: "warehouse" });

  if (fields.length === 0) return null;

  // No-past-date client gate (design D3, finding #10) — same convention as TransitPlanForm:
  // computed once per render, reused across every warehouse row's acceptance-window field.
  const nowLocal = nowDatetimeLocal();

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
                {/* design #8: generic "Amount for Warehouse" — a warehouse has no separate
                    origin/destination here, so the field label drops that qualifier (the row
                    heading above still shows the endpoint's own Origin/Destination label). */}
                <Label htmlFor={amtId}>Amount for Warehouse</Label>
                <NumberField
                  id={amtId}
                  value={row?.amount ?? null}
                  onChange={(v) => setValue(`warehouse.${i}.amount`, v, { shouldDirty: true })}
                />
              </div>
              <div className="space-y-1">
                {/* design #8/#9: generic label + a real datetime-local field (was free text) —
                    same toDatetimeLocal/fromDatetimeLocal convention as TransitPlanForm.
                    cargoAcceptanceWindow stays a plain string in the model (no schema change). */}
                <Label htmlFor={windowId}>Cargo Acceptance Window for Warehouse</Label>
                <Input
                  id={windowId}
                  type="datetime-local"
                  min={nowLocal}
                  value={toDatetimeLocal(row?.cargoAcceptanceWindow)}
                  onChange={(e) =>
                    setValue(
                      `warehouse.${i}.cargoAcceptanceWindow`,
                      fromDatetimeLocal(e.target.value) ?? undefined,
                      { shouldDirty: true },
                    )
                  }
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
