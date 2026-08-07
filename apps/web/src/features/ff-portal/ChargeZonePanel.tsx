import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft, ChargeZone, FfPortalSeededCharge, BillOfLadingType } from "@svyft/shared";
import { effectiveChargeAmount, BILL_OF_LADING_TYPES } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NumberField } from "./NumberField";
import { HeavyWeightCalcRow } from "./HeavyWeightCalcRow";
import { fmtAmount } from "./format";

const ZONES: { key: ChargeZone; title: string }[] = [
  { key: "ORIGIN", title: "Origin charges" },
  { key: "MAIN_FREIGHT", title: "Main freight" },
  { key: "DESTINATION", title: "Destination charges" },
];

// The seeded Sea Zone-1 line that also carries a Bill of Lading type (§7.4.3.2) — detected by
// definitionKey, not presetKey (catalogue lines always carry definitionKey; presetKey is null).
const BILL_OF_LADING_KEY = "SEA_ORIGIN_BILL_OF_LADING";
const BILL_OF_LADING_LABELS: Record<BillOfLadingType, string> = {
  ORIGINAL: "Original",
  TELEX: "Telex Release",
};

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
          .filter(
            ({ f, idx }) =>
              (draft.charges?.[idx]?.zone ?? (f as { zone?: ChargeZone }).zone) === key,
          );

        // Zone subtotal computed LOCALLY from this zone's rows' effective amounts (QuoteTotals no
        // longer exposes zoneSubtotals). Reuses the engine's `effectiveChargeAmount` so a
        // HEAVY_WEIGHT_CALC line (amount derived from its 3 inputs, never stored on `amount`) folds
        // in EXACTLY as computeQuoteTotals does — one source of truth, no zone/total drift.
        const subtotalValue = rows.reduce((s, { idx }) => {
          const c = draft.charges?.[idx];
          return c ? s + effectiveChargeAmount(c) : s;
        }, 0);

        return (
          <div key={key} className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {title}
              </h4>
              <div data-testid={`zone-subtotal-${key}`} className="font-mono tabular-nums text-sm">
                {fmtAmount(subtotalValue)}
              </div>
            </div>

            <div className="space-y-2">
              {rows.map(({ f, idx }) => {
                const chargeAtIdx = draft.charges?.[idx];
                const label = chargeAtIdx?.label ?? (f as { label?: string }).label ?? "charge";
                const definitionKey =
                  chargeAtIdx?.definitionKey ??
                  (f as { definitionKey?: string | null }).definitionKey ??
                  undefined;

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
                  <div key={f.id} className="space-y-2">
                    <div className="grid grid-cols-[1fr,10rem,1fr] items-center gap-2">
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

                    {definitionKey === BILL_OF_LADING_KEY && (
                      <div className="w-48 space-y-1">
                        <label
                          htmlFor={`bl-type-${idx}`}
                          className="text-xs font-medium text-muted-foreground"
                        >
                          Bill of Lading type
                        </label>
                        <Select
                          value={chargeAtIdx?.billOfLadingType ?? ""}
                          onValueChange={(v) =>
                            setValue(`charges.${idx}.billOfLadingType`, v as BillOfLadingType, {
                              shouldDirty: true,
                            })
                          }
                        >
                          <SelectTrigger
                            id={`bl-type-${idx}`}
                            aria-label={`Bill of Lading type for ${label}`}
                          >
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                          <SelectContent>
                            {BILL_OF_LADING_TYPES.map((b) => (
                              <SelectItem key={b} value={b}>
                                {BILL_OF_LADING_LABELS[b]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
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
