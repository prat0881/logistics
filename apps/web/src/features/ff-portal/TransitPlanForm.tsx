import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft, FreightMode } from "@svyft/shared";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { toDatetimeLocal, fromDatetimeLocal } from "./format";

export interface TransitPlanFormProps {
  mode: FreightMode | null;
}

/**
 * Transit plan — mode-specific fields (design §7): Road plans a pickup date, Air plans a
 * flight, Sea plans a vessel voyage. Guaranteed Transit Time is the one field common to every
 * mode and is mandatory (the Q_TRANSIT gate, quote-engine.ts). The old generic
 * departureDate/arrivalDate/carrier/flightVoyageNo/carrierSurcharge inputs are dropped — fully
 * superseded by the mode-specific fields below (the underlying QuoteDraftTransit columns are
 * nullable and ungated, so dropping the inputs loses no data integrity).
 */
export function TransitPlanForm({ mode }: TransitPlanFormProps): JSX.Element {
  const { register, control, setValue } = useFormContext<QuoteDraft>();
  const transit = useWatch({ control, name: "transit" });

  return (
    <div className="space-y-4">
      {/* Guaranteed Transit Time — mandatory on every mode (Q_TRANSIT gate) */}
      <div className="space-y-1">
        <Label htmlFor="transit-guaranteed-days">
          Guaranteed Transit Time (days)
          <span className="text-destructive"> *</span>
        </Label>
        <NumberField
          id="transit-guaranteed-days"
          aria-required="true"
          value={transit?.guaranteedTransitDays ?? null}
          onChange={(v) => setValue("transit.guaranteedTransitDays", v, { shouldDirty: true })}
        />
      </div>

      {mode === "ROAD" && (
        <div className="space-y-1">
          <Label htmlFor="transit-planned-pickup">Planned Pickup Date</Label>
          <Input
            id="transit-planned-pickup"
            type="datetime-local"
            value={toDatetimeLocal(transit?.plannedPickupDate ?? null)}
            onChange={(e) =>
              setValue("transit.plannedPickupDate", fromDatetimeLocal(e.target.value), {
                shouldDirty: true,
              })
            }
          />
        </div>
      )}

      {mode === "AIR" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="transit-airline">Airline</Label>
            <Input
              id="transit-airline"
              placeholder="e.g. Emirates SkyCargo"
              {...register("transit.airline")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="transit-flight-number">Flight Number</Label>
            <Input
              id="transit-flight-number"
              placeholder="e.g. EK9701"
              {...register("transit.flightNumber")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="transit-planned-departure">Planned Departure</Label>
            <Input
              id="transit-planned-departure"
              type="datetime-local"
              value={toDatetimeLocal(transit?.plannedDeparture ?? null)}
              onChange={(e) =>
                setValue("transit.plannedDeparture", fromDatetimeLocal(e.target.value), {
                  shouldDirty: true,
                })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="transit-planned-arrival">Planned Arrival</Label>
            <Input
              id="transit-planned-arrival"
              type="datetime-local"
              value={toDatetimeLocal(transit?.plannedArrival ?? null)}
              onChange={(e) =>
                setValue("transit.plannedArrival", fromDatetimeLocal(e.target.value), {
                  shouldDirty: true,
                })
              }
            />
          </div>
        </>
      )}

      {mode === "SEA" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="transit-shipping-line">Shipping Line</Label>
            <Input
              id="transit-shipping-line"
              placeholder="e.g. Maersk"
              {...register("transit.shippingLine")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="transit-vessel-voyage">Vessel / Voyage</Label>
            <Input
              id="transit-vessel-voyage"
              placeholder="e.g. MSC Anna / 123W"
              {...register("transit.vesselVoyage")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="transit-etd">ETD</Label>
            <Input
              id="transit-etd"
              type="datetime-local"
              value={toDatetimeLocal(transit?.etd ?? null)}
              onChange={(e) =>
                setValue("transit.etd", fromDatetimeLocal(e.target.value), {
                  shouldDirty: true,
                })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="transit-eta">ETA</Label>
            <Input
              id="transit-eta"
              type="datetime-local"
              value={toDatetimeLocal(transit?.eta ?? null)}
              onChange={(e) =>
                setValue("transit.eta", fromDatetimeLocal(e.target.value), {
                  shouldDirty: true,
                })
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
