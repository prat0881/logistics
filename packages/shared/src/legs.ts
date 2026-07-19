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
// assignedCargoIds are the D7 tick → LegCargo rows.
export const legSaveSchema = z.object({
  legName: z.string().max(120).optional(),
  originPointId: z.string().uuid().optional(),
  destinationPointId: z.string().uuid().optional(),
  mode: z.enum(FREIGHT_MODES).optional(),
  readyDate: isoDate.optional(),
  targetDelivery: isoDate.optional(),
  assignedCargoIds: z.array(z.string().uuid()).optional(),
});
export type LegSaveInput = z.infer<typeof legSaveSchema>;

// Stable, never reused within a query (spec §7.4.2). Minted from a per-query counter.
export function formatLegCode(seq: number): string {
  return `L${seq}`;
}
