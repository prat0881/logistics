import { z } from "zod";
import { CURRENCY_CODES } from "../reference";
import { MASTER_STATUSES, type MasterStatus, type ContactDto } from "./contacts";

// Named WAREHOUSE_MASTER_TYPES / WarehouseMasterType, not WAREHOUSE_TYPES / WarehouseType:
// packages/shared/src/points.ts already exports WAREHOUSE_TYPES / WarehouseType for a Point's
// warehouse sub-classification (CONSOLIDATION/CROSS_DOCK/TEMPORARY_STORAGE/OTHER), consumed by
// apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx — a file this build must not
// touch. Both are re-exported through the same packages/shared barrel, so reusing the name
// would be a genuine ambiguous-export build break, not just a style clash. The two concepts
// are unrelated: this one is the Warehouse master's ownership/relationship type.
export const WAREHOUSE_MASTER_TYPES = ["OWNED", "CONTRACTED", "CLIENT", "FF"] as const;
export type WarehouseMasterType = (typeof WAREHOUSE_MASTER_TYPES)[number];

/** Contract and rate fields apply only to warehouses the organisation owns or contracts. */
export const CONTRACTED_TYPES: readonly WarehouseMasterType[] = ["OWNED", "CONTRACTED"];

export const CAPACITY_UNITS = ["CBM", "PALLETS", "SQ_FT", "MT"] as const;
export const HANDLING_UNITS = ["PER_PALLET", "PER_CBM", "PER_MT", "PER_SHIPMENT", "PER_PACKAGE"] as const;
export const STORAGE_UNITS = [
  "PER_CBM_DAY", "PER_CBM_MONTH", "PER_PALLET_DAY",
  "PER_PALLET_MONTH", "PER_SQ_FT_MONTH", "PER_MT_DAY",
] as const;
export const WAREHOUSE_CAPABILITIES = [
  "DG_COMPATIBLE", "TEMPERATURE_CONTROLLED", "HUMIDITY_CONTROLLED",
  "FIRE_FIGHTING", "REEFER_COLD_STORAGE", "CCTV_ACCESS",
] as const;

const baseWarehouse = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(WAREHOUSE_MASTER_TYPES),
  streetAddress: z.string().min(1).max(300),
  country: z.string().min(1).max(120),
  city: z.string().min(1).max(120),
  pinCode: z.string().min(1).max(20),
  capacity: z.number().positive(),
  capacityUnit: z.enum(CAPACITY_UNITS),
  capabilities: z.array(z.enum(WAREHOUSE_CAPABILITIES)).default([]),
  agreementValidUntil: z.string().datetime().optional(),
  insuranceValidUntil: z.string().datetime().optional(),
  isBonded: z.boolean().default(false),
  weekendWorking: z.boolean().default(false),
  weekendWorkingFee: z.number().nonnegative().optional(),
  workingEmployees: z.number().int().nonnegative().optional(),
  forkLiftCount: z.number().int().nonnegative().optional(),
  dipTrayCount: z.number().int().nonnegative().optional(),
  freeStorageDays: z.number().int().nonnegative().default(0),
  rateCurrency: z.enum(CURRENCY_CODES).optional(),
  handlingRate: z.number().nonnegative().optional(),
  handlingUnit: z.enum(HANDLING_UNITS).optional(),
  storageRate: z.number().nonnegative().optional(),
  storageUnit: z.enum(STORAGE_UNITS).optional(),
  status: z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional(),
});

/**
 * Conditional requirements live here rather than in the database: the columns must stay
 * nullable so CLIENT and FF warehouses can omit them entirely.
 */
export const warehouseCreateSchema = baseWarehouse.superRefine((v, ctx) => {
  if (CONTRACTED_TYPES.includes(v.type)) {
    for (const field of ["agreementValidUntil", "insuranceValidUntil"] as const) {
      if (!v[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Required for owned and contracted warehouses",
        });
      }
    }
  }
  const hasRate = v.handlingRate != null || v.storageRate != null || v.weekendWorkingFee != null;
  if (hasRate && !v.rateCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rateCurrency"],
      message: "A rate needs a currency",
    });
  }
  if (v.handlingRate != null && !v.handlingUnit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["handlingUnit"], message: "A handling rate needs a unit" });
  }
  if (v.storageRate != null && !v.storageUnit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["storageUnit"], message: "A storage rate needs a unit" });
  }
});

export const warehouseUpdateSchema = baseWarehouse.partial();
export type WarehouseCreateInput = z.input<typeof warehouseCreateSchema>;
export type WarehouseUpdateInput = z.input<typeof warehouseUpdateSchema>;

export const warehouseVehicleSchema = z.object({
  tonnage: z.string().min(1),
  quantity: z.number().int().positive(),
});
export type WarehouseVehicleInput = z.infer<typeof warehouseVehicleSchema>;

export interface WarehouseDto {
  id: string;
  name: string;
  type: WarehouseMasterType;
  freightForwarderId: string | null;
  clientId: string | null;
  streetAddress: string;
  country: string;
  city: string;
  pinCode: string;
  capacity: string;
  capacityUnit: (typeof CAPACITY_UNITS)[number];
  capabilities: (typeof WAREHOUSE_CAPABILITIES)[number][];
  freeStorageDays: number;
  status: MasterStatus;
  contacts?: ContactDto[];
  vehicles?: { id: string; tonnage: string; quantity: number }[];
  totalVehicles?: number;
}
