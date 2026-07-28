import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, Incoterms } from "@prisma/client";
import {
  QuoteStatus,
  QuoteEvent,
  LegEvent,
  LegStatus,
  type DistributeInput,
  type DistributeResult,
  type DistributeRfqEntry,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import type { RequestUser } from "../auth/types";
import { StatusService } from "../status/status.service";
import { RfqNumberService } from "./rfq-number.service";
import { RfqTokenService } from "./rfq-token.service";
import { loadLegForRfq, type LegRfqContext } from "./leg-context";
import { buildManifestSnapshot } from "./manifest";

@Injectable()
export class RfqService {
  private readonly DEFAULT_DEADLINE_MS = 48 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly status: StatusService,
    private readonly rfqNumber: RfqNumberService,
    private readonly token: RfqTokenService,
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
    const deadline = this.resolveDeadline(input.submissionDeadline);

    const ready: LegRfqContext[] = [];
    const skipped: { legId: string; reason: string }[] = [];
    for (const { id: legId } of legs) {
      const ctx = await loadLegForRfq(this.prisma, queryId, legId);
      if (ctx.freshQuotes.length === 0) {
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

    // F2 / F6 — nothing fresh to send
    if (ctx.freshQuotes.length === 0) {
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

    const deadline = this.resolveDeadline(input.submissionDeadline);
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

  private resolveDeadline(override?: string): Date {
    if (override) {
      const d = new Date(override);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        throw new BadRequestException("submissionDeadline must be a valid future datetime");
      }
      return d;
    }
    return new Date(Date.now() + this.DEFAULT_DEADLINE_MS);
  }

  private async performDistribution(
    query: { id: string; incoterms: Incoterms | null },
    legCtxs: LegRfqContext[],
    deadline: Date,
    user: RequestUser,
  ): Promise<DistributeResult> {
    const frozenAt = new Date();
    const byFf = new Map<string, { quoteId: string; legCtx: LegRfqContext }[]>();
    for (const legCtx of legCtxs) {
      for (const q of legCtx.freshQuotes) {
        const arr = byFf.get(q.freightForwarderId) ?? [];
        arr.push({ quoteId: q.id, legCtx });
        byFf.set(q.freightForwarderId, arr);
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

    return {
      rfqs: entries,
      distributedLegIds: [...new Set(entries.flatMap((e) => e.legIds))],
      skipped: [],
    };
  }
}
