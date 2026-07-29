import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft, ChargeZone } from "@svyft/shared";
import { computeQuoteTotals } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { fmtAmount } from "./format";

const ZONES: { key: ChargeZone; title: string }[] = [
  { key: "ORIGIN", title: "Origin charges" },
  { key: "MAIN_FREIGHT", title: "Main freight" },
  { key: "DESTINATION", title: "Destination charges" },
];

const ZONE_SUBTOTAL_KEY: Record<ChargeZone, "origin" | "mainFreight" | "destination"> = {
  ORIGIN: "origin",
  MAIN_FREIGHT: "mainFreight",
  DESTINATION: "destination",
};

export function ChargeZonePanel() {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const { fields, append } = useFieldArray({ control, name: "charges" });
  const draft = useWatch({ control }) as Partial<QuoteDraft>;
  const totals = computeQuoteTotals(draft as QuoteDraft);

  return (
    <div className="space-y-6">
      {ZONES.map(({ key, title }) => {
        // Build rows keeping the ABSOLUTE index so inputs bind to the correct field.
        // Filter by zone from draft.charges (kept in sync by useWatch); fall back to
        // the field's own zone property (present on the RHF field object itself) so
        // newly-appended rows that haven't yet reflected into draft.charges still render.
        const rows = fields
          .map((f, idx) => ({ f, idx }))
          .filter(({ f, idx }) => (draft.charges?.[idx]?.zone ?? (f as { zone?: ChargeZone }).zone) === key);

        const subtotalValue = totals.zoneSubtotals[ZONE_SUBTOTAL_KEY[key]];

        return (
          <div key={key} className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {title}
              </h4>
              <div
                data-testid={`zone-subtotal-${key}`}
                className="font-mono tabular-nums text-sm"
              >
                {fmtAmount(subtotalValue)}
              </div>
            </div>

            <div className="space-y-2">
              {rows.map(({ f, idx }) => {
                const chargeAtIdx = draft.charges?.[idx];
                const isPreset = (chargeAtIdx?.presetKey ?? null) != null;
                const label = chargeAtIdx?.label ?? (f as { label?: string }).label ?? "charge";

                return (
                  <div
                    key={f.id}
                    className="grid grid-cols-[1fr,10rem,1fr] items-center gap-2"
                  >
                    {isPreset ? (
                      <span className="text-sm">{label}</span>
                    ) : (
                      <Input
                        aria-label="Custom line label"
                        {...register(`charges.${idx}.label` as const)}
                      />
                    )}
                    <NumberField
                      aria-label={`Amount for ${label}`}
                      value={chargeAtIdx?.amount ?? null}
                      onChange={(v) =>
                        setValue(`charges.${idx}.amount`, v, { shouldDirty: true })
                      }
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
                  append({
                    zone: key,
                    presetKey: null,
                    label: "Custom charge",
                    amount: null,
                  })
                }
              >
                + Add line ({title})
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
