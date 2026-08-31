import { AwardDecisionStatus } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";

/** S5.9.5 (D5) — forwarder-facing copy, so vocabulary rule D5 applies with full force. The
 *  obvious phrasing here is "this leg has been awarded to another forwarder", and it is WRONG:
 *  nothing has been awarded, no forwarder has been notified, and the selection stays reversible
 *  until the client accepts. It also deliberately does not name who was selected — that is a
 *  competitor's commercial information, not this forwarder's to read. */
export const LEG_APPROVED_REASON =
  "This leg is no longer open for quoting — a forwarder has been selected.";

/**
 * S5.9.5 (D5) — which of the given quotes sit on a leg that is CLOSED to their forwarder, and
 * the forwarder-facing reason. Keyed by legId; a leg absent from the map is open.
 *
 * The ONE rule, in ONE place, so everything that has to answer "is this leg still open to this
 * forwarder?" gives the same answer: the DTO the portal renders, the guards that refuse its
 * writes (`FfPortalService.saveDraft`/`submit`), and the deadline reminders we send them
 * (`RfqScheduleListener.onReminder` — a forwarder shut out of every leg on an RFQ must not keep
 * getting "please submit your quote" for a portal that 409s them).
 *
 * A leg is closed to a forwarder iff its `LegAwardDecision` is `APPROVED` and the approved
 * (`shortlistedQuoteId`) offer is not this forwarder's own quote.
 *
 * - **`APPROVED` only — `PENDING_APPROVAL` does NOT close the leg** (D5, deliberate). A leg under
 *   checker review is not decided; a late submission from a rival merely adds an offer the
 *   checker can see. Do not "tighten" this.
 * - **The LEG closes, never the RFQ.** `Rfq` is `@@unique([queryId, freightForwarderId])`, so one
 *   RFQ covers every leg this forwarder holds on the query — hence the per-legId map rather than
 *   an RFQ-wide verdict. A forwarder approved on LEG-1 keeps quoting LEG-2, and their per-RFQ
 *   reminder timers rightly keep running for as long as ANY leg is still open to them.
 * - **The selected forwarder's own leg is NOT reported closed to them.** Nothing tells a
 *   forwarder they were selected (S5.9 D9: approval is silent and reversible), and their own
 *   quote is already `APPROVED`, which the portal's submit status-guard refuses on its own.
 *   Excluding them here keeps this from leaking the outcome to the one reader it would leak to.
 */
export async function closedLegReasons(
  prisma: PrismaService,
  quotes: { id: string; legId: string }[],
): Promise<Map<string, string>> {
  if (quotes.length === 0) return new Map();
  const decisions = await prisma.legAwardDecision.findMany({
    where: {
      legId: { in: quotes.map((q) => q.legId) },
      status: AwardDecisionStatus.APPROVED,
    },
    select: { legId: true, shortlistedQuoteId: true },
  });
  const winnerByLeg = new Map(decisions.map((d) => [d.legId, d.shortlistedQuoteId]));
  const closed = new Map<string, string>();
  for (const q of quotes) {
    if (winnerByLeg.has(q.legId) && winnerByLeg.get(q.legId) !== q.id) {
      closed.set(q.legId, LEG_APPROVED_REASON);
    }
  }
  return closed;
}
