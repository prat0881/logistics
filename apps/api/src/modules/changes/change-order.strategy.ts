import { Inject, Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  LegEvent,
  QuoteEvent,
  QuoteStatus,
  type ChangeRequest,
  type FindingScope,
  type ImpactDecision,
} from "@svyft/shared";
import { Prisma } from "@prisma/client";
import type { ChangeResult, UnitOfWork } from "./free-path.strategy";
import { PrismaService } from "../../prisma/prisma.service";
import { CHANGE_LOG, type ChangeLog } from "./change-log";
import { StatusService } from "../status/status.service";
import { buildManifestSnapshot } from "../rfq/manifest";
import { loadLegForRfq } from "../rfq/leg-context";
import { buildChargeConfigSnapshot } from "../rfq/charge-config.snapshot";

// The reopen-notification event (design §15). `apply` emits it (best-effort); the SB5-side
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
//
// BLAST-RADIUS NOTE (§11.3, minimal): `decision.scope` is the classifier's FANNED scope — for a
// query-wide edit that is EVERY leg of the query, for cargo/point every carrying/using leg,
// regardless of distribution status. `downstreamWork` (which gates the fork) is correctly true if
// ANY of those legs has a live quote, but the cascade itself must only touch the legs that
// ACTUALLY carry a live (RFQ_SENT/QUOTED) quote — `legsWithLiveQuotes`. Reopening a fanned-but-
// undistributed leg (DRAFT/AWARDED/…) has no REOPEN edge (→ IllegalTransitionError, after tx1 has
// already committed) or silently regresses a READY_FOR_RFQ leg to DRAFT — so REOPEN and the
// ChangeLog's affectedScope are both driven from `legsWithLiveQuotes`, never the raw fan.
@Injectable()
export class ChangeOrderStrategy {
  private readonly logger = new Logger(ChangeOrderStrategy.name);

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
      where: {
        legId: { in: legIds },
        // Stage 5 S5.5 Task 3 (§10.2 prereq): APPROVED (already-awarded) is live too — see
        // scope.resolver.ts's downstreamWork, the gate this query mirrors.
        status: { in: [QuoteStatus.RFQ_SENT, QuoteStatus.QUOTED, QuoteStatus.APPROVED] },
      },
      select: { id: true, freightForwarderId: true, legId: true, status: true },
    });
    // QUOTED and APPROVED are both INVALIDATED (re-quote required); only RFQ_SENT is merely
    // refreshed in place (still pending, never submitted). An APPROVED quote is a QUOTED one
    // that already cleared maker-checker — a change-order must undo the award the same way it
    // undoes an ordinary submission, which is exactly what §10.2's reversal listener (next task)
    // hooks off of via the leg REOPEN this fires below.
    const invalidating = quotes
      .filter((q) => q.status === QuoteStatus.QUOTED || q.status === QuoteStatus.APPROVED)
      .map((q) => ({ quoteId: q.id, freightForwarderId: q.freightForwarderId }));
    const refreshing = quotes
      .filter((q) => q.status === QuoteStatus.RFQ_SENT)
      .map((q) => ({ quoteId: q.id, freightForwarderId: q.freightForwarderId }));
    // The MINIMAL blast radius (§11.3): only the legs that ACTUALLY carry a live quote — NOT the
    // full classifier fan (`legIds`, which can include DRAFT/AWARDED legs with no REOPEN edge).
    // This is the set that reopens (below and in apply) and that the ChangeLog records.
    const legsWithLiveQuotes = [...new Set(quotes.map((q) => q.legId))];

    if (!req.reason) {
      return {
        path: "change-order",
        class: decision.class,
        scope: decision.scope,
        findings: [],
        needsConfirmation: true,
        preview: {
          affectedLegs: legsWithLiveQuotes,
          invalidatingQuotes: invalidating,
          refreshingQuotes: refreshing,
          impactClass: decision.class,
        },
      };
    }
    // apply branch → Task 8
    return this.apply(req, decision, uow, legsWithLiveQuotes, invalidating, refreshing);
  }

  private async apply(
    req: ChangeRequest,
    decision: ImpactDecision,
    uow: UnitOfWork,
    // The legs that actually carry a live quote (minimal blast radius) — the ONLY legs that
    // reopen. A subset of decision.scope; excludes fanned-but-undistributed legs (see class note).
    affectedLegs: string[],
    invalidating: { quoteId: string; freightForwarderId: string }[],
    refreshing: { quoteId: string; freightForwarderId: string }[],
  ): Promise<ChangeResult> {
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
      // Only the distributed legs (`affectedLegs`) re-freeze — a fanned undistributed leg has no
      // pending quote to refresh anyway; skipping it also avoids a pointless leg load.
      for (const legId of affectedLegs) {
        // Reload from THIS tx so the snapshot reflects the just-applied edit (loadLegForRfq
        // accepts a tx client). Only the RFQ_SENT (refreshing) quotes on the leg re-freeze;
        // the QUOTED (invalidating) ones keep their old snapshot as history.
        const ctx = await loadLegForRfq(tx, req.queryId!, legId);
        const snap = buildManifestSnapshot(ctx, query ?? { incoterms: null }, frozenAt);
        // Re-freeze the charge-config snapshot too (§5.5). A charge-selection / warehouse-toggle
        // change-order must rewrite chargeConfigSnapshot on the pending quotes — the manifest
        // carries NO charge/warehouse data, so without this a refreshed FF keeps a STALE charge
        // set and the portal (seeding + Q1) mis-prices. Built from the SAME tx-reloaded leg
        // (ctx.leg carries chargeSelections/mode/warehouseHandlingIncluded via LEG_RFQ_INCLUDE).
        const chargeConfig = await buildChargeConfigSnapshot(tx, ctx.leg, snap.cargo);
        await tx.quote.updateMany({
          where: { legId, id: { in: refreshingIds } },
          data: {
            manifestSnapshot: snap as unknown as Prisma.InputJsonValue,
            chargeConfigSnapshot: chargeConfig as unknown as Prisma.InputJsonValue,
            // Any change-order (mode/dates/cargo/charge-config/...) makes the FF's saved draft
            // stale — a mode change would otherwise leave stale trucking rows, a charge-config
            // change would leave a stale-priced or now-missing charge line (see ff-portal.service.ts
            // submit()'s stale-draft filter for the defense-in-depth half of this fix). Clearing
            // draftJson to SQL NULL (Prisma.DbNull, not JsonNull — this is a nullable Json column
            // going to DB NULL) makes the reopened FF re-seed cleanly from the fresh
            // manifestSnapshot/chargeConfigSnapshot: the client's draftFromDto takes the
            // non-draft seeding branch whenever leg.draft is absent.
            draftJson: Prisma.DbNull,
          },
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
          // The legs actually reopened (minimal blast radius), NOT the raw classifier fan.
          affectedScope: affectedLegs.map((id) => ({ type: "leg", id })),
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
    // quotes are invalidated (must re-quote); the distributed leg(s) reopen for re-distribution.
    // The QueryStatusProjector recomputes Query.status for free off `leg.status.changed`.
    for (const q of invalidating) {
      await this.status.fire("quote", q.quoteId, QuoteEvent.INVALIDATE, {
        queryId: req.queryId,
        actorId: req.actorId,
      });
    }
    for (const legId of affectedLegs) {
      await this.status.fire("leg", legId, LegEvent.REOPEN, {
        queryId: req.queryId,
        actorId: req.actorId,
      });
    }

    // (4) Notify each invalidated FF about their reopened leg(s) (§15). Grouped per FF from the
    // pre-write snapshot (which carries legId). Best-effort: the cascade (edit + invalidate +
    // reopen + record) is already durably committed, so a notify-handler failure must NOT bubble
    // up as a 500 for an applied change — log and move on. Pending (RFQ_SENT) FFs are refreshed
    // silently, re-notified only at re-distribute (§11.4).
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
    const event: ChangeOrderReopenedEvent = {
      queryId: req.queryId!,
      reason: req.reason ?? "",
      perFf,
    };
    try {
      await this.events.emitAsync("changeorder.leg.reopened", event);
    } catch (err) {
      this.logger.warn(
        `change-order reopen notification failed for query ${req.queryId} (cascade already applied): ${(err as Error).message}`,
      );
    }

    return { path: "change-order", class: decision.class, scope: decision.scope, findings: [] };
  }
}
