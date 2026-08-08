import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft, FreightMode, ChargeRateVariant } from "@svyft/shared";
import { variantsForMode, rateVariantLabel, AIR_VARIANT_KEY } from "@svyft/shared";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { toDatetimeLocal, fromDatetimeLocal } from "./format";
import { cn } from "@/lib/utils";

export interface TransitPlanFormProps {
  mode: FreightMode | null;
  // The rendered leg's id — prefixes every DOM `id` below so multiple same-mode legs on one portal
  // (FfPortalPage renders one LegSection per leg) don't collide (design §6 finding #4: duplicate
  // ids are invalid HTML and make a `<label htmlFor>` focus the wrong leg's field). Not shown to
  // the user; the human-readable disambiguator stays in each field's Label text (per variant).
  legId: string;
}

/** Column label matching ChargeMatrix's convention (rateVariantLabel for Road/Sea, "Air" for the
 *  single implicit column) — keeps each transit-days field's label aligned with the charge
 *  matrix's own column headers (design §6 finding #4: "matching the matrix's columns"). */
function variantLabel(v: ChargeRateVariant | null): string {
  return v ? rateVariantLabel(v) : "Air";
}

/**
 * Transit plan — mode-specific fields (design §7): Road plans a pickup date, Air plans a
 * flight, Sea plans a vessel voyage. Guaranteed Transit Time is mandatory (the Q_TRANSIT gate,
 * quote-engine.ts) and, per v3 (design §3.1/D3, §6 finding #4), **per rate variant** — one field
 * per column of the charge matrix (Road/Sea render Dedicated+Groupage or FCL+LCL side by side;
 * Air renders its single implicit column). The rest of the schedule (carrier/dates, mode-specific)
 * stays once per leg below — the old generic departureDate/arrivalDate/carrier/flightVoyageNo/
 * carrierSurcharge inputs are dropped, fully superseded by the mode-specific fields (the
 * underlying QuoteDraftTransit columns are nullable and ungated, so dropping the inputs loses no
 * data integrity).
 */
export function TransitPlanForm({ mode, legId }: TransitPlanFormProps): JSX.Element {
  const { register, control, setValue } = useFormContext<QuoteDraft>();
  const transit = useWatch({ control, name: "transit" });
  const variants = variantsForMode(mode);
  // Leg-qualified DOM id (finding #4): unique per rendered leg so same-mode legs don't clash.
  const fid = (name: string) => `${legId}-${name}`;

  return (
    <div className="space-y-6">
      {/* Guaranteed Transit Time — mandatory on every mode (Q_TRANSIT gate), one field per rate
          variant/column (design §6 finding #4) so e.g. Dedicated and Groupage can each commit to
          a different transit time; Air has a single implicit column. */}
      <div className={cn("grid gap-4", variants.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {variants.map((v) => {
          const variantKey = v ?? AIR_VARIANT_KEY;
          const id = fid(`transit-guaranteed-days-${variantKey}`);
          return (
            <div className="space-y-1" key={variantKey}>
              <Label htmlFor={id}>
                Guaranteed Transit Time (days) — {variantLabel(v)}
                <span className="text-destructive"> *</span>
              </Label>
              <NumberField
                id={id}
                aria-required="true"
                // Defensive `?.` before the index (beyond the `transit?.` guard): a draft saved
                // before this v3 field existed (e.g. a stale FfPortal.integration.test.tsx
                // fixture, or in principle a pre-migration persisted draft) can carry a `transit`
                // object with no `guaranteedTransitDaysByVariant` key at all, which would
                // otherwise throw indexing `undefined` rather than degrade to "unset".
                value={transit?.guaranteedTransitDaysByVariant?.[variantKey] ?? null}
                onChange={(val) =>
                  setValue(
                    `transit.guaranteedTransitDaysByVariant.${variantKey}`,
                    val ?? undefined,
                    {
                      shouldDirty: true,
                    },
                  )
                }
              />
            </div>
          );
        })}
      </div>

      {mode === "ROAD" && (
        <div className="space-y-1">
          <Label htmlFor={fid("transit-planned-pickup")}>Planned Pickup Date</Label>
          <Input
            id={fid("transit-planned-pickup")}
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={fid("transit-airline")}>Airline</Label>
              <Input
                id={fid("transit-airline")}
                placeholder="e.g. Emirates SkyCargo"
                {...register("transit.airline")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={fid("transit-flight-number")}>Flight Number</Label>
              <Input
                id={fid("transit-flight-number")}
                placeholder="e.g. EK9701"
                {...register("transit.flightNumber")}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={fid("transit-planned-departure")}>Planned Departure</Label>
              <Input
                id={fid("transit-planned-departure")}
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
              <Label htmlFor={fid("transit-planned-arrival")}>Planned Arrival</Label>
              <Input
                id={fid("transit-planned-arrival")}
                type="datetime-local"
                value={toDatetimeLocal(transit?.plannedArrival ?? null)}
                onChange={(e) =>
                  setValue("transit.plannedArrival", fromDatetimeLocal(e.target.value), {
                    shouldDirty: true,
                  })
                }
              />
            </div>
          </div>
        </>
      )}

      {mode === "SEA" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={fid("transit-shipping-line")}>Shipping Line</Label>
              <Input
                id={fid("transit-shipping-line")}
                placeholder="e.g. Maersk"
                {...register("transit.shippingLine")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={fid("transit-vessel-voyage")}>Vessel / Voyage</Label>
              <Input
                id={fid("transit-vessel-voyage")}
                placeholder="e.g. MSC Anna / 123W"
                {...register("transit.vesselVoyage")}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={fid("transit-etd")}>ETD</Label>
              <Input
                id={fid("transit-etd")}
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
              <Label htmlFor={fid("transit-eta")}>ETA</Label>
              <Input
                id={fid("transit-eta")}
                type="datetime-local"
                value={toDatetimeLocal(transit?.eta ?? null)}
                onChange={(e) =>
                  setValue("transit.eta", fromDatetimeLocal(e.target.value), {
                    shouldDirty: true,
                  })
                }
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
