import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft, FfPortalEndpoint, TruckingBasis, TruckTonnage } from "@svyft/shared";
import { TRUCK_TONNAGES, truckTonnageLabel, rateVariantLabel } from "@svyft/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { NumberField } from "./NumberField";

export function TruckingBlocks({ endpoints }: { endpoints: FfPortalEndpoint[] }): JSX.Element {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const { fields } = useFieldArray({ control, name: "trucking" });
  const watchedTrucking = useWatch({ control, name: "trucking" });

  return (
    <div className="space-y-6">
      {fields.map((field, i) => {
        const row = watchedTrucking?.[i];
        // Row heading: the rate variant IS the trucking type now (draftFromDto seeds one row
        // per variant) — no per-row Type Select anymore.
        const rateVariant = row?.rateVariant ?? field.rateVariant;
        const heading = rateVariantLabel(rateVariant);
        const pointId = field.legEndpointPointId;
        const pointName = endpoints.find((e) => e.pointId === pointId)?.name ?? pointId;

        return (
          <div key={field.id} className="space-y-3 rounded-md border border-border p-4">
            <div className="flex items-baseline justify-between">
              <h4 className="text-sm font-semibold">{heading}</h4>
              <span className="text-xs text-muted-foreground">{pointName}</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Tonnage — Dedicated only */}
              {rateVariant === "DEDICATED" && (
                <div className="space-y-1">
                  <label
                    htmlFor={`trk-tonnage-${i}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Tonnage
                  </label>
                  <Select
                    value={row?.tonnage ?? ""}
                    onValueChange={(v) =>
                      setValue(`trucking.${i}.tonnage`, v as TruckTonnage, {
                        shouldDirty: true,
                      })
                    }
                  >
                    <SelectTrigger id={`trk-tonnage-${i}`} aria-label={`Tonnage for ${heading}`}>
                      <SelectValue placeholder="Select tonnage" />
                    </SelectTrigger>
                    <SelectContent>
                      {TRUCK_TONNAGES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {truckTonnageLabel(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Basis */}
              <div className="space-y-1">
                <label
                  htmlFor={`trk-basis-${i}`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  Basis
                </label>
                <Select
                  value={row?.basis ?? "PER_TRUCK"}
                  onValueChange={(v) =>
                    setValue(`trucking.${i}.basis`, v as TruckingBasis, {
                      shouldDirty: true,
                    })
                  }
                >
                  <SelectTrigger id={`trk-basis-${i}`} aria-label={`Basis for ${heading}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PER_TRUCK">Per truck</SelectItem>
                    <SelectItem value="PER_CBM">Per CBM</SelectItem>
                    <SelectItem value="PER_TON">Per ton</SelectItem>
                    <SelectItem value="FIXED">Fixed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Amount */}
            <div className="space-y-1">
              <label
                htmlFor={`trk-amount-${i}`}
                className="text-xs font-medium text-muted-foreground"
              >
                Amount
              </label>
              <NumberField
                id={`trk-amount-${i}`}
                aria-label={`Amount for ${heading}`}
                value={row?.amount ?? null}
                onChange={(v) => setValue(`trucking.${i}.amount`, v, { shouldDirty: true })}
              />
            </div>

            {/* Remarks */}
            <div className="space-y-1">
              <label
                htmlFor={`trk-remarks-${i}`}
                className="text-xs font-medium text-muted-foreground"
              >
                Remarks
              </label>
              <Textarea
                id={`trk-remarks-${i}`}
                aria-label={`Remarks for ${heading}`}
                placeholder="Remarks (optional)"
                {...register(`trucking.${i}.remarks` as const)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
