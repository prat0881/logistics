import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, Quotation } from "@prisma/client";
import {
  buildQuotationCostLines,
  priceQuotation,
  rateVariantLabel,
  type QueryAwardSnapshot,
  type QuotationCostGroup,
  type QuotationDto,
  type QuotationPatch,
  type QuoteDraft,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

/** One leg's priceable input, cached verbatim in `Quotation.draftJson` at creation time so a
 *  later GET/PATCH never has to re-read the winning quotes or re-run `buildQuotationCostLines` —
 *  the cost basis is frozen the moment the draft is created, matching `Query.awardSnapshot`'s own
 *  "frozen, not live" rule (design doc). */
interface StoredQuotationLeg {
  legId: string;
  legCode: string;
  forwarderName: string;
  variantLabel: string | null;
  groups: QuotationCostGroup[];
}

/** The shape persisted in `Quotation.draftJson` — "lines + overrides, editable" (design doc's
 *  Data model note). `marginPct` is its own DB column (queryable), not duplicated in here. */
interface StoredQuotationDraft {
  legs: StoredQuotationLeg[];
  overrides: Record<string, number>;
}

@Injectable()
export class QuotationService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /api/queries/:id/quotation` — idempotent: creates the one-and-only DRAFT (version 1)
   *  on the first call, priced from the frozen award at margin 0; every later call returns that
   *  same row (repriced fresh, never trusting the row's own cached total columns). */
  async getOrCreateDraft(queryId: string): Promise<QuotationDto> {
    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, awardSnapshot: true },
    });
    if (!query) throw new NotFoundException("Query not found");
    // The main reason a caller lands here too early — nothing has been frozen to price yet.
    if (query.awardSnapshot == null) {
      throw new ConflictException("this query has no frozen award to price");
    }

    const existing = await this.prisma.quotation.findFirst({
      where: { queryId, status: "DRAFT" },
    });
    if (existing) return this.toDto(existing);

    const draft = await this.buildInitialDraft(query.awardSnapshot as unknown as QueryAwardSnapshot);
    const priced = priceQuotation(draft.legs, 0, draft.overrides);

    const created = await this.prisma.quotation.create({
      data: {
        queryId,
        version: 1,
        status: "DRAFT",
        marginPct: 0,
        draftJson: draft as unknown as Prisma.InputJsonValue,
        costTotalUsd: priced.costTotalUsd,
        clientTotalUsd: priced.clientTotalUsd,
      },
    });
    return this.toDto(created);
  }

  /** `PATCH /api/queries/:id/quotation` — merges whichever of `marginPct`/`overrides` was sent
   *  (each optional, editable independently) into the current DRAFT and reprices. `overrides`,
   *  when present in the body, REPLACES the stored map wholesale (the builder screen always
   *  holds/sends the full current override state — this is also what lets a future "reset
   *  overrides" action release a pin simply by omitting its key); when absent, the stored map is
   *  left untouched, which is what lets a pinned line survive a margin-only PATCH. */
  async patch(queryId: string, body: QuotationPatch): Promise<QuotationDto> {
    const current = await this.prisma.quotation.findFirst({
      where: { queryId },
      orderBy: { version: "desc" },
    });
    if (!current) {
      throw new NotFoundException("no quotation exists for this query yet — GET .../quotation first");
    }
    // An issued (or superseded) quotation is immutable — the second of the two guards this
    // service must never lose (S5.8 Task 3 report contract).
    if (current.status !== "DRAFT") {
      throw new ConflictException("this quotation is not a draft and can no longer be edited");
    }

    const stored = current.draftJson as unknown as StoredQuotationDraft;
    const marginPct = body.marginPct ?? Number(current.marginPct);
    const overrides = body.overrides ?? stored.overrides;
    const nextDraft: StoredQuotationDraft = { legs: stored.legs, overrides };
    const priced = priceQuotation(nextDraft.legs, marginPct, overrides);

    const updated = await this.prisma.quotation.update({
      where: { id: current.id },
      data: {
        marginPct,
        draftJson: nextDraft as unknown as Prisma.InputJsonValue,
        costTotalUsd: priced.costTotalUsd,
        clientTotalUsd: priced.clientTotalUsd,
      },
    });
    return this.toDto(updated);
  }

  /** Builds the cached per-leg cost lines for a brand-new draft. One query each for legs,
   *  forwarders and winning quotes — batched over every snapshot leg (`findMany({ where: { id:
   *  { in: [...] } } })`), never one query per leg, so an award with several legs doesn't cost
   *  an N+1 round-trip. */
  private async buildInitialDraft(snapshot: QueryAwardSnapshot): Promise<StoredQuotationDraft> {
    const legIds = snapshot.legs.map((l) => l.legId);
    const forwarderIds = [...new Set(snapshot.legs.map((l) => l.freightForwarderId))];
    const quoteIds = snapshot.legs.map((l) => l.winningQuoteId);

    const [legs, forwarders, quotes] = await Promise.all([
      this.prisma.leg.findMany({ where: { id: { in: legIds } }, select: { id: true, legCode: true } }),
      this.prisma.freightForwarder.findMany({
        where: { id: { in: forwarderIds } },
        select: { id: true, companyName: true },
      }),
      this.prisma.quote.findMany({ where: { id: { in: quoteIds } }, select: { id: true, draftJson: true } }),
    ]);
    const legCodeById = new Map(legs.map((l) => [l.id, l.legCode]));
    const forwarderNameById = new Map(forwarders.map((f) => [f.id, f.companyName]));
    const quoteById = new Map(quotes.map((q) => [q.id, q]));

    const stakedLegs: StoredQuotationLeg[] = snapshot.legs.map((leg) => {
      const quote = quoteById.get(leg.winningQuoteId);
      // Defensive, not expected in practice: an APPROVED winning quote always carries a
      // draftJson (award.service.ts's generateClientQuote already proved it priceable before
      // ever freezing the snapshot). Fail clean (409) rather than an unhandled TypeError on a
      // financial endpoint if that invariant is ever violated.
      if (!quote?.draftJson) {
        throw new ConflictException(`winning quote for leg ${leg.legId} is not priceable`);
      }
      const draftJson = quote.draftJson as unknown as QuoteDraft;
      const groups = buildQuotationCostLines(draftJson, leg.variant, leg.currency, leg.unitsPerUsd);
      return {
        legId: leg.legId,
        legCode: legCodeById.get(leg.legId) ?? leg.legId,
        forwarderName: forwarderNameById.get(leg.freightForwarderId) ?? leg.freightForwarderId,
        variantLabel: leg.variant ? rateVariantLabel(leg.variant) : null,
        groups,
      };
    });

    return { legs: stakedLegs, overrides: {} };
  }

  private toDto(row: Quotation): QuotationDto {
    const stored = row.draftJson as unknown as StoredQuotationDraft;
    const marginPct = Number(row.marginPct);
    const pricing = priceQuotation(stored.legs, marginPct, stored.overrides);
    return {
      id: row.id,
      queryId: row.queryId,
      version: row.version,
      status: row.status,
      marginPct,
      overrides: stored.overrides,
      pricing,
      validUntil: null, // populated in Task 4
      recipientEmail: row.recipientEmail,
      subject: row.subject,
      bodyText: row.bodyText,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      issuedByUserId: row.issuedByUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
