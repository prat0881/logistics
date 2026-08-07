import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft, ContainerSize } from "@svyft/shared";
import { CONTAINER_SIZES, containerSizeLabel, rateVariantLabel } from "@svyft/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { NumberField } from "./NumberField";

/**
 * Sea main-freight dual rate (design §7): two rows seeded by draftFromDto, one per
 * rateVariant (FCL/LCL) — no add/remove control, mirrors TruckingBlocks' Road blocks.
 * FCL additionally carries a container-size Select; LCL has none.
 */
export function SeaChargesPanel(): JSX.Element {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const { fields } = useFieldArray({ control, name: "seaRates" });
  const watchedSeaRates = useWatch({ control, name: "seaRates" });

  return (
    <div className="space-y-6">
      {fields.map((field, i) => {
        const row = watchedSeaRates?.[i];
        const rateVariant = row?.rateVariant ?? field.rateVariant;
        const heading = rateVariantLabel(rateVariant);

        return (
          <div key={field.id} className="space-y-3 rounded-md border border-border p-4">
            <div className="flex items-baseline justify-between">
              <h4 className="text-sm font-semibold">{heading}</h4>
            </div>

            {/* Container size — FCL only */}
            {rateVariant === "FCL" && (
              <div className="space-y-1">
                <label
                  htmlFor={`sea-container-${i}`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  Container size
                </label>
                <Select
                  value={row?.containerSize ?? ""}
                  onValueChange={(v) =>
                    setValue(`seaRates.${i}.containerSize`, v as ContainerSize, {
                      shouldDirty: true,
                    })
                  }
                >
                  <SelectTrigger
                    id={`sea-container-${i}`}
                    aria-label={`Container size for ${heading}`}
                  >
                    <SelectValue placeholder="Select container size" />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTAINER_SIZES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {containerSizeLabel(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Amount */}
            <div className="space-y-1">
              <label
                htmlFor={`sea-amount-${i}`}
                className="text-xs font-medium text-muted-foreground"
              >
                Amount
              </label>
              <NumberField
                id={`sea-amount-${i}`}
                aria-label={`Amount for ${heading}`}
                value={row?.amount ?? null}
                onChange={(v) => setValue(`seaRates.${i}.amount`, v, { shouldDirty: true })}
              />
            </div>

            {/* Remarks */}
            <div className="space-y-1">
              <label
                htmlFor={`sea-remarks-${i}`}
                className="text-xs font-medium text-muted-foreground"
              >
                Remarks
              </label>
              <Textarea
                id={`sea-remarks-${i}`}
                aria-label={`Remarks for ${heading}`}
                placeholder="Remarks (optional)"
                {...register(`seaRates.${i}.remarks` as const)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
