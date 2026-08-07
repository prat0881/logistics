import { z } from "zod";
import type { FreightMode } from "./config";
import type { QuoteStatus } from "./status";
import type { ManifestSnapshot } from "./rfq";
import type { ChargeZone, WarehousePosition, QuoteDraft } from "./quote";
import type { ChargeLineInputType } from "./charge-config";
import {
  CHARGE_ZONES,
  TRUCKING_TYPES,
  TRUCKING_BASES,
  WAREHOUSE_POSITIONS,
  CHARGE_RATE_VARIANTS,
  TRUCK_TONNAGES,
  CONTAINER_SIZES,
  WAREHOUSE_SIDES,
  BILL_OF_LADING_TYPES,
} from "./quote";

// ── GET /ff/rfq/:token response ──
export interface FfPortalEndpoint {
  pointId: string;
  type: string; // PointType (PICKUP|DELIVERY|WAREHOUSE|AIRPORT|SEAPORT)
  name: string | null;
  country: string | null;
  warehousePosition: WarehousePosition | null; // set for WAREHOUSE endpoints, else null
}
export interface FfPortalSeededCharge {
  zone: ChargeZone | null;
  definitionKey?: string; // optional in the TYPE only so the pre-Task-9 seeding compiles; always set from Task 9 on
  inputType?: ChargeLineInputType; // PLAIN or HEAVY_WEIGHT_CALC; TRUCKING/WAREHOUSE_STAGING seed via endpoints, not here
  presetKey: string | null; // null for catalogue lines (kept for shape compatibility)
  label: string;
  isPreset: true;
  amount: null;
}
export interface FfPortalLegDto {
  legId: string;
  quoteId: string;
  status: QuoteStatus;
  mode: FreightMode | null;
  manifest: ManifestSnapshot;
  endpoints: FfPortalEndpoint[];
  seededCharges: FfPortalSeededCharge[];
  warehouseIncluded?: boolean; // frozen Leg warehouse decision (design §9); optional so pre-Task-9 build stays green, set from Task 9 on
  draft: QuoteDraft | null;
}
export interface FfPortalRfqDto {
  rfqNumber: string;
  incoterms: string | null;
  submissionDeadline: string; // ISO
  currency: string | null; // Rfq.currency ?? FF.defaultCurrency
  quoteValidityUntil: string | null;
  freightForwarder: { companyName: string };
  legs: FfPortalLegDto[];
}

// ── PATCH body shape-check (NOT the Q1–Q8 business rules; those are submit-only) ──
export const quoteDraftSchema: z.ZodType<QuoteDraft> = z.object({
  legId: z.string(),
  mode: z.string().nullable(), // authoritative mode is re-derived from the manifest at submit
  currency: z.string().nullable(),
  quoteValidityUntil: z.string().nullable(),
  cargo: z.array(
    z.object({
      packageId: z.string(),
      grossWtKg: z.number(),
      cbm: z.number(),
      chargedWeightKg: z.number().nullable(),
    }),
  ),
  charges: z.array(
    z.object({
      zone: z.enum(CHARGE_ZONES).nullable(),
      definitionKey: z.string().nullable().optional(),
      presetKey: z.string().nullable(),
      label: z.string(),
      amount: z.number().nullable(),
      note: z.string().optional(),
      billOfLadingType: z.enum(BILL_OF_LADING_TYPES).nullable().optional(),
      pieceWeightKg: z.number().nullable().optional(),
      airlineLimitKg: z.number().nullable().optional(),
      ratePerExcessKg: z.number().nullable().optional(),
    }),
  ),
  trucking: z.array(
    z.object({
      legEndpointPointId: z.string(),
      truckingType: z.enum(TRUCKING_TYPES),
      basis: z.enum(TRUCKING_BASES),
      amount: z.number().nullable(),
      remarks: z.string().optional(),
      rateVariant: z.enum(CHARGE_RATE_VARIANTS),
      tonnage: z.enum(TRUCK_TONNAGES).nullable(),
    }),
  ),
  seaRates: z.array(
    z.object({
      rateVariant: z.enum(CHARGE_RATE_VARIANTS),
      containerSize: z.enum(CONTAINER_SIZES).nullable(),
      amount: z.number().nullable(),
      remarks: z.string().optional(),
    }),
  ),
  warehouse: z.array(
    z.object({
      warehousePointId: z.string(),
      position: z.enum(WAREHOUSE_POSITIONS),
      label: z.string(),
      amount: z.number().nullable(),
      cargoAcceptanceWindow: z.string().optional(),
      cfsCode: z.string().nullable().optional(),
      side: z.enum(WAREHOUSE_SIDES).nullable().optional(),
    }),
  ),
  transit: z
    .object({
      departureDate: z.string().nullable(),
      arrivalDate: z.string().nullable(),
      carrier: z.string().nullable().optional(),
      flightVoyageNo: z.string().nullable().optional(),
      carrierSurcharge: z.number().nullable().optional(),
      guaranteedTransitDays: z.number().nullable(),
      plannedPickupDate: z.string().nullable().optional(),
      airline: z.string().nullable().optional(),
      flightNumber: z.string().nullable().optional(),
      plannedDeparture: z.string().nullable().optional(),
      plannedArrival: z.string().nullable().optional(),
      shippingLine: z.string().nullable().optional(),
      vesselVoyage: z.string().nullable().optional(),
      etd: z.string().nullable().optional(),
      eta: z.string().nullable().optional(),
    })
    .nullable(),
  dgSurchargeNote: z.string().nullable(),
  termsConditions: z.string().nullable(),
}) as z.ZodType<QuoteDraft>;
