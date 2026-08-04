import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma, Incoterms } from "@prisma/client";
import {
  QuoteStatus,
  QuoteEvent,
  LegEvent,
  LegStatus,
  type DistributeInput,
  type DistributeResult,
  type DistributeRfqEntry,
  type ReissueTokenResult,
  type QueryRfqStateDto,
  type FreightForwarderDto,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import type { RequestUser } from "../auth/types";
import { StatusService } from "../status/status.service";
import { CommsSettingsService } from "../comms/comms-settings.service";
import { ScheduledEventService } from "../comms/scheduled-event.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { RfqNumberService } from "./rfq-number.service";
import { RfqTokenService } from "./rfq-token.service";
import { loadLegForRfq, type LegRfqContext } from "./leg-context";
import { buildManifestSnapshot } from "./manifest";

@Injectable()
export class RfqService {
  private readonly logger = new Logger(RfqService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly status: StatusService,
    private readonly rfqNumber: RfqNumberService,
    private readonly token: RfqTokenService,
    private readonly commsSettings: CommsSettingsService,
    private readonly scheduled: ScheduledEventService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async setFfSelection(
    queryId: string,
    legId: string,
    ffIds: string[],
    user: RequestUser,
  ): Promise<{ selected: string[] }> {
    const leg = await this.prisma.leg.findFirst({ where: { id: legId, queryId }, select: { id: true } });
    if (!leg) throw new NotFoundException("Leg not found");

    const wanted = [...new Set(ffIds)];
    if (wanted.length) {
      const active = await this.prisma.freightForwarder.findMany({
        where: { id: { in: wanted }, status: "ACTIVE" },
        select: { id: true },
      });
      if (active.length !== wanted.length) {
        throw new BadRequestException("One or more freight forwarders are unknown or inactive");
      }
    }

    const existing = await this.prisma.quote.findMany({
      where: { legId },
      select: { id: true, freightForwarderId: true, status: true },
    });
    const selectRows = existing.filter((q) => q.status === QuoteStatus.SELECT);
    const frozen = new Set(
      existing.filter((q) => q.status !== QuoteStatus.SELECT).map((q) => q.freightForwarderId),
    );
    const currentSel = new Set(selectRows.map((q) => q.freightForwarderId));
    const toAdd = wanted.filter((id) => !currentSel.has(id) && !frozen.has(id));
    const toRemove = selectRows
      .filter((q) => !wanted.includes(q.freightForwarderId))
      .map((q) => q.id);

    await this.prisma.$transaction([
      ...(toRemove.length ? [this.prisma.quote.deleteMany({ where: { id: { in: toRemove } } })] : []),
      ...toAdd.map((ffId) =>
        this.prisma.quote.create({
          data: {
            queryId,
            legId,
            freightForwarderId: ffId,
            status: QuoteStatus.SELECT,
            tenantId: user.tenantId,
          },
        }),
      ),
    ]);

    const now = await this.prisma.quote.findMany({
      where: { legId, status: QuoteStatus.SELECT },
      select: { freightForwarderId: true },
    });
    return { selected: now.map((q) => q.freightForwarderId) };
  }

  async distributeAll(
    queryId: string,
    input: DistributeInput,
    user: RequestUser,
  ): Promise<DistributeResult> {
    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, incoterms: true },
    });
    if (!query) throw new NotFoundException("Query not found");

    const legs = await this.prisma.leg.findMany({ where: { queryId }, select: { id: true }, orderBy: { legCode: "asc" } });
    const deadline = await this.resolveDeadline(input.submissionDeadline);

    const ready: LegRfqContext[] = [];
    const skipped: { legId: string; reason: string }[] = [];
    for (const { id: legId } of legs) {
      const ctx = await loadLegForRfq(this.prisma, queryId, legId);
      // SB6 Task 11: a reopened leg with only INVALID (reactivatable) quotes is real work for
      // bulk "Distribute All" too, not a no-op skip — mirrors the same gate in distributeLeg.
      if (ctx.freshQuotes.length === 0 && ctx.invalidQuotes.length === 0) {
        skipped.push({
          legId,
          reason: ctx.sentQuotes.length ? "already-distributed" : "nothing-selected",
        });
        continue;
      }
      const errors = await this.validateLegForDistribution(ctx);
      if (errors.length) {
        skipped.push({ legId, reason: errors.join(",") });
        continue;
      }
      ready.push(ctx);
    }
    if (ready.length === 0) return { rfqs: [], distributedLegIds: [], skipped };

    const result = await this.performDistribution(query, ready, deadline, user);
    return { ...result, skipped: [...skipped, ...result.skipped] };
  }

  /**
   * Rotate an RFQ's access token (identity = query × FF) and record an audit row.
   * Recovery path: if the distribute response that carried the raw token was lost,
   * the token is unrecoverable (the hash is one-way) — this mints a fresh one.
   * Touches only accessTokenHash; deadline / status / quotes / manifest are intact.
   */
  async reissueToken(
    queryId: string,
    freightForwarderId: string,
    user: RequestUser,
  ): Promise<ReissueTokenResult> {
    return this.prisma.$transaction(async (tx) => {
      const rfq = await tx.rfq.findUnique({
        where: { queryId_freightForwarderId: { queryId, freightForwarderId } },
        select: { id: true, rfqNumber: true },
      });
      if (!rfq) throw new NotFoundException("No RFQ found for this freight forwarder on this query");
      const { token, hash } = this.token.mint();
      await tx.rfq.update({ where: { id: rfq.id }, data: { accessTokenHash: hash } });
      await tx.rfqTokenReissue.create({
        data: { rfqId: rfq.id, actorId: user.userId, tenantId: user.tenantId },
      });
      return { rfqId: rfq.id, rfqNumber: rfq.rfqNumber, freightForwarderId, accessToken: token };
    });
  }

  async getRfqState(queryId: string): Promise<QueryRfqStateDto> {
    const query = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!query) throw new NotFoundException("Query not found");

    const [quotes, rfqs] = await Promise.all([
      this.prisma.quote.findMany({ where: { queryId }, orderBy: { legId: "asc" } }),
      this.prisma.rfq.findMany({ where: { queryId }, orderBy: { rfqNumber: "asc" } }),
    ]);

    const ffIds = [...new Set(quotes.map((q) => q.freightForwarderId))];
    const ffs = ffIds.length
      ? await this.prisma.freightForwarder.findMany({ where: { id: { in: ffIds } }, orderBy: { companyName: "asc" } })
      : [];

    return {
      quotes: quotes.map((q) => ({
        id: q.id,
        queryId: q.queryId,
        legId: q.legId,
        freightForwarderId: q.freightForwarderId,
        rfqId: q.rfqId,
        status: q.status,
        submittedAt: q.submittedAt ? q.submittedAt.toISOString() : null,
      })),
      rfqs: rfqs.map((r) => ({
        id: r.id,
        queryId: r.queryId,
        freightForwarderId: r.freightForwarderId,
        rfqNumber: r.rfqNumber,
        submissionDeadline: r.submissionDeadline.toISOString(),
        incoterms: r.incoterms,
        currency: r.currency,
        quoteValidityUntil: r.quoteValidityUntil ? r.quoteValidityUntil.toISOString() : null,
      })),
      freightForwarders: ffs.map((f): FreightForwarderDto => ({
        id: f.id,
        freightForwarderCode: f.freightForwarderCode,
        companyName: f.companyName,
        companyAddress: f.companyAddress,
        city: f.city,
        postalCode: f.postalCode,
        country: f.country,
        pic: f.pic,
        contactNumber: f.contactNumber,
        email: f.email,
        availableCountries: f.availableCountries,
        modes: f.modes as FreightForwarderDto["modes"],
        handleDg: f.handleDg,
        vatTrnEori: f.vatTrnEori,
        whLocation: f.whLocation,
        defaultCurrency: f.defaultCurrency,
        paymentTerms: f.paymentTerms,
        typicalLeadTime: f.typicalLeadTime,
        status: f.status as FreightForwarderDto["status"],
      })),
    };
  }

  async distributeLeg(
    queryId: string,
    legId: string,
    input: DistributeInput,
    user: RequestUser,
  ): Promise<DistributeResult> {
    const ctx = await loadLegForRfq(this.prisma, queryId, legId);
    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, incoterms: true },
    });
    if (!query) throw new NotFoundException("Query not found");

    // F2 / F6 — nothing fresh AND nothing reactivatable (SB6 Task 11: a reopened leg's
    // INVALID quotes are re-sendable, same as a fresh SELECT — see `invalidQuotes` below)
    if (ctx.freshQuotes.length === 0 && ctx.invalidQuotes.length === 0) {
      if (ctx.sentQuotes.length > 0) {
        if (!input.confirm) {
          throw new ConflictException(
            "This leg's selected forwarders have already been sent this RFQ; confirm to proceed.",
          );
        }
        return { rfqs: [], distributedLegIds: [], skipped: [{ legId, reason: "already-distributed" }] };
      }
      throw new BadRequestException("Select at least one freight forwarder before distributing");
    }

    // F1 / F4 / F5
    const errors = await this.validateLegForDistribution(ctx);
    if (errors.length) {
      throw new BadRequestException({ message: "Leg is not ready for distribution", codes: errors });
    }

    const deadline = await this.resolveDeadline(input.submissionDeadline);
    return this.performDistribution(query, [ctx], deadline, user);
  }

  private async validateLegForDistribution(ctx: LegRfqContext): Promise<string[]> {
    const { leg } = ctx;
    const errors: string[] = [];
    // F1 — leg completeness (origin, destination, mode, >=1 cargo, dates)
    if (
      !leg.originPointId ||
      !leg.destinationPointId ||
      !leg.mode ||
      leg.legCargo.length === 0 ||
      !leg.readyDate ||
      !leg.targetDelivery
    ) {
      errors.push("F1_INCOMPLETE_LEG");
    }
    // F4 — leg has passed the Stage-3 validation gate (not DRAFT)
    if (leg.status === LegStatus.DRAFT) errors.push("F4_LEG_NOT_READY");
    // F5 — DG cargo requires every selected FF to handle DG
    if (ctx.hasDg) {
      const ffs = await this.prisma.freightForwarder.findMany({
        where: { id: { in: ctx.freshQuotes.map((q) => q.freightForwarderId) } },
        select: { handleDg: true },
      });
      if (ffs.some((f) => !f.handleDg)) errors.push("F5_DG_FF_CANNOT_HANDLE");
    }
    return errors;
  }

  private async resolveDeadline(override?: string): Promise<Date> {
    if (override) {
      const d = new Date(override);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        throw new BadRequestException("submissionDeadline must be a valid future datetime");
      }
      return d;
    }
    const hours = await this.commsSettings.rfqDeadlineHours();
    return new Date(Date.now() + hours * 60 * 60 * 1000);
  }

  private async performDistribution(
    query: { id: string; incoterms: Incoterms | null },
    legCtxs: LegRfqContext[],
    deadline: Date,
    user: RequestUser,
  ): Promise<DistributeResult> {
    const frozenAt = new Date();
    const byFf = new Map<string, { quoteId: string; legCtx: LegRfqContext }[]>();
    // SB6 Task 11 — FFs with an INVALID quote being reactivated in this call. Tracked
    // separately from `byFf` membership because the DEADLINE-reset decision below needs to
    // distinguish "amending an existing Rfq with a fresh leg" (leave the deadline alone, D3)
    // from "reactivating an existing Rfq's invalidated quote" (reset it, SB6 design §7).
    const reactivatingFfIds = new Set<string>();
    for (const legCtx of legCtxs) {
      for (const q of legCtx.freshQuotes) {
        const arr = byFf.get(q.freightForwarderId) ?? [];
        arr.push({ quoteId: q.id, legCtx });
        byFf.set(q.freightForwarderId, arr);
      }
      for (const q of legCtx.invalidQuotes) {
        const arr = byFf.get(q.freightForwarderId) ?? [];
        arr.push({ quoteId: q.id, legCtx });
        byFf.set(q.freightForwarderId, arr);
        reactivatingFfIds.add(q.freightForwarderId);
      }
    }

    const entries: DistributeRfqEntry[] = [];
    const quoteFires: string[] = [];
    const legFires = new Set<string>();

    await this.prisma.$transaction(async (tx) => {
      for (const [ffId, items] of byFf) {
        let rfq = await tx.rfq.findUnique({
          where: { queryId_freightForwarderId: { queryId: query.id, freightForwarderId: ffId } },
        });
        let minted = false;
        let accessToken: string | undefined;
        if (!rfq) {
          const rfqNumber = await this.rfqNumber.next(query.id, tx);
          const t = this.token.mint();
          accessToken = t.token;
          rfq = await tx.rfq.create({
            data: {
              queryId: query.id,
              freightForwarderId: ffId,
              rfqNumber,
              accessTokenHash: t.hash,
              submissionDeadline: deadline,
              incoterms: query.incoterms,
              tenantId: user.tenantId,
            },
          });
          minted = true;
        } else if (reactivatingFfIds.has(ffId)) {
          // SB6 §7 Phase 3 — reactivating an INVALID quote on an already-existing Rfq: give
          // the FF a fresh submission window (the same Rfq row, `rfqNumber` unchanged; SB5's
          // reminder/expiry ScheduledEvents re-arm below off this same `deadline`). A
          // fresh-quote-only amend (no reactivation) deliberately does NOT hit this branch —
          // it leaves an existing Rfq's deadline untouched (D3, rfq-distribute.e2e-spec.ts).
          rfq = await tx.rfq.update({ where: { id: rfq.id }, data: { submissionDeadline: deadline } });
        }
        const legIds = new Set<string>();
        for (const { quoteId, legCtx } of items) {
          const snapshot = buildManifestSnapshot(legCtx, query, frozenAt);
          await tx.quote.update({
            where: { id: quoteId },
            data: { rfqId: rfq.id, manifestSnapshot: snapshot as unknown as Prisma.InputJsonValue },
          });
          quoteFires.push(quoteId);
          legIds.add(legCtx.leg.id);
          if (legCtx.leg.status === LegStatus.READY_FOR_RFQ) legFires.add(legCtx.leg.id);
        }
        entries.push({
          freightForwarderId: ffId,
          rfqId: rfq.id,
          rfqNumber: rfq.rfqNumber,
          minted,
          accessToken,
          legIds: [...legIds],
        });
      }
    });

    // fire AFTER the tx — StatusService.fire owns its own transaction
    for (const quoteId of quoteFires) {
      await this.status.fire("quote", quoteId, QuoteEvent.SEND, { queryId: query.id });
    }
    for (const legId of legFires) {
      await this.status.fire("leg", legId, LegEvent.SEND_RFQ, { queryId: query.id });
    }

    // ── comms fan-out (post-commit; compose-&-log) ──
    const offsets = await this.commsSettings.rfqReminderOffsets();
    const base = process.env.PORTAL_BASE_URL ?? "";
    const deadlineIso = deadline.toISOString();
    for (const entry of entries) {
      try {
        const ff = await this.prisma.freightForwarder.findUnique({
          where: { id: entry.freightForwarderId },
          select: { email: true },
        });
        const legCodes = await this.prisma.leg.findMany({
          where: { id: { in: entry.legIds } },
          select: { legCode: true },
          orderBy: { legCode: "asc" },
        });
        const legNames = legCodes.map((l) => l.legCode).join(", ");

        // SB6 Task 11 — a reactivating FF's rfq.reminder/rfq.expiry ScheduledEvents from the
        // ORIGINAL distribution are still keyed to the OLD deadline. `schedule()`'s upsert
        // matches on (entityType, entityId, eventKey, tier) and does `update: {}` when a row
        // already exists — it never revises `dueAt`, `firedAt`, or `cancelledAt`. So a plain
        // `ScheduledEventService.cancel()` (soft: sets `cancelledAt`, row still exists) is NOT
        // enough — the very next `schedule()` call below would still match that (now-cancelled)
        // row by its unique key and no-op over it, leaving `dueAt` stale forever (empirically
        // verified: a cancel()-then-schedule() version of this fix left `rfq.expiry.dueAt`
        // pinned to the pre-reactivation deadline in this file's own e2e test). Delete the
        // stale rows outright instead, so `schedule()`'s upsert falls into its CREATE branch
        // and mints a genuinely fresh row (`firedAt`/`cancelledAt` null, `dueAt` = the new
        // deadline) — the only way to also cover the case where the old expiry already FIRED
        // (`cancel()`'s own WHERE clause requires `firedAt: null`, so it can never touch an
        // already-fired row at all, meaning `runDue()` — which only reads `firedAt: null` rows
        // — would otherwise never revisit this RFQ again). `ScheduledEventService` itself is
        // untouched; this uses the same injected `PrismaService` the rest of this method
        // already writes through.
        if (reactivatingFfIds.has(entry.freightForwarderId)) {
          await this.prisma.scheduledEvent.deleteMany({
            where: { entityType: "RFQ", entityId: entry.rfqId, eventKey: { in: ["rfq.reminder", "rfq.expiry"] } },
          });
        }

        // reminders (future tiers only) + one expiry, anchored to the RFQ
        await this.scheduled.schedule(
          "RFQ", entry.rfqId, "rfq.reminder",
          offsets.map((h) => ({ tier: `T${h}H`, dueAt: new Date(deadline.getTime() - h * 60 * 60 * 1000) })),
          { tenantId: user.tenantId },
        );
        await this.scheduled.schedule(
          "RFQ", entry.rfqId, "rfq.expiry",
          [{ tier: "DEADLINE", dueAt: deadline }],
          { tenantId: user.tenantId },
        );

        // invitation (fresh mint has the raw token) / updated (amend — no fresh link)
        if (entry.minted && entry.accessToken) {
          await this.dispatcher.dispatch("rfq.invitation", {
            scope: { entityType: "QUERY", entityId: query.id },
            tokens: {
              RFQ_Number: entry.rfqNumber,
              Leg_Names: legNames,
              Deadline: deadlineIso,
              Access_Link: `${base}/ff/rfq/${entry.accessToken}`,
            },
            recipients: { EMAIL: ff?.email ? [ff.email] : [] },
            tenantId: user.tenantId,
          });
        } else {
          await this.dispatcher.dispatch("rfq.updated", {
            scope: { entityType: "QUERY", entityId: query.id },
            tokens: { RFQ_Number: entry.rfqNumber, Leg_Names: legNames },
            recipients: { EMAIL: ff?.email ? [ff.email] : [] },
            tenantId: user.tenantId,
          });
        }
      } catch (err) {
        this.logger.error(`post-distribute comms failed for rfq ${entry.rfqId}`, err as Error);
      }
    }

    return {
      rfqs: entries,
      distributedLegIds: [...new Set(entries.flatMap((e) => e.legIds))],
      skipped: [],
    };
  }
}
