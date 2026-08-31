import { z } from "zod";

// Stage 5 (S5.5, design §10.1) — the negotiation/re-quote request body. A single free-text
// comment carried through to the FF (rendered into the rfq.requote_requested notification) and
// onto the audit trail (AwardDecisionEvent.reason). Same shape/bounds as rejectSchema (award.ts).
export const requestRequoteSchema = z.object({
  comment: z.string().trim().min(1).max(2000),
});
export type RequestRequoteInput = z.infer<typeof requestRequoteSchema>;
