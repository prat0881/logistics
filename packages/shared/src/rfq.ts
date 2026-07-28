import type { QuoteStatus } from "./status";
import type { Incoterms } from "./query";

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
