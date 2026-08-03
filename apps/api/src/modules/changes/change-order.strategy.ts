import { Injectable } from "@nestjs/common";
import { QuoteStatus, type ChangeRequest, type FindingScope, type ImpactDecision } from "@svyft/shared";
import type { ChangeResult, UnitOfWork } from "./free-path.strategy";
import { PrismaService } from "../../prisma/prisma.service";

// Stage 4+ cascade lands here: impact preview → confirm + reason → cascade to the
// minimal scope → drive `reopen` transitions (the seam) → invalidate quotes →
// durable change-log.
//
// Two-phase (§7.2 UX, §11.2): a request with no `reason` is a PREVIEW — compute the blast
// radius (which live quotes on the touched legs would be invalidated vs silently
// refreshed) and return it, applying NOTHING (`uow` is never invoked). A request WITH a
// `reason` is the real cascade, delegated to `apply` — stubbed here (Task 8's saga) so
// this file compiles standalone.
@Injectable()
export class ChangeOrderStrategy {
  constructor(private readonly prisma: PrismaService) {}

  async run(req: ChangeRequest, decision: ImpactDecision, uow: UnitOfWork): Promise<ChangeResult> {
    // decision.scope is always leg-typed here (Task 2's classifier fan-out); id is
    // optional on FindingScope in general, so narrow it the same way ScopeResolver does.
    const legIds = decision.scope
      .filter((s): s is FindingScope & { id: string } => s.type === "leg" && s.id !== undefined)
      .map((s) => s.id);

    const quotes = await this.prisma.quote.findMany({
      where: { legId: { in: legIds }, status: { in: [QuoteStatus.RFQ_SENT, QuoteStatus.QUOTED] } },
      select: { id: true, freightForwarderId: true, status: true },
    });
    const invalidating = quotes
      .filter((q) => q.status === QuoteStatus.QUOTED)
      .map((q) => ({ quoteId: q.id, freightForwarderId: q.freightForwarderId }));
    const refreshing = quotes
      .filter((q) => q.status === QuoteStatus.RFQ_SENT)
      .map((q) => ({ quoteId: q.id, freightForwarderId: q.freightForwarderId }));

    if (!req.reason) {
      return {
        path: "change-order",
        class: decision.class,
        scope: decision.scope,
        findings: [],
        needsConfirmation: true,
        preview: {
          affectedLegs: legIds,
          invalidatingQuotes: invalidating,
          refreshingQuotes: refreshing,
          impactClass: decision.class,
        },
      };
    }
    // apply branch → Task 8
    return this.apply(req, decision, uow, invalidating, refreshing);
  }

  private async apply(
    _req: ChangeRequest,
    _decision: ImpactDecision,
    _uow: UnitOfWork,
    _invalidating: { quoteId: string; freightForwarderId: string }[],
    _refreshing: { quoteId: string; freightForwarderId: string }[],
  ): Promise<ChangeResult> {
    throw new Error("apply not implemented");
  }
}
