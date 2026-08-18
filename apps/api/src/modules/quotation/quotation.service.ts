import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, Quotation } from "@prisma/client";
import {
  Channel,
  buildQuotationCostLines,
  priceQuotation,
  rateVariantLabel,
  type QueryAwardSnapshot,
  type QuotationCostGroup,
  type QuotationDto,
  type QuotationIssue,
  type QuotationPatch,
  type QuoteDraft,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { MessageTemplateService } from "../comms/message-template.service";
import { QueryStatusProjector } from "../status/query-status.projector";
import type { RequestUser } from "../auth/types";

// Same FROM address notification-dispatcher.service.ts uses for every other outbound EMAIL —
// duplicated locally rather than imported since that module doesn't export its constant.
const QUOTATION_EMAIL_FROM = "logistics@yankalfa.com";

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
  /** The winning quote's own `quoteValidityUntil` (ISO), captured at draft-creation time so
   *  `validUntil` stays computable forever off `draftJson` alone — including for an ISSUED row
   *  after a later reopen has cleared `Query.awardSnapshot` (Task 4, design doc Q2: "earliest
   *  validUntil across the winning quotes"). */
  validUntil: string | null;
}

/** The shape persisted in `Quotation.draftJson` — "lines + overrides, editable" (design doc's
 *  Data model note). `marginPct` is its own DB column (queryable), not duplicated in here. */
interface StoredQuotationDraft {
  legs: StoredQuotationLeg[];
  overrides: Record<string, number>;
}

/** `QuotationDto.validUntil` (Task 4, pre-authorised decision) — the earliest `validUntil`
 *  across the winning quotes, i.e. the date our OWN cost basis expires; never null-coalesced to
 *  today or "" — `null` when every winning quote's `validUntil` is itself null, so a consumer
 *  (the future compose/preview screen) can omit the "valid until" line entirely rather than
 *  print an empty value. ISO 8601 UTC strings sort lexically the same as chronologically. */
function earliestValidUntil(legs: StoredQuotationLeg[]): string | null {
  const dates = legs.map((l) => l.validUntil).filter((v): v is string => v != null);
  if (dates.length === 0) return null;
  return dates.reduce((min, v) => (v < min ? v : min));
}

@Injectable()
export class QuotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messageTemplates: MessageTemplateService,
    private readonly projector: QueryStatusProjector,
  ) {}

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
  /** `POST /api/queries/:id/quotation/issue` — Manager+. Freezes the current DRAFT: reprices
   *  one more time off its own `draftJson` (never re-reads the award), stamps `ISSUED` +
   *  `issuedAt`/`issuedByUserId` + the caller's composed `recipientEmail`/`subject`/`bodyText`,
   *  writes `issuedSnapshot` (the priced output, verbatim — decoupled from any future change to
   *  `priceQuotation`'s own logic), and logs one audit `MessageLog` row against the seeded
   *  `quotation.issued.email` template. All in one transaction, closing with the projector's
   *  `client` recompute — same shape as `generateClientQuote` (award.service.ts). */
  async issue(queryId: string, body: QuotationIssue, user: RequestUser): Promise<QuotationDto> {
    const current = await this.prisma.quotation.findFirst({
      where: { queryId },
      orderBy: { version: "desc" },
    });
    if (!current) {
      throw new NotFoundException("no quotation exists for this query yet — GET .../quotation first");
    }
    if (current.status !== "DRAFT") {
      throw new ConflictException("this quotation is not a draft and cannot be issued");
    }

    const stored = current.draftJson as unknown as StoredQuotationDraft;
    // 409 guard (design contract) — nothing to charge for and nothing to freeze.
    if (stored.legs.length === 0) {
      throw new ConflictException("this quotation has no priced legs to issue");
    }
    const marginPct = Number(current.marginPct);
    const priced = priceQuotation(stored.legs, marginPct, stored.overrides);

    // MessageLog.templateKey is NOT NULL — fail clean rather than write a row that can't be
    // attributed to a template if the seed was never run (reference-seed.ts, idempotent).
    const template = await this.messageTemplates.lookup("quotation.issued", Channel.EMAIL);
    if (!template) {
      throw new ConflictException("the quotation.issued.email template is not configured");
    }

    const issuedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.quotation.update({
        where: { id: current.id },
        data: {
          status: "ISSUED",
          issuedAt,
          issuedByUserId: user.userId,
          recipientEmail: body.recipientEmail,
          subject: body.subject,
          bodyText: body.bodyText,
          issuedSnapshot: priced as unknown as Prisma.InputJsonValue,
          costTotalUsd: priced.costTotalUsd,
          clientTotalUsd: priced.clientTotalUsd,
        },
      });
      await tx.messageLog.create({
        data: {
          entityType: "QUERY",
          entityId: queryId,
          eventKey: "quotation.issued",
          channel: Channel.EMAIL,
          templateKey: template.key,
          fromAddress: QUOTATION_EMAIL_FROM,
          toAddress: body.recipientEmail,
          subject: body.subject,
          bodyRendered: body.bodyText,
          tokens: {} as unknown as Prisma.InputJsonValue,
          composedById: user.userId,
        },
      });
      // Inside the same transaction (design contract) — the freshly ISSUED row above must be
      // visible to the `issued > 0` count this reads, so AWAITING_CLIENT_DECISION lands atomically
      // with the freeze rather than via the eventual-consistency leg.status.changed listener.
      await this.projector.recompute(queryId, tx);
      return row;
    });
    return this.toDto(updated);
  }

  /** `POST /api/queries/:id/quotation/revise` — Manager+. Clones the latest ISSUED version into
   *  a fresh DRAFT at `version + 1`, carrying its margin and overrides forward untouched. Issued
   *  rows are immutable (never updated by this method); a second DRAFT is refused since only one
   *  may exist per query at a time (design doc, Data model note). */
  async revise(queryId: string): Promise<QuotationDto> {
    const existingDraft = await this.prisma.quotation.findFirst({ where: { queryId, status: "DRAFT" } });
    if (existingDraft) {
      throw new ConflictException("a draft quotation already exists for this query");
    }

    const latestIssued = await this.prisma.quotation.findFirst({
      where: { queryId, status: "ISSUED" },
      orderBy: { version: "desc" },
    });
    if (!latestIssued) {
      throw new NotFoundException("no issued quotation exists for this query to revise");
    }

    const stored = latestIssued.draftJson as unknown as StoredQuotationDraft;
    const marginPct = Number(latestIssued.marginPct);
    const priced = priceQuotation(stored.legs, marginPct, stored.overrides);

    const created = await this.prisma.quotation.create({
      data: {
        queryId,
        version: latestIssued.version + 1,
        status: "DRAFT",
        marginPct,
        draftJson: stored as unknown as Prisma.InputJsonValue,
        costTotalUsd: priced.costTotalUsd,
        clientTotalUsd: priced.clientTotalUsd,
      },
    });
    return this.toDto(created);
  }

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
        validUntil: draftJson.quoteValidityUntil ?? null,
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
      validUntil: earliestValidUntil(stored.legs),
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
