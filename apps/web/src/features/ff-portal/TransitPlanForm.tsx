import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft, FreightMode, TransitVariantKey } from "@svyft/shared";
import {
  variantsForTransit,
  rateVariantLabel,
  AIR_VARIANT_KEY,
  SEA_VARIANT_KEY,
} from "@svyft/shared";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { toDatetimeLocal, fromDatetimeLocal, nowDatetimeLocal } from "./format";
import { cn } from "@/lib/utils";

export interface TransitPlanFormProps {
  mode: FreightMode | null;
  // The rendered leg's id — prefixes every DOM `id` below so multiple same-mode legs on one portal
  // (FfPortalPage renders one LegSection per leg) don't collide (design §6 finding #4: duplicate
  // ids are invalid HTML and make a `<label htmlFor>` focus the wrong leg's field). Not shown to
  // the user; the human-readable disambiguator stays in each field's Label text (per variant).
  legId: string;
}

/** Column label for a Guaranteed Transit Time field, keyed by variantsForTransit(mode)'s
 *  TransitVariantKey (design D2, v4): Road's two real ChargeRateVariant members get the same
 *  Dedicated/Groupage labels the charge matrix uses; Sea's ONE common slot reads "Sea" (a single
 *  GTT covers both FCL/LCL — a ship doesn't arrive twice); Air's single implicit column reads
 *  "Air". Distinct from `variantsForMode`'s freight-rate columns, which stay per-variant for Sea. */
function variantLabel(v: TransitVariantKey): string {
  if (v === AIR_VARIANT_KEY) return "Air";
  if (v === SEA_VARIANT_KEY) return "Sea";
  return rateVariantLabel(v);
}

/**
 * Transit plan — mode-specific fields (design §7): Road plans a pickup date, Air plans a
 * flight, Sea plans a vessel voyage. Guaranteed Transit Time is mandatory (the Q_TRANSIT gate,
 * quote-engine.ts) and keyed by `variantsForTransit(mode)` (design D2, v4): Road renders one field
 * per rate variant (Dedicated + Groupage, matching the charge matrix's columns); Sea renders ONE
 * common field (FCL and LCL ride the same vessel/voyage, so a second independent GTT had no
 * real-world meaning — v3 rendered two, this is the v4 reversal); Air renders its single implicit
 * column. The rest of the schedule (carrier/dates, mode-specific) stays once per leg below — the
 * old generic departureDate/arrivalDate/carrier/flightVoyageNo/carrierSurcharge inputs are
 * dropped, fully superseded by the mode-specific fields (the underlying QuoteDraftTransit columns
 * are nullable and ungated, so dropping the inputs loses no data integrity).
 */
export function TransitPlanForm({ mode, legId }: TransitPlanFormProps): JSX.Element {
  const { register, control, setValue } = useFormContext<QuoteDraft>();
  const transit = useWatch({ control, name: "transit" });
  const variants = variantsForTransit(mode);
  // Leg-qualified DOM id (finding #4): unique per rendered leg so same-mode legs don't clash.
  const fid = (name: string) => `${legId}-${name}`;
  // No-past-date client gate (design D3, finding #10): the `min` every datetime-local field below
  // uses so the picker can't offer a past moment — computed once per render and reused across
  // every field on this pass (see format.ts's nowDatetimeLocal). The engine's unconditional
  // Q_PAST_DATE rule (quote-engine.ts's validateQuote) is the enforcement half this can't bypass.
  const nowLocal = nowDatetimeLocal();

  return (
    <div className="space-y-6">
      {/* Guaranteed Transit Time — mandatory on every mode (Q_TRANSIT gate), keyed by
          variantsForTransit(mode) (design D2): Road one field per rate variant/column so
          Dedicated and Groupage can each commit to a different transit time; Sea ONE common
          field; Air a single implicit column. */}
      <div className={cn("grid gap-4", variants.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {variants.map((variantKey) => {
          const id = fid(`transit-guaranteed-days-${variantKey}`);
          return (
            <div className="space-y-1" key={variantKey}>
              <Label htmlFor={id}>
                Guaranteed Transit Time (days) — {variantLabel(variantKey)}
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
            min={nowLocal}
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
                min={nowLocal}
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
                min={nowLocal}
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
                min={nowLocal}
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
                min={nowLocal}
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
