import { z } from "zod";
import type { QuoteStatus } from "./status";
import type { Incoterms } from "./query";
import type { FreightMode } from "./config";
import type { FreightForwarderDto } from "./masters";
import type { ReferenceTag } from "./cargo";

export interface ManifestSnapshotCargo {
  packageId: string;
  packageNo: string;
  packageType: string;
  packageCount: number;
  dimL: string; // canonical cm
  dimW: string;
  dimH: string;
  netWt: string | null; // canonical kg
  grossWt: string;
  volumeCbm: string | null; // m³
  tags: ReferenceTag[]; // effectiveTags(package ∪ items), incl. DG
}

export interface ManifestSnapshot {
  legId: string;
  legCode: string;
  legName: string | null;
  mode: FreightMode | null;
  incoterms: Incoterms | null;
  origin: { country: string | null; name: string | null; city: string | null } | null;
  destination: { country: string | null; name: string | null; city: string | null } | null;
  readyDate: string | null;
  targetDelivery: string | null;
  cargo: ManifestSnapshotCargo[];
  frozenAt: string;
}

export interface DistributeRfqEntry {
  freightForwarderId: string;
  rfqId: string;
  rfqNumber: string;
  minted: boolean; // true = new RFQ (invitation); false = amended (D3 "RFQ Updated")
  accessToken?: string; // raw 256-bit token, present ONLY when minted (goes into the link, SB5)
  legIds: string[];
}

export interface DistributeResult {
  rfqs: DistributeRfqEntry[];
  distributedLegIds: string[];
  skipped: { legId: string; reason: string }[];
}

export const distributeSchema = z.object({
  submissionDeadline: z.string().datetime().optional(),
  confirm: z.boolean().optional(),
});
export type DistributeInput = z.infer<typeof distributeSchema>;

export const ffSelectionSchema = z.object({ ffIds: z.array(z.string().uuid()) });
export type FfSelectionInput = z.infer<typeof ffSelectionSchema>;

export const reissueTokenSchema = z.object({ freightForwarderId: z.string().uuid() });
export type ReissueTokenInput = z.infer<typeof reissueTokenSchema>;

/** Result of rotating an RFQ's access token (identity = queryId × freightForwarderId). */
export interface ReissueTokenResult {
  rfqId: string;
  rfqNumber: string;
  freightForwarderId: string;
  accessToken: string; // the new raw 256-bit token, returned once
}

/** One FF's RFQ for a query (identity = queryId × freightForwarderId). */
export interface RfqDto {
  id: string;
  queryId: string;
  freightForwarderId: string;
  rfqNumber: string;
  submissionDeadline: string; // ISO
  incoterms: Incoterms | null;
  currency: string | null;
  quoteValidityUntil: string | null; // ISO
}

/** The atomic unit: one FF's engagement with one leg. status = Forwarder status. */
export interface QuoteDto {
  id: string;
  queryId: string;
  legId: string;
  freightForwarderId: string;
  rfqId: string | null; // null while SELECT (pre-distribute)
  status: QuoteStatus;
  submittedAt: string | null; // ISO
}

/** Read model that hydrates the Query Workspace grid: all quotes + RFQs for a
 *  query, plus the FF-card data for every FF referenced by a quote (so a frozen
 *  FF renders even when it is no longer in the filtered eligible list). */
export interface QueryRfqStateDto {
  quotes: QuoteDto[];
  rfqs: RfqDto[];
  freightForwarders: FreightForwarderDto[];
}
