import { Inject, Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  LegEvent,
  QuoteEvent,
  QuoteStatus,
  type ChangeRequest,
  type FindingScope,
  type ImpactDecision,
} from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import type { ChangeResult, UnitOfWork } from "./free-path.strategy";
import { PrismaService } from "../../prisma/prisma.service";
import { CHANGE_LOG, type ChangeLog } from "./change-log";
import { StatusService } from "../status/status.service";
import { buildManifestSnapshot } from "../rfq/manifest";
import { loadLegForRfq } from "../rfq/leg-context";

// The reopen-notification event (design §15). `apply` emits it (awaited); the SB5-side
// RfqNotificationsService consumes it via @OnEvent. It is an EVENT rather than a direct call
// on purpose: RfqModule already imports ChangesModule (for ImpactRegistry), so injecting the
// RfqModule-owned notifier into this ChangesModule provider would form a DI cycle. EventEmitter2
// is global, so the producer stays decoupled from RfqModule. `perFf` is structurally a
// LegReopenedFfGroup[] (Task 9) — kept inline to avoid a changes→rfq type import.
export interface ChangeOrderReopenedEvent {
  queryId: string;
  reason: string;
  perFf: { freightForwarderId: string; legIds: string[] }[];
}

// Stage 4+ cascade lands here: impact preview → confirm + reason → cascade to the
// minimal scope → drive `reopen` transitions (the seam) → invalidate quotes →
// durable change-log.
//
// Two-phase (§7.2 UX, §11.2): a request with no `reason` is a PREVIEW — compute the blast
// radius (which live quotes on the touched legs would be invalidated vs silently
// refreshed) and return it, applying NOTHING (`uow` is never invoked). A request WITH a
// `reason` is the real cascade, delegated to `apply` (§7): apply the edit + re-freeze the
// PENDING manifests + snapshot the invalidated pricing + record — all in one tx — then fire
// the quote INVALIDATE + leg REOPEN transitions (each owns its own tx), then notify.
@Injectable()
export class ChangeOrderStrategy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly status: StatusService,
    @Inject(CHANGE_LOG) private readonly changeLog: ChangeLog,
    private readonly events: EventEmitter2,
  ) {}

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
    req: ChangeRequest,
    decision: ImpactDecision,
    uow: UnitOfWork,
    invalidating: { quoteId: string; freightForwarderId: string }[],
    refreshing: { quoteId: string; freightForwarderId: string }[],
  ): Promise<ChangeResult> {
    const legIds = decision.scope
      .filter((s): s is FindingScope & { id: string } => s.type === "leg" && s.id !== undefined)
      .map((s) => s.id);
    const refreshingIds = refreshing.map((q) => q.quoteId);

    // (1) Snapshot the to-be-invalidated (QUOTED) pricing BEFORE any write — the durable
    // historical record (§11): on re-distribute the quote row is reused and its pricing
    // children overwritten, so this lightweight summary is the only surviving "what they bid".
    // `legId` rides along so the per-FF notify below can name each FF's reopened leg(s).
    const invalidatedSnaps = await this.prisma.quote.findMany({
      where: { id: { in: invalidating.map((q) => q.quoteId) } },
      select: {
        id: true,
        freightForwarderId: true,
        legId: true,
        grandTotal: true,
        totalChargeableWeightT: true,
        rfq: { select: { currency: true } },
      },
    });

    // (2) tx1 — the data change is atomic: apply the edit, re-freeze the PENDING manifests from
    // the NOW-updated rows, and write the ChangeLog. Status changes are NOT here: StatusService
    // .fire opens its own $transaction and Prisma cannot nest (§7, D7).
    await this.prisma.$transaction(async (tx) => {
      await uow(tx); // the caller's field edit — same uow the free path would have run

      const query = await tx.query.findUnique({
        where: { id: req.queryId! },
        select: { incoterms: true },
      });
      const frozenAt = new Date();
      for (const legId of legIds) {
        // Reload from THIS tx so the snapshot reflects the just-applied edit (loadLegForRfq
        // accepts a tx client). Only the RFQ_SENT (refreshing) quotes on the leg re-freeze;
        // the QUOTED (invalidating) ones keep their old snapshot as history.
        const ctx = await loadLegForRfq(tx, req.queryId!, legId);
        const snap = buildManifestSnapshot(ctx, query ?? { incoterms: null }, frozenAt);
        await tx.quote.updateMany({
          where: { legId, id: { in: refreshingIds } },
          data: { manifestSnapshot: snap as unknown as Prisma.InputJsonValue },
        });
      }

      await this.changeLog.record({
        queryId: req.queryId!,
        entity: req.entity,
        entityId: req.id,
        changeType: "change-order",
        actorId: req.actorId,
        payload: {
          field: req.field ?? null,
          action: req.action ?? null,
          impactClass: decision.class,
          reason: req.reason,
          affectedScope: decision.scope,
          invalidatedQuotes: invalidatedSnaps.map((q) => ({
            quoteId: q.id,
            freightForwarderId: q.freightForwarderId,
            grandTotal: q.grandTotal?.toString() ?? null,
            totalChargeableWeightT: q.totalChargeableWeightT?.toString() ?? null,
            currency: q.rfq?.currency ?? null,
          })),
          refreshedQuotes: refreshing,
        },
      });
    });

    // (3) AFTER tx1 commits — the status cascade, each fire in its own tx (§7, D7). Submitted
    // quotes are invalidated (must re-quote); the leg(s) reopen for re-distribution. The
    // QueryStatusProjector recomputes Query.status for free off `leg.status.changed`.
    for (const q of invalidating) {
      await this.status.fire("quote", q.quoteId, QuoteEvent.INVALIDATE, {
        queryId: req.queryId,
        actorId: req.actorId,
      });
    }
    for (const legId of legIds) {
      await this.status.fire("leg", legId, LegEvent.REOPEN, {
        queryId: req.queryId,
        actorId: req.actorId,
      });
    }

    // (4) Notify each invalidated FF about their reopened leg(s) (§15). Grouped per FF from the
    // pre-write snapshot (which carries legId). Awaited (emitAsync) so the compose-&-log lands
    // before apply returns; pending (RFQ_SENT) FFs are refreshed silently, re-notified only at
    // re-distribute (§11.4).
    const legsByFf = new Map<string, Set<string>>();
    for (const s of invalidatedSnaps) {
      const legs = legsByFf.get(s.freightForwarderId) ?? new Set<string>();
      legs.add(s.legId);
      legsByFf.set(s.freightForwarderId, legs);
    }
    const perFf = [...legsByFf].map(([freightForwarderId, legs]) => ({
      freightForwarderId,
      legIds: [...legs],
    }));
    const event: ChangeOrderReopenedEvent = { queryId: req.queryId!, reason: req.reason ?? "", perFf };
    await this.events.emitAsync("changeorder.leg.reopened", event);

    return { path: "change-order", class: decision.class, scope: decision.scope, findings: [] };
  }
}
