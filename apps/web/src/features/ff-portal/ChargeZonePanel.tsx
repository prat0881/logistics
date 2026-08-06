import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft, ChargeZone, FfPortalSeededCharge } from "@svyft/shared";
import { computeHeavyWeightAmount } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { HeavyWeightCalcRow } from "./HeavyWeightCalcRow";
import { fmtAmount } from "./format";

const ZONES: { key: ChargeZone; title: string }[] = [
  { key: "ORIGIN", title: "Origin charges" },
  { key: "MAIN_FREIGHT", title: "Main freight" },
  { key: "DESTINATION", title: "Destination charges" },
];

export interface ChargeZonePanelProps {
  seededCharges: FfPortalSeededCharge[];
}

export function ChargeZonePanel({ seededCharges }: ChargeZonePanelProps) {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const { fields, append } = useFieldArray({ control, name: "charges" });
  const draft = useWatch({ control }) as Partial<QuoteDraft>;
  // definitionKey → inputType, so a HEAVY_WEIGHT_CALC seeded line renders the calc row instead
  // of a plain amount field. PLAIN lines (incl. FSC/Peak) fall through to the normal row — no
  // special-casing needed for them.
  const inputTypeByKey = new Map(seededCharges.map((s) => [s.definitionKey, s.inputType]));

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

        // Zone subtotal computed LOCALLY from this zone's rows' effective amounts (QuoteTotals
        // no longer exposes zoneSubtotals). A HEAVY_WEIGHT_CALC line's amount is derived from its
        // 3 inputs, never stored on `amount` — mirrors computeQuoteTotals' effectiveChargeAmount.
        const subtotalValue = rows.reduce((s, { idx }) => {
          const c = draft.charges?.[idx];
          if (!c) return s;
          if (c.pieceWeightKg != null && c.airlineLimitKg != null && c.ratePerExcessKg != null)
            return s + computeHeavyWeightAmount(c.pieceWeightKg, c.airlineLimitKg, c.ratePerExcessKg);
          return s + (c.amount ?? 0);
        }, 0);

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
                const label = chargeAtIdx?.label ?? (f as { label?: string }).label ?? "charge";
                const definitionKey =
                  chargeAtIdx?.definitionKey ?? (f as { definitionKey?: string | null }).definitionKey ?? undefined;

                if (inputTypeByKey.get(definitionKey) === "HEAVY_WEIGHT_CALC") {
                  return <HeavyWeightCalcRow key={f.id} index={idx} label={label} />;
                }

                // Catalogue (seeded) lines always carry a definitionKey; only a genuine custom
                // [+ Add line] row has none. presetKey is always null on catalogue lines now
                // (kept only for shape compatibility — see FfPortalSeededCharge), so a
                // presetKey-based check would wrongly treat every seeded line — FSC, Peak, THC,
                // Air Freight, etc. — as "custom" and render an editable label. Matches
                // RoadChargesPanel.tsx's isPreset check.
                const isPreset = definitionKey != null;

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
