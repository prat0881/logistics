// packages/shared/src/points.ts
import { z } from "zod";
import { isValidIanaZone } from "./timezone";

// Five reusable point types (D2). Single-table inheritance in the DB;
// per-type required fields enforced in the route engine (R8), not DB nullability.
export const PointType = {
  PICKUP: "PICKUP",
  DELIVERY: "DELIVERY",
  WAREHOUSE: "WAREHOUSE",
  AIRPORT: "AIRPORT",
  SEAPORT: "SEAPORT",
} as const;
export type PointType = (typeof PointType)[keyof typeof PointType];
export const POINT_TYPES = Object.values(PointType) as [PointType, ...PointType[]];

export const WarehouseType = {
  CONSOLIDATION: "CONSOLIDATION",
  CROSS_DOCK: "CROSS_DOCK",
  TEMPORARY_STORAGE: "TEMPORARY_STORAGE",
  OTHER: "OTHER",
} as const;
export type WarehouseType = (typeof WarehouseType)[keyof typeof WarehouseType];
export const WAREHOUSE_TYPES = Object.values(WarehouseType) as [WarehouseType, ...WarehouseType[]];

// Format validators (F2). Applied only when the field is present — a Draft point
// may be partial; per-type PRESENCE is gated at Create Query by the engine (R8).
const iata = z.string().regex(/^[A-Z]{3}$/, "IATA must be 3 uppercase letters");
const icao = z.string().regex(/^[A-Z]{4}$/, "ICAO must be 4 uppercase letters");
const unLocode = z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/, "UN/LOCODE must be 5 characters");
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164");

// `type` is the required discriminant (you pick a point type up front); every other
// field is optional here so drafts persist (matches querySaveSchema.partial()).
export const pointSaveSchema = z.object({
  type: z.enum(POINT_TYPES),
  name: z.string().trim().min(1).max(200).optional(),
  streetAddress: z.string().trim().min(1).max(300).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  postalCode: z.string().trim().min(1).max(30).optional(),
  country: z.string().trim().min(1).max(80).optional(),
  contactName: z.string().trim().min(1).max(120).optional(),
  contactPhone: phone.optional(),
  contactEmail: z.string().email().optional(),
  warehouseType: z.enum(WAREHOUSE_TYPES).optional(),
  iataCode: iata.optional(),
  icaoCode: icao.optional(),
  unLocode: unLocode.optional(),
  terminal: z.string().trim().min(1).max(120).optional(),
  timezone: z
    .string()
    .refine(isValidIanaZone, { message: "Must be a valid IANA timezone" })
    .optional(),
});
export type PointSaveInput = z.infer<typeof pointSaveSchema>;

// PATCH reuses the same shape, fully optional (type need not be resent on an edit), plus
// `reason` (Stage 4, SB6 §7.2): justification for a mediated edit that lands on the
// change-order path. update-only — a freshly-created point can't yet have live downstream
// work, so `pointSaveSchema` (create) is deliberately left untouched; PointsService lifts
// `reason` onto ChangeRequest.reason and strips it before the Prisma patch (not a column).
export const pointUpdateSchema = pointSaveSchema.partial().extend({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type PointUpdateInput = z.infer<typeof pointUpdateSchema>;

// Per-type mandatory fields (functional spec §7.4.1 A–E). The engine's R8 uses this at
// Create Query; DELIVERY email is optional; hubs need their code + city/postal/country.
export const POINT_REQUIRED_FIELDS: Record<PointType, (keyof PointSaveInput)[]> = {
  PICKUP: [
    "name",
    "streetAddress",
    "city",
    "postalCode",
    "country",
    "contactName",
    "contactPhone",
    "contactEmail",
    "timezone",
  ],
  DELIVERY: [
    "name",
    "streetAddress",
    "city",
    "postalCode",
    "country",
    "contactName",
    "contactPhone",
    "timezone",
  ],
  WAREHOUSE: ["name", "streetAddress", "city", "postalCode", "country", "timezone"],
  AIRPORT: ["name", "iataCode", "city", "postalCode", "country", "timezone"],
  SEAPORT: ["name", "unLocode", "city", "postalCode", "country", "timezone"],
};
