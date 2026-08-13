// packages/shared/src/legs.ts
import { z } from "zod";
import { FREIGHT_MODES } from "./config";

// Tracking model only (spec §12); UI is Stage 8–9. Stored column, no transitions in Stage 3.
export const LegExecutionStatus = {
  PENDING: "PENDING",
  IN_TRANSIT: "IN_TRANSIT",
  COMPLETED: "COMPLETED",
} as const;
export type LegExecutionStatus = (typeof LegExecutionStatus)[keyof typeof LegExecutionStatus];
export const LEG_EXECUTION_STATUSES = Object.values(LegExecutionStatus) as [
  LegExecutionStatus,
  ...LegExecutionStatus[],
];

const isoDate = z.string().datetime({ offset: true });

// All optional — legs are saved individually and may be partial/draft (D8, spec §7.4.3).
// legCode is minted server-side (never client-supplied). mode reuses FreightMode (D3).
// assignedPackageIds are the D7 tick → LegPackage rows.
export const legSaveSchema = z
  .object({
    legName: z.string().max(120).optional(),
    originPointId: z.string().uuid().optional(),
    destinationPointId: z.string().uuid().optional(),
    mode: z.enum(FREIGHT_MODES).optional(),
    readyDate: isoDate.optional(),
    targetDelivery: isoDate.optional(),
    assignedPackageIds: z.array(z.string().uuid()).optional(),
    // Task 11 (Charge Configuration & Warehouse Attribution, Phase E): per-leg warehouse
    // toggle + charge-line selection set, both routed through the mediated update below as
    // RfqDefining (leg.impact.ts) — free pre-distribute, change-order-gated post-distribute.
    warehouseHandlingIncluded: z.boolean().nullable().optional(),
    chargeLineDefinitionIds: z.array(z.string().uuid()).optional(),
    // Stage 4 (SB6 §7.2): justification for a mediated edit that lands on the change-order
    // path. Metadata only — LegsService lifts it onto ChangeRequest.reason and strips it
    // before it ever reaches the Prisma patch (it is not a `leg` column).
    reason: z.string().trim().min(1).max(500).optional(),
  })
  // G10: Ready Date must be on or before Target Delivery (when both are present).
  // NOTE: leg-level field, labelled "Ready Date" in the Leg editor — kept as "Ready Date"
  // (S3.5 renamed only the QUERY-screen field/message, which is labelled "Target Pickup").
  .refine(
    (l) =>
      !(l.readyDate && l.targetDelivery) ||
      new Date(l.readyDate).getTime() <= new Date(l.targetDelivery).getTime(),
    { message: "Ready Date must be on or before Target Delivery", path: ["targetDelivery"] },
  )
  // G12: a leg's origin and destination must be different points (no self-loop).
  .refine(
    (l) => !(l.originPointId && l.destinationPointId) || l.originPointId !== l.destinationPointId,
    {
      message: "A leg's origin and destination must be different points",
      path: ["destinationPointId"],
    },
  );
export type LegSaveInput = z.infer<typeof legSaveSchema>;

// Stable, never reused within a query (spec §7.4.2). Minted from a per-query counter.
export function formatLegCode(seq: number): string {
  return `L${seq}`;
}
