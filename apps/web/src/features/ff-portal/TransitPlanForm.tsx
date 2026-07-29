import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { toDatetimeLocal, fromDatetimeLocal } from "./format";

export function TransitPlanForm(): JSX.Element {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const transit = useWatch({ control, name: "transit" });

  return (
    <div className="space-y-4">
      {/* Departure date */}
      <div className="space-y-1">
        <Label htmlFor="transit-departure">Departure</Label>
        <Input
          id="transit-departure"
          type="datetime-local"
          value={toDatetimeLocal(transit?.departureDate ?? null)}
          onChange={(e) =>
            setValue("transit.departureDate", fromDatetimeLocal(e.target.value), {
              shouldDirty: true,
            })
          }
        />
      </div>

      {/* Arrival date */}
      <div className="space-y-1">
        <Label htmlFor="transit-arrival">Arrival</Label>
        <Input
          id="transit-arrival"
          type="datetime-local"
          value={toDatetimeLocal(transit?.arrivalDate ?? null)}
          onChange={(e) =>
            setValue("transit.arrivalDate", fromDatetimeLocal(e.target.value), {
              shouldDirty: true,
            })
          }
        />
      </div>

      {/* Carrier (optional) */}
      <div className="space-y-1">
        <Label htmlFor="transit-carrier">Carrier</Label>
        <Input
          id="transit-carrier"
          placeholder="e.g. Emirates SkyCargo"
          {...register("transit.carrier")}
        />
      </div>

      {/* Flight / Voyage number (optional) */}
      <div className="space-y-1">
        <Label htmlFor="transit-flight-voyage">Flight / Voyage No.</Label>
        <Input
          id="transit-flight-voyage"
          placeholder="e.g. EK9701"
          {...register("transit.flightVoyageNo")}
        />
      </div>

      {/* Carrier surcharge (optional) */}
      <div className="space-y-1">
        <Label htmlFor="transit-carrier-surcharge">Carrier Surcharge</Label>
        <NumberField
          id="transit-carrier-surcharge"
          value={transit?.carrierSurcharge ?? null}
          onChange={(v) =>
            setValue("transit.carrierSurcharge", v, { shouldDirty: true })
          }
        />
      </div>

      {/* Guaranteed transit days (optional) */}
      <div className="space-y-1">
        <Label htmlFor="transit-guaranteed-days">Guaranteed Transit Days</Label>
        <NumberField
          id="transit-guaranteed-days"
          value={transit?.guaranteedTransitDays ?? null}
          onChange={(v) =>
            setValue("transit.guaranteedTransitDays", v, { shouldDirty: true })
          }
        />
      </div>
    </div>
  );
}
