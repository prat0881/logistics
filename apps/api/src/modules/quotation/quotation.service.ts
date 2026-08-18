import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, Quotation } from "@prisma/client";
import {
  Channel,
  buildQuotationCostLines,
  formatInZone,
  priceQuotation,
  rateVariantLabel,
  renderTemplate,
  type PricedQuotation,
  type QueryAwardSnapshot,
  type QuotationCostGroup,
  type QuotationDto,
  type QuotationIssue,
  type QuotationPatch,
  type QuoteDraft,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { MessageTemplateService } from "../comms/message-template.service";
import { MESSAGE_TRANSPORT, type MessageTransport } from "../comms/transport";
import { QueryStatusProjector } from "../status/query-status.projector";
import type { RequestUser } from "../auth/types";

// Same FROM address notification-dispatcher.service.ts uses for every other outbound EMAIL —
// duplicated locally rather than imported since that module doesn't export its constant.
const QUOTATION_EMAIL_FROM = "logistics@yankalfa.com";

// The tokens the seeded `quotation.issued.email` template's subject/body reference (Task 4 fix
// round 1, review IMPORTANT #1) — every value a plain string, "" when the underlying data is
// absent (`renderTemplate` blanks a missing token the same way).
interface IssueTokens {
  Query_ID: string;
  Client_Name: string;
  Reference_Tags: string;
  Shipment_Description: string;
  Vessel: string;
  Port_Of_Call: string;
  Cargo_Summary: string;
  Ready_Date: string;
  Valid_Until: string;
  Grand_Total: string;
  Quotation_Ref: string;
  // Index signature so this satisfies renderTemplate's `Record<string, string>` param — every
  // key above is already a string, this just makes the structural match explicit to tsc.
  [key: string]: string;
}

/** Strips the entire line containing `{{token}}` (plus its own trailing newline) out of a
 *  template body when `value` is empty — the pre-authorised "omit the line entirely rather than
 *  print an empty value" rule (design doc Q2), made real at render time instead of only living
 *  as `QuotationDto.validUntil: null`. Generic over any token, used here for `Valid_Until`. */
function omitEmptyTokenLine(body: string, token: string, value: string): string {
  if (value) return body;
  return body.replace(new RegExp(`^.*\\{\\{${token}\\}\\}.*\\n?`, "m"), "");
}

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
    @Inject(MESSAGE_TRANSPORT) private readonly transport: MessageTransport,
  ) {}

  /** `GET /api/queries/:id/quotation` — idempotent: creates the one-and-only DRAFT (version 1)
   *  the very first time a query is priced, then always returns the query's CURRENT quotation
   *  row exactly as-is on every later call — DRAFT (still editable), or ISSUED (T6: a read-only
   *  view, with "Revise" as the only door back to a new DRAFT) once one exists.
   *
   *  🔴 T6 fix: this must never fall through to the `create` below just because the current row
   *  isn't a DRAFT. `Quotation` has `@@unique([queryId, version])`, and every draft this service
   *  creates is hardcoded to `version: 1` — the old "only look for a DRAFT" query came back empty
   *  the instant `issue()` flipped that same row to ISSUED, then tried to `create` a SECOND
   *  `(queryId, 1)` row and 409'd on the unique violation instead of just showing it. That is
   *  exactly the request the web preview dialog's `useIssueQuotation` fires via its post-success
   *  `invalidateQueries(["quotation", queryId])` (T6 ambiguity resolution #4) the instant "Issue
   *  quotation" succeeds — undetected until T6 because no earlier task's flow ever issued a
   *  quotation and then re-GET'd it in the same session. Deliberately narrow: only the ISSUED
   *  case is special-cased here: a SUPERSEDED-with-no-current-DRAFT-or-ISSUED row (reachable only
   *  after a reopen-then-re-award, a flow no task has built a "start a fresh quotation" door for
   *  yet) still falls through to `create` and still 409s on the version collision, unchanged from
   *  Tasks 1-5 — fixing that unrelated, pre-existing gap is out of this task's scope. */
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

    const existingDraft = await this.prisma.quotation.findFirst({
      where: { queryId, status: "DRAFT" },
    });
    if (existingDraft) return this.toDto(existingDraft);

    const latestIssued = await this.prisma.quotation.findFirst({
      where: { queryId, status: "ISSUED" },
      orderBy: { version: "desc" },
    });
    if (latestIssued) return this.toDto(latestIssued);

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

  /** `POST /api/queries/:id/quotation/issue` — Manager+. Freezes the current DRAFT: reprices
   *  one more time off its own `draftJson` (never re-reads the award), renders the seeded
   *  `quotation.issued.email` template server-side (fix round 1, review IMPORTANT #1 — the ONLY
   *  way "grand total only, no forwarder names" is enforced by code rather than by the shape of
   *  a UI that doesn't exist yet), stamps `ISSUED` + `issuedAt`/`issuedByUserId` + the rendered
   *  `recipientEmail`/`subject`/`bodyText`, writes `issuedSnapshot` (the priced output,
   *  verbatim), and logs one audit `MessageLog` row. All in one transaction, closing with the
   *  projector's `client` recompute — same shape as `generateClientQuote` (award.service.ts).
   *  `transport.send` fires only AFTER that transaction commits (fix round 1, review
   *  IMPORTANT #2 — mirrors `StatusService.fire`'s post-commit `emitAsync`). */
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

    const tokens = await this.buildIssueTokens(queryId, current.version, priced, stored);
    // T6: `renderFromTemplate` is the SAME call `toDto`'s `previewSubject`/`previewBody` makes —
    // see its own doc comment for why sharing it is what makes a draft's preview byte-identical
    // to what issuing it actually persists.
    const { subject: renderedSubject, body: renderedBody } = this.renderFromTemplate(template, tokens);
    // Subject stays caller-editable (design doc: the envelope names it as such); the letter
    // itself never is — `body` no longer carries a `bodyText` field at all (schema change,
    // packages/shared/src/quotation.ts).
    const finalSubject = body.subject?.trim() || renderedSubject;

    const issuedAt = new Date();
    const { row, logId } = await this.prisma.$transaction(async (tx) => {
      // Re-check DRAFT atomically WITH the write (fix round 1, review MINOR #4) — a plain
      // re-read here wouldn't actually close the race: Prisma's `.update({ where: { id } })`
      // has no status guard of its own, so a second concurrent `issue()` call could still
      // blindly overwrite an already-ISSUED row after re-reading DRAFT moments earlier. Folding
      // the guard into the UPDATE's own WHERE clause makes the check atomic with the write: a
      // losing concurrent call's `updateMany` affects 0 rows once the winner has committed.
      const guard = await tx.quotation.updateMany({
        where: { id: current.id, status: "DRAFT" },
        data: {
          status: "ISSUED",
          issuedAt,
          issuedByUserId: user.userId,
          recipientEmail: body.recipientEmail,
          subject: finalSubject,
          bodyText: renderedBody,
          issuedSnapshot: priced as unknown as Prisma.InputJsonValue,
          costTotalUsd: priced.costTotalUsd,
          clientTotalUsd: priced.clientTotalUsd,
        },
      });
      if (guard.count === 0) {
        throw new ConflictException("this quotation is not a draft and cannot be issued");
      }
      const row = await tx.quotation.findUniqueOrThrow({ where: { id: current.id } });

      const log = await tx.messageLog.create({
        data: {
          tenantId: user.tenantId,
          entityType: "QUERY",
          entityId: queryId,
          eventKey: "quotation.issued",
          channel: Channel.EMAIL,
          templateKey: template.key,
          fromAddress: QUOTATION_EMAIL_FROM,
          toAddress: body.recipientEmail,
          subject: finalSubject,
          bodyRendered: renderedBody,
          tokens: tokens as unknown as Prisma.InputJsonValue,
          composedById: user.userId,
        },
      });
      // Inside the same transaction (design contract) — the freshly ISSUED row above must be
      // visible to the `issued > 0` count this reads, so AWAITING_CLIENT_DECISION lands atomically
      // with the freeze rather than via the eventual-consistency leg.status.changed listener.
      await this.projector.recompute(queryId, tx);
      return { row, logId: log.id };
    });

    await this.transport.send(logId);
    return this.toDto(row);
  }

  /** Gathers the `IssueTokens` `issue()` renders the `quotation.issued.email` template with —
   *  every value straight off the query's own persisted data, never off caller input (that's
   *  the whole point: the letter's content is not something a request body can shape). One
   *  round trip each for the query header, its cargo rows (client PO references) and its
   *  packages (a plain package-count + gross-weight summary), run in parallel. */
  private async buildIssueTokens(
    queryId: string,
    version: number,
    priced: PricedQuotation,
    stored: StoredQuotationDraft,
  ): Promise<IssueTokens> {
    const [query, cargos, packages] = await Promise.all([
      this.prisma.query.findUnique({
        where: { id: queryId },
        select: {
          queryCode: true,
          contactName: true,
          client: { select: { companyName: true } },
          shipmentDescription: true,
          vesselName: true,
          imoNumber: true,
          portOfCall: true,
          readyDate: true,
          readyDateTimezone: true,
        },
      }),
      this.prisma.cargo.findMany({ where: { queryId }, select: { poReference: true } }),
      this.prisma.package.findMany({ where: { queryId }, select: { grossWt: true } }),
    ]);

    // "their reference tags" (design doc) — the CLIENT's own PO/booking references (per-cargo-row
    // `poReference`), matching the template's "Your reference:" label. Not `Package.tags`
    // (the internal HEAVY/FRAGILE/DG handling classification) — that isn't something we "echo
    // back" as the client's own reference.
    const referenceTags = [...new Set(cargos.map((c) => c.poReference?.trim()).filter((v): v is string => !!v))];

    const vessel = query?.vesselName
      ? `${query.vesselName}${query.imoNumber ? ` (IMO ${query.imoNumber})` : ""}`
      : query?.imoNumber
        ? `IMO ${query.imoNumber}`
        : "";

    const packageCount = packages.length;
    const grossKg = packages.reduce((sum, p) => sum + Number(p.grossWt), 0);
    const cargoSummary =
      packageCount > 0 ? `${packageCount} package${packageCount === 1 ? "" : "s"}, ${grossKg.toFixed(0)} kg gross` : "";

    const readyDate = query?.readyDate
      ? query.readyDateTimezone
        ? formatInZone(query.readyDate.toISOString(), query.readyDateTimezone)
        : query.readyDate.toISOString().slice(0, 10)
      : "";

    const validUntil = earliestValidUntil(stored.legs);

    return {
      Query_ID: query?.queryCode ?? "",
      Client_Name: query?.client?.companyName ?? query?.contactName ?? "",
      Reference_Tags: referenceTags.join(", "),
      Shipment_Description: query?.shipmentDescription ?? "",
      Vessel: vessel,
      Port_Of_Call: query?.portOfCall ?? "",
      Cargo_Summary: cargoSummary,
      Ready_Date: readyDate,
      Valid_Until: validUntil ? validUntil.slice(0, 10) : "",
      Grand_Total: priced.clientTotalUsd.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      // No dedicated "quotation reference" concept exists elsewhere in the codebase — judgment
      // call (see task-4-report.md fix-round section): the query's own code plus this version.
      Quotation_Ref: `${query?.queryCode ?? ""}-Q${version}`,
    };
  }

  /** Renders a subject+body from the seeded `quotation.issued.email` template's own raw
   *  `{subject, body}` plus an already-built `IssueTokens` record — pure, synchronous, no DB
   *  calls of its own. This is the ONE call both `issue()` (which persists the result onto
   *  `Quotation.subject`/`bodyText`) and `toDto()` (which exposes it, unpersisted, as
   *  `previewSubject`/`previewBody` on every read — T6) make, so a draft's rendered preview is
   *  byte-identical to what issuing it actually persists, as long as nothing else changes the row
   *  or the template in between (T6 ruling: the client preview must never be reconstructed
   *  client-side, since that could drift from the template). */
  private renderFromTemplate(
    template: { subject: string | null; body: string },
    tokens: IssueTokens,
  ): { subject: string; body: string } {
    // "omit the line entirely rather than print an empty value" (design doc Q2) — real at render
    // time, not just `QuotationDto.validUntil: null`.
    const bodyTemplate = omitEmptyTokenLine(template.body, "Valid_Until", tokens.Valid_Until);
    return {
      subject: renderTemplate(template.subject ?? "", tokens),
      body: renderTemplate(bodyTemplate, tokens),
    };
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
        validUntil: draftJson.quoteValidityUntil ?? null,
      };
    });

    return { legs: stakedLegs, overrides: {} };
  }

  /** T6: `previewSubject`/`previewBody` are computed on EVERY read (GET/PATCH/issue/revise all
   *  funnel through this one method) — reusing `buildIssueTokens` + `renderFromTemplate`, the
   *  exact chain `issue()` itself uses, is what makes the preview byte-identical to what issuing
   *  actually persists, rather than a second, drift-prone implementation. `""` for both when the
   *  `quotation.issued.email` template isn't configured — defensive only (seeding is idempotent
   *  and always run); GET/PATCH must not 500/409 over it the way `issue()` deliberately does. */
  private async toDto(row: Quotation): Promise<QuotationDto> {
    const stored = row.draftJson as unknown as StoredQuotationDraft;
    const marginPct = Number(row.marginPct);
    const pricing = priceQuotation(stored.legs, marginPct, stored.overrides);

    const template = await this.messageTemplates.lookup("quotation.issued", Channel.EMAIL);
    const preview = template
      ? this.renderFromTemplate(
          template,
          await this.buildIssueTokens(row.queryId, row.version, pricing, stored),
        )
      : { subject: "", body: "" };

    return {
      id: row.id,
      queryId: row.queryId,
      version: row.version,
      status: row.status,
      marginPct,
      overrides: stored.overrides,
      pricing,
      validUntil: earliestValidUntil(stored.legs),
      previewSubject: preview.subject,
      previewBody: preview.body,
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
