import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft, FfPortalEndpoint, TruckingType, TruckingBasis } from "@svyft/shared";
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
        const pointId = field.legEndpointPointId;
        const name =
          endpoints.find((e) => e.pointId === pointId)?.name ?? pointId;

        return (
          <div key={field.id} className="space-y-3 rounded-md border border-border p-4">
            <h4 className="text-sm font-semibold">{name}</h4>

            <div className="grid grid-cols-2 gap-3">
              {/* Trucking type */}
              <div className="space-y-1">
                <label htmlFor={`trk-type-${pointId}`} className="text-xs font-medium text-muted-foreground">Type</label>
                <Select
                  value={row?.truckingType ?? "DEDICATED"}
                  onValueChange={(v) =>
                    setValue(`trucking.${i}.truckingType`, v as TruckingType, {
                      shouldDirty: true,
                    })
                  }
                >
                  <SelectTrigger id={`trk-type-${pointId}`} aria-label={`Trucking type for ${name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DEDICATED">Dedicated</SelectItem>
                    <SelectItem value="GROUPAGE">Groupage</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Basis */}
              <div className="space-y-1">
                <label htmlFor={`trk-basis-${pointId}`} className="text-xs font-medium text-muted-foreground">Basis</label>
                <Select
                  value={row?.basis ?? "PER_TRUCK"}
                  onValueChange={(v) =>
                    setValue(`trucking.${i}.basis`, v as TruckingBasis, {
                      shouldDirty: true,
                    })
                  }
                >
                  <SelectTrigger id={`trk-basis-${pointId}`} aria-label={`Basis for ${name}`}>
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
              <label htmlFor={`trk-amount-${pointId}`} className="text-xs font-medium text-muted-foreground">Amount</label>
              <NumberField
                id={`trk-amount-${pointId}`}
                aria-label={`Amount for ${name}`}
                value={row?.amount ?? null}
                onChange={(v) =>
                  setValue(`trucking.${i}.amount`, v, { shouldDirty: true })
                }
              />
            </div>

            {/* Remarks */}
            <div className="space-y-1">
              <label htmlFor={`trk-remarks-${pointId}`} className="text-xs font-medium text-muted-foreground">Remarks</label>
              <Textarea
                id={`trk-remarks-${pointId}`}
                aria-label={`Remarks for ${name}`}
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
