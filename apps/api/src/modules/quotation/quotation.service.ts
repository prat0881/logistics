import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, Quotation } from "@prisma/client";
import {
  Channel,
  buildQuotationCostLines,
  formatInZone,
  orderLegsByRoute,
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

// S5.9.3 final review, IMPORTANT #1 — the 409 a stale issue attempt gets back. Worded for the
// manager staring at the preview dialog, not for a log: it says what happened, what it means for
// the number in front of them, and what to do about it. The web client also refetches the
// quotation on this 409 (`useIssueQuotation`), so "reload" is a description of what already
// happened rather than an instruction to go find a refresh button.
const STALE_QUOTATION_MESSAGE =
  "this quotation was repriced after you opened this preview — the letter has been reloaded with " +
  "the current total; check it before issuing";

// S5.9.4 (register C10) — the 409 an edit against a no-longer-editable quotation gets back. ONE
// constant because `patch()` now raises it from two places that mean the same thing to the caller:
// the up-front read (the row was already ISSUED/SUPERSEDED when we looked) and the UPDATE's own
// WHERE clause (it became so between that look and the write). The distinction is ours, not the
// manager's — either way the answer is "reload; this one has gone out".
const NOT_A_DRAFT_MESSAGE = "this quotation is not a draft and can no longer be edited";

/**
 * S5.9.4 (register C11) — a stable, key-order-independent serialisation, used to decide whether a
 * PATCH would actually change `draftJson`.
 *
 * Two properties matter and both are deliberate:
 *
 * 1. **Object keys are sorted**, recursively, so `{a:1,b:2}` and `{b:2,a:1}` compare equal. This is
 *    not hypothetical: the overrides map is a `Record<string, number>` whose key order comes from
 *    whatever the browser happened to send, and Postgres `jsonb` re-orders keys on storage anyway
 *    (length, then bytewise) — so a plain `JSON.stringify` comparison would report "changed" on
 *    almost every genuine no-op.
 * 2. **Array order is preserved.** `draftJson.legs` is an ordered list; a reordering IS a change.
 *
 * Numbers compare by VALUE, not by source formatting: `JSON.stringify` emits the canonical shortest
 * representation of a double, so `1.50` and `1.5` both serialise to `1.5`. Anything that is not
 * exactly the same double still differs, which is the direction to be wrong in — see `patch()`.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

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
 *  as `QuotationDto.validUntil: null`. Generic over any token. */
function omitEmptyTokenLine(body: string, token: string, value: string): string {
  if (value) return body;
  return body.replace(new RegExp(`^.*\\{\\{${token}\\}\\}.*\\n?`, "m"), "");
}

/** Every token in the seeded `quotation.issued.email` body that (a) occupies a whole line of its
 *  own — `Label: {{Token}}` — and (b) can legitimately be empty, because the underlying query
 *  column is nullable or the collection behind it can come back empty.
 *
 *  🔴 Final review IMPORTANT #5: only `Valid_Until` was ever run through `omitEmptyTokenLine`,
 *  so a query with no vessel (or no PO reference, no shipment description, no packages, no ready
 *  date — all nullable, none unusual) sent the client a letter containing bare dangling labels:
 *  `Vessel: `, `Your reference: `, `Port of call: `. On this sub-build's ENTIRE deliverable.
 *  `Query_ID` and `Grand_Total` are deliberately NOT here — both are always populated, and a
 *  silently vanishing total would be far worse than an empty one. */
const OMITTABLE_TOKENS = [
  "Reference_Tags",
  "Shipment_Description",
  "Vessel",
  "Port_Of_Call",
  "Cargo_Summary",
  "Ready_Date",
  "Valid_Until",
] as const;

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

  /** `GET /api/queries/:id/quotation` — idempotent: creates the one-and-only DRAFT the very first
   *  time a query is priced, then always returns the query's CURRENT quotation row exactly as-is
   *  on every later call — DRAFT (still editable), or ISSUED (T6: a read-only view, with "Revise"
   *  as the only door back to a new DRAFT) once one exists.
   *
   *  "Current" means the HIGHEST-VERSION row, the same definition `patch()`/`issue()` already use.
   *  A DRAFT always holds the highest version when one exists (`revise()` refuses to create a
   *  second DRAFT and mints `version + 1`; `issue()` flips a DRAFT in place), so this reads the
   *  latest row ONCE instead of probing for a DRAFT and then for an ISSUED.
   *
   *  🔴 Final review CRITICAL #3 — the version must be derived, never hardcoded. Every draft used
   *  to be created at `version: 1`, which broke the design's own "a new quotation starts fresh
   *  once the award is re-frozen": `reopenComparison` supersedes the ISSUED v1 and deletes the
   *  DRAFT, so after a re-award this method found neither, fell through to `create({version: 1})`,
   *  and violated `@@unique([queryId, version])` against the SUPERSEDED v1 — a PERMANENT 409 on
   *  every subsequent GET, with no way back. (T6 patched only the ISSUED half of this and ruled
   *  the rest "unrelated, pre-existing"; the final review overturned that — it is the second half
   *  of the reopen behaviour T4 built.)
   *
   *  The re-read immediately before the `create` is deliberate, and is BOTH the version source and
   *  the "only one DRAFT per query" guard (deferred minor T3 M1) — one read, so the two can never
   *  disagree. Two concurrent first-GETs either (a) both see the same latest row, compute the same
   *  next version, and the unique constraint makes the loser 409 rather than minting a second
   *  DRAFT, or (b) the loser's re-read now sees the winner's committed DRAFT and simply returns
   *  it. What must never happen — a naive `max(version) + 1` with no DRAFT check — is two live
   *  drafts at different versions, which `patch()`/`issue()` would then silently disagree about. */
  async getOrCreateDraft(queryId: string, user: RequestUser): Promise<QuotationDto> {
    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { id: true, awardSnapshot: true },
    });
    if (!query) throw new NotFoundException("Query not found");
    // The main reason a caller lands here too early — nothing has been frozen to price yet.
    if (query.awardSnapshot == null) {
      throw new ConflictException("this query has no frozen award to price");
    }

    const current = await this.latestQuotation(queryId);
    if (current && current.status !== "SUPERSEDED") return this.toDto(current);

    const draft = await this.buildInitialDraft(query.awardSnapshot as unknown as QueryAwardSnapshot);
    const priced = priceQuotation(draft.legs, 0, draft.overrides);

    // Re-read (see doc comment): the guard and the version come from the SAME row, taken as late
    // as possible — `buildInitialDraft` above is several round trips wide.
    const latest = await this.latestQuotation(queryId);
    if (latest && latest.status !== "SUPERSEDED") return this.toDto(latest);

    const created = await this.prisma.quotation.create({
      data: {
        queryId,
        // Final review MINOR #9 — every peer service stamps the caller's tenant (queries.service
        // .ts:312 and friends); this one never did, leaving `@@index([tenantId])` dead.
        tenantId: user.tenantId,
        version: (latest?.version ?? 0) + 1,
        status: "DRAFT",
        marginPct: 0,
        draftJson: draft as unknown as Prisma.InputJsonValue,
        costTotalUsd: priced.costTotalUsd,
        clientTotalUsd: priced.clientTotalUsd,
      },
    });
    return this.toDto(created);
  }

  /** The query's CURRENT quotation — highest version wins. One definition, shared by
   *  `getOrCreateDraft`/`patch`/`issue`, so they can never disagree about which row is live. */
  private latestQuotation(queryId: string): Promise<Quotation | null> {
    return this.prisma.quotation.findFirst({ where: { queryId }, orderBy: { version: "desc" } });
  }

  /** `PATCH /api/queries/:id/quotation` — merges whichever of `marginPct`/`overrides` was sent
   *  (each optional, editable independently) into the current DRAFT and reprices. `overrides`,
   *  when present in the body, REPLACES the stored map wholesale (the builder screen always
   *  holds/sends the full current override state — this is also what lets a future "reset
   *  overrides" action release a pin simply by omitting its key); when absent, the stored map is
   *  left untouched, which is what lets a pinned line survive a margin-only PATCH.
   *
   *  🔴 S5.9.4, register C10 — the DRAFT check used to be a plain read followed by an
   *  `update({ where: { id } })`, which is not atomic: a PATCH racing a winning `issue()` could
   *  write `marginPct`/`draftJson`/the totals onto a quotation that had ALREADY gone to the client,
   *  silently making the system of record disagree with the letter. The check now also lives inside
   *  the UPDATE's own WHERE clause — the same shape `issue()` already uses (see its doc comment) —
   *  so the database itself refuses the write and the loser 409s on `count === 0`. The up-front
   *  read is deliberately kept: it is the fast path and the one that answers a caller who was
   *  simply looking at a stale screen; the WHERE clause is what makes it CORRECT.
   *
   *  🔴 S5.9.4, register C11 — a PATCH that would change nothing writes nothing at all. Prisma's
   *  `@updatedAt` stamps on every update whether or not a value moved, and none of the web
   *  triggers is dirty-checked (a keystroke debounces a PATCH, a blur commits one, "Reset
   *  overrides" posts the map unconditionally). Since `issue()`'s concurrency guard is a comparison
   *  on exactly that timestamp, a second tab clicking "Reset overrides" with nothing overridden
   *  used to refuse a perfectly legitimate send with "this quotation was repriced" — when it was
   *  not. Enforced HERE rather than at the trigger because the timestamp is a server concern and a
   *  client-side check can only ever cover its own client; a *different* client is the entire
   *  population `issue()`'s guard exists to protect against.
   *
   *  What "changes nothing" means is deliberately the WHOLE of what this method persists — every
   *  one of the four columns in `data` below — and the comparison is biased toward "it changed":
   *  - `marginPct`: `Decimal.equals`, i.e. NUMERIC equality against the stored `Decimal(5,2)`, so
   *    `12.5` and a stored `12.50` are the same value rather than two different strings.
   *  - `draftJson`: `canonicalJson` (see above) — key-order-independent, so a differently-ordered
   *    overrides map is not a change, while a reordered `legs` array still is.
   *  - `costTotalUsd`/`clientTotalUsd`: `Decimal.equals` against the freshly-`priceQuotation`d
   *    figures. These are derivable from the three inputs above, so they are strictly redundant —
   *    and included anyway, because a row whose persisted totals have drifted from what the current
   *    pricing code computes MUST be rewritten (and MUST move its clock, so `issue()` refuses a
   *    letter composed against the drifted number) rather than short-circuited as "unchanged".
   *  The failure this ordering guards against is the dangerous one: calling a genuine reprice a
   *  no-op would leave `updatedAt` unmoved and walk a stale letter straight past `issue()`'s guard.
   *
   *  The DRAFT refusal is checked BEFORE the no-op short-circuit, on purpose: editing an issued
   *  quotation is refused whether or not the edit would have changed anything, or a 200 would
   *  misreport an already-sent quotation as editable. */
  async patch(queryId: string, body: QuotationPatch): Promise<QuotationDto> {
    const current = await this.latestQuotation(queryId);
    if (!current) {
      throw new NotFoundException("no quotation exists for this query yet — GET .../quotation first");
    }
    // An issued (or superseded) quotation is immutable — the second of the two guards this
    // service must never lose (S5.8 Task 3 report contract). Fails fast here with the caller-facing
    // message; the SAME condition is repeated inside the UPDATE's WHERE clause below, which is what
    // makes it atomic against an `issue()` that commits between this read and that write.
    if (current.status !== "DRAFT") {
      throw new ConflictException(NOT_A_DRAFT_MESSAGE);
    }

    const stored = current.draftJson as unknown as StoredQuotationDraft;
    const marginPct = body.marginPct ?? Number(current.marginPct);
    const overrides = body.overrides ?? stored.overrides;
    const nextDraft: StoredQuotationDraft = { legs: stored.legs, overrides };
    const priced = priceQuotation(nextDraft.legs, marginPct, overrides);

    // C11 (see doc comment) — every column the UPDATE below would write, compared against what is
    // already stored. All four must match for this to be a no-op; any doubt is a change.
    const unchanged =
      current.marginPct.equals(marginPct) &&
      current.costTotalUsd.equals(priced.costTotalUsd) &&
      current.clientTotalUsd.equals(priced.clientTotalUsd) &&
      canonicalJson(nextDraft) === canonicalJson(current.draftJson);
    if (unchanged) return this.toDto(current);

    // C10 (see doc comment) — `updateMany` rather than `update` purely because Prisma only accepts
    // unique fields in `update`'s `where`, and `status` is not one; same reason `issue()` uses it.
    const guard = await this.prisma.quotation.updateMany({
      where: { id: current.id, status: "DRAFT" },
      data: {
        marginPct,
        draftJson: nextDraft as unknown as Prisma.InputJsonValue,
        costTotalUsd: priced.costTotalUsd,
        clientTotalUsd: priced.clientTotalUsd,
      },
    });
    if (guard.count === 0) {
      // The row stopped being a DRAFT between the read above and this write — the C10 race. Unlike
      // `issue()`, which has two distinct losers to tell apart, this has exactly one: `status` is
      // the only condition in the WHERE beyond the primary key, so `count === 0` can only mean the
      // status moved. (A concurrent PATCH is NOT a loser here — last write wins, by design.)
      throw new ConflictException(NOT_A_DRAFT_MESSAGE);
    }
    const updated = await this.prisma.quotation.findUniqueOrThrow({ where: { id: current.id } });
    return this.toDto(updated);
  }

  /** `POST /api/queries/:id/quotation/issue` — Manager+. Freezes the current DRAFT: reprices
   *  one more time off its own `draftJson` (never re-reads the award), renders the seeded
   *  `quotation.issued.email` template server-side as the DEFAULT subject/body, stamps `ISSUED` +
   *  `issuedAt`/`issuedByUserId` + the final `recipientEmail`/`subject`/`bodyText`, writes
   *  `issuedSnapshot` (the priced output, verbatim), and logs one audit `MessageLog` row. All in
   *  one transaction, closing with the projector's `client` recompute — same shape as
   *  `generateClientQuote` (award.service.ts). `transport.send` fires only AFTER that transaction
   *  commits (fix round 1, review IMPORTANT #2 — mirrors `StatusService.fire`'s post-commit
   *  `emitAsync`).
   *
   *  S5.9.3 Task 1 (P1/P2): `body.subject`/`body.bodyText` are now BOTH caller-editable overrides
   *  of the render, falling back to it when omitted or blank (mirrors the pre-existing `subject`
   *  behavior). This is the one place the structural "grand total only" guarantee (fix round 1,
   *  review IMPORTANT #1) became procedural — the letter's PROSE can now say anything a manager
   *  types. What is NOT reachable through `body` is the money: `priced` above is computed from
   *  `stored.legs`/`marginPct`/`overrides` — this row's own frozen draft — and that is the ONLY
   *  input to `costTotalUsd`/`clientTotalUsd`/`issuedSnapshot` below. `body.bodyText` is never
   *  parsed for a total and never touches `priced`, so whatever a manager types into the letter,
   *  the amount the system of record charges the client is exactly what `priceQuotation` computed
   *  server-side — unchanged from before P1. What the free-text edit CAN do is make the letter's
   *  own prose say a different number than `priced.clientTotalUsd` (e.g. if a manager retypes the
   *  `Grand_Total` line by hand) — `bodyText`/`MessageLog.bodyRendered` still record that letter
   *  verbatim (P2: the audit trail reflects what was actually sent), so the discrepancy is
   *  visible after the fact even though nothing here catches it before sending.
   *
   *  🔴 S5.9.3 final review, IMPORTANT #1 — the one divergence that needed catching BEFORE
   *  sending, because no human typed anything wrong to cause it. Manager A opens the preview; the
   *  letter (rendered from pricing as it was at that moment) reads USD 5,356.11. Manager B — or
   *  A's own second tab — PATCHes `marginPct`. A's browser never learns: `useQuotation` has no
   *  polling and TanStack Query refetches only on focus/mount, so a manager who stays in the tab
   *  keeps the old cache indefinitely. A clicks Issue: `body.bodyText` is the letter A read
   *  (5,356.11), while `priced` below is recomputed from the row's CURRENT `marginPct`/`overrides`
   *  (6,100) and is what lands in `clientTotalUsd`/`issuedSnapshot`. The client reads one figure
   *  and the system charges another. The client could not be the guard here — the client is what
   *  is stale — so the check is server-side: `body.expectedUpdatedAt` is the `updatedAt` A's copy
   *  was read at, and any PATCH in between has moved the row's own `@updatedAt`. Mismatch → 409.
   *  Checked twice on purpose: once up front (fast, and the place the manager-facing message comes
   *  from) and again inside the UPDATE's WHERE clause, which is what actually makes it atomic
   *  against a PATCH that commits between the read and the write. */
  async issue(queryId: string, body: QuotationIssue, user: RequestUser): Promise<QuotationDto> {
    const current = await this.latestQuotation(queryId);
    if (!current) {
      throw new NotFoundException("no quotation exists for this query yet — GET .../quotation first");
    }
    if (current.status !== "DRAFT") {
      throw new ConflictException("this quotation is not a draft and cannot be issued");
    }
    // 🔴 S5.9.3 final review, IMPORTANT #1 — optimistic concurrency on the row's own `updatedAt`.
    // Fails fast here with the manager-facing message; the SAME comparison is repeated as part of
    // the UPDATE's WHERE clause below, which is what makes it atomic (this read is several round
    // trips away from that write). See this method's doc comment for the scenario.
    const expectedUpdatedAt = new Date(body.expectedUpdatedAt);
    if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw new ConflictException(STALE_QUOTATION_MESSAGE);
    }

    const stored = current.draftJson as unknown as StoredQuotationDraft;
    // 409 guard (design contract) — nothing to charge for and nothing to freeze.
    if (stored.legs.length === 0) {
      throw new ConflictException("this quotation has no priced legs to issue");
    }
    const marginPct = Number(current.marginPct);
    // S5.9.3 Task 2 (P4) — route-order the legs BEFORE pricing so the frozen `issuedSnapshot`
    // (the audit record — see this method's own doc comment) itself stores them in route order,
    // not whatever order `stored.legs` happened to be in. See `orderLegs`'s doc comment for why
    // this has to be re-derived here rather than trusted from `draftJson`.
    const orderedLegs = await this.orderLegs(stored.legs);
    const priced = priceQuotation(orderedLegs, marginPct, stored.overrides);

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
    // Both subject and body are caller-editable overrides of the render, falling back to it when
    // omitted/blank (S5.9.3 Task 1, P1) — `quotationIssueSchema` enforces non-empty-after-trim
    // when either IS supplied, so `?.trim()` here only ever sees `""` for an omitted field, never
    // for one the caller explicitly sent empty (that 400s at the validation pipe, before this
    // method even runs).
    const finalSubject = body.subject?.trim() || renderedSubject;
    // 🔴 Grand-total authority (see this method's own doc comment): `finalBody` is prose only —
    // it is what gets PERSISTED as the audit record, but it never feeds `priced` below. The
    // client's actual charged amount stays entirely off `stored.legs`/`marginPct`/`overrides`.
    const finalBody = body.bodyText?.trim() || renderedBody;

    const issuedAt = new Date();
    const { row, logId } = await this.prisma.$transaction(async (tx) => {
      // Re-check DRAFT atomically WITH the write (fix round 1, review MINOR #4) — a plain
      // re-read here wouldn't actually close the race: Prisma's `.update({ where: { id } })`
      // has no status guard of its own, so a second concurrent `issue()` call could still
      // blindly overwrite an already-ISSUED row after re-reading DRAFT moments earlier. Folding
      // the guard into the UPDATE's own WHERE clause makes the check atomic with the write: a
      // losing concurrent call's `updateMany` affects 0 rows once the winner has committed.
      const guard = await tx.quotation.updateMany({
        where: { id: current.id, status: "DRAFT", updatedAt: current.updatedAt },
        data: {
          status: "ISSUED",
          issuedAt,
          issuedByUserId: user.userId,
          recipientEmail: body.recipientEmail,
          subject: finalSubject,
          bodyText: finalBody,
          // `priced` (line ~255) is computed from `stored.legs`/`marginPct`/`overrides` alone —
          // never from `finalBody` — so the grand total below stays server-authoritative
          // regardless of what the manager typed into the letter (see this method's doc comment).
          issuedSnapshot: priced as unknown as Prisma.InputJsonValue,
          costTotalUsd: priced.costTotalUsd,
          clientTotalUsd: priced.clientTotalUsd,
        },
      });
      if (guard.count === 0) {
        // Two distinct losers reach here and they need DIFFERENT messages: a concurrent issue()
        // (row is no longer DRAFT) and a concurrent PATCH (still DRAFT, but repriced since the
        // read above). One extra read, only on the already-failing path, to tell them apart.
        const latest = await tx.quotation.findUnique({
          where: { id: current.id },
          select: { status: true },
        });
        throw new ConflictException(
          latest?.status === "DRAFT"
            ? STALE_QUOTATION_MESSAGE
            : "this quotation is not a draft and cannot be issued",
        );
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
          bodyRendered: finalBody,
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
    // time, not just `QuotationDto.validUntil: null`, and applied to EVERY optional whole-line
    // token rather than to `Valid_Until` alone (final review IMPORTANT #5).
    const bodyTemplate = OMITTABLE_TOKENS.reduce(
      (body, token) => omitEmptyTokenLine(body, token, tokens[token]),
      template.body,
    );
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
        tenantId: latestIssued.tenantId, // carried forward, same as every other field (MINOR #9)
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

  /**
   * S5.9.3 Task 2 (P4) — product owner: "Legs sequence should be as per route diagram instead of
   * showing the order they got approved." Reorders a stored draft's legs into route-diagram
   * order using `@svyft/shared`'s `orderLegsByRoute` — the SAME topology sorter
   * `award.service.ts#generateClientQuote` now uses to freeze `Query.awardSnapshot.legs`, and the
   * FF-portal's `legOrder.ts` uses for its own leg list — one ordering rule, reused, not a second
   * one written here.
   *
   * Called at RENDER time (`toDto`/`issue`), not just at draft-creation time
   * (`buildInitialDraft`), because the product owner is looking at a quotation that ALREADY
   * EXISTS: `Quotation.draftJson.legs` is frozen once, the first time `getOrCreateDraft` creates
   * the row, and every read after that (`patch`/`issue`/`revise`/a later `GET`) has always reused
   * that stored order verbatim. Fixing only `buildInitialDraft` (or only the award snapshot it
   * reads from) would leave every quotation created before this fix shipped wrong forever, with
   * no migration to run. Re-deriving the order from the live `Leg` table on every call instead
   * means an already-frozen `draftJson` heals itself the next time anyone reads it — no migration,
   * and no risk of drifting from `award.service.ts`'s own (also now-fixed) order in the meantime.
   *
   * Deterministic tiebreak: `orderLegsByRoute`'s own fallback for a disconnected/ambiguous route
   * (two legs that don't share a point, so route topology can't order them) is "stable to
   * whatever order the input array was in" — so legs are pre-sorted by `legCode` first, the same
   * pattern `award.service.ts` uses, turning that fallback into a fixed, reproducible order
   * instead of whatever the DB happened to return.
   *
   * A leg id with no matching `Leg` row (defensive — should not happen; nothing deletes a Leg out
   * from under a frozen quotation) resolves to `null`/`null` endpoints, which `orderLegsByRoute`
   * treats the same as any other endpoint-less leg — sorted alongside the route's start rather
   * than throwing.
   */
  private async orderLegs(legs: StoredQuotationLeg[]): Promise<StoredQuotationLeg[]> {
    if (legs.length <= 1) return legs;
    const rows = await this.prisma.leg.findMany({
      where: { id: { in: legs.map((l) => l.legId) } },
      select: { id: true, originPointId: true, destinationPointId: true },
    });
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const byLegCode = [...legs].sort((a, b) => a.legCode.localeCompare(b.legCode));
    return orderLegsByRoute(
      byLegCode,
      (l) => rowById.get(l.legId)?.originPointId ?? null,
      (l) => rowById.get(l.legId)?.destinationPointId ?? null,
    );
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

    // S5.9.3 Task 2 (P4) — belt-and-suspenders: even a BRAND-NEW draft's own stored order starts
    // correct (the award snapshot it read from is itself now route-ordered by
    // `award.service.ts#generateClientQuote`). Not load-bearing on its own — `toDto` below
    // re-derives the order on every read regardless — but keeps `Quotation.draftJson` sensible
    // for any future direct reader, and costs nothing extra: `orderLegs` needs this same Leg
    // lookup, and `buildInitialDraft` already made one for `legCodeById` above.
    return { legs: await this.orderLegs(stakedLegs), overrides: {} };
  }

  /** T6: for a DRAFT, `previewSubject`/`previewBody` are RENDERED on every read — reusing
   *  `buildIssueTokens` + `renderFromTemplate`, the exact chain `issue()` itself uses, is what
   *  makes the preview byte-identical to what issuing it will actually persist, rather than a
   *  second, drift-prone implementation. `""` for both when the `quotation.issued.email` template
   *  isn't configured — defensive only (seeding is idempotent and always run); GET/PATCH must not
   *  500/409 over it the way `issue()` deliberately does.
   *
   *  Once the row is ISSUED (or SUPERSEDED) the preview is the PERSISTED letter, not a re-render
   *  (final review MINOR #8). Re-rendering read live query data, so a vessel name or ready date
   *  edited after issuing would silently change what the UI shows as "the quotation we sent" —
   *  the exact drift the server-side-render ruling exists to prevent, just in the other direction.
   *  It also skips 3 queries + a template lookup per read on a row that can never change. */
  private async toDto(row: Quotation): Promise<QuotationDto> {
    const stored = row.draftJson as unknown as StoredQuotationDraft;
    const marginPct = Number(row.marginPct);
    // S5.9.3 Task 2 (P4) — THE fix for the product owner's actual complaint: they are looking at
    // a quotation that already exists, whose `draftJson.legs` order was frozen the first time
    // this row's DRAFT was created and has been reused verbatim by every read since. Re-deriving
    // route order HERE, on every call to `toDto` (the one place every GET/PATCH/issue/revise
    // response's `pricing` ultimately comes from), means an already-frozen row heals itself on
    // its very next read — no migration, no re-generate required. See `orderLegs`'s doc comment.
    const orderedLegs = await this.orderLegs(stored.legs);
    const pricing = priceQuotation(orderedLegs, marginPct, stored.overrides);

    const preview = await this.previewFor(row, pricing, stored);

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

  /** See `toDto` — rendered for a DRAFT, replayed from the frozen columns for anything else. */
  private async previewFor(
    row: Quotation,
    pricing: PricedQuotation,
    stored: StoredQuotationDraft,
  ): Promise<{ subject: string; body: string }> {
    if (row.status !== "DRAFT") return { subject: row.subject ?? "", body: row.bodyText ?? "" };
    const template = await this.messageTemplates.lookup("quotation.issued", Channel.EMAIL);
    if (!template) return { subject: "", body: "" };
    return this.renderFromTemplate(
      template,
      await this.buildIssueTokens(row.queryId, row.version, pricing, stored),
    );
  }
}
