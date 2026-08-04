import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";

/**
 * Road configured charges: a flat list over `charges` filtered to `zone === null`
 * (the plain lines seeded from the leg's resolved charge configuration, §12.2).
 * Air/Sea zone lines live in ChargeZonePanel; Road trucking blocks live in TruckingBlocks.
 * This mirrors ChargeZonePanel's absolute-index binding + preset-read-only vs custom-editable,
 * just without zone grouping/subtotals.
 */
export function RoadChargesPanel(): JSX.Element {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const { fields, append } = useFieldArray({ control, name: "charges" });
  const draft = useWatch({ control }) as Partial<QuoteDraft>;

  // Build rows keeping the ABSOLUTE index so inputs bind to the correct field.
  // Filter by zone from draft.charges (kept in sync by useWatch); fall back to the
  // field's own zone property (present on the RHF field object itself) so a
  // newly-appended row still renders before draft.charges reflects it.
  const rows = fields
    .map((f, idx) => ({ f, idx }))
    .filter(({ f, idx }) => (draft.charges?.[idx]?.zone ?? (f as { zone?: string | null }).zone ?? null) === null);

  return (
    <div className="space-y-2">
      {rows.map(({ f, idx }) => {
        const chargeAtIdx = draft.charges?.[idx];
        const isPreset =
          (chargeAtIdx?.definitionKey ?? (f as { definitionKey?: string | null }).definitionKey ?? null) != null;
        const label = chargeAtIdx?.label ?? (f as { label?: string }).label ?? "charge";

        return (
          <div key={f.id} className="flex items-center gap-2">
            {isPreset ? (
              <span className="flex-1 text-sm">{label}</span>
            ) : (
              <Input
                aria-label="Custom line label"
                className="flex-1"
                {...register(`charges.${idx}.label` as const)}
              />
            )}
            <NumberField
              aria-label={`Amount for ${label}`}
              value={chargeAtIdx?.amount ?? null}
              onChange={(v) => setValue(`charges.${idx}.amount`, v, { shouldDirty: true })}
            />
            <Input
              aria-label={`Note for ${label}`}
              placeholder="Note (optional)"
              {...register(`charges.${idx}.note` as const)}
            />
          </div>
        );
      })}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() =>
          append({ zone: null, definitionKey: null, presetKey: null, label: "Custom charge", amount: null })
        }
      >
        + Add line
      </Button>
    </div>
  );
}
