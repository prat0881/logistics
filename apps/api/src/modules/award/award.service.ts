import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { AwardDecisionStatus, Prisma, type LegAwardDecision, type Query } from "@prisma/client";
import { z } from "zod";
import {
  AIR_VARIANT_KEY,
  LEG_STATUSES,
  LegEvent,
  LegStatus,
  QuoteEvent,
  QuoteStatus,
  Role,
  computeQuoteTotals,
  latestRateByCurrency,
  orderLegsByRoute,
  rollupLegTarget,
  toUsd,
  transitKeyForVariant,
  type QueryAwardSnapshot,
  type QueryAwardSnapshotLeg,
  type QuoteDraft,
  type RecommendationDto,
  type RejectInput,
  type SendForApprovalInput,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import type { RequestUser } from "../auth/types";
import { ComparisonService } from "../comparison/comparison.service";
import { NotificationDispatcher } from "../comms/notification-dispatcher.service";
import { FxRatesService } from "../fx-rates/fx-rates.service";
import { QueryStatusProjector } from "../status/query-status.projector";
import { StatusService } from "../status/status.service";
import { QueryLockService } from "./query-lock.service";

// Quote statuses that still might yield a NEW comparable price if we wait longer — the leg
// hasn't heard back (RFQ_SENT), is mid-negotiation (REQUOTED), or needs re-distribution
// (INVALID). Mirrors leg-quote.projector.ts's RESOLVED set (inverted) — kept as a small local
// literal rather than importing that module's internal constant across a module boundary.
const OUTSTANDING_QUOTE_STATUSES: readonly QuoteStatus[] = [
  QuoteStatus.RFQ_SENT,
  QuoteStatus.REQUOTED,
  QuoteStatus.INVALID,
];

// S5.9.5 (D4) — quote statuses `sendForApproval` will accept for the NAMED offer. Must stay in
// lock-step with the `send_for_approval` sources registered on the quote machine
// (award.module.ts): QUOTED and EXPIRED. They are two independent gates — this one produces the
// 409 below BEFORE anything is written, the machine would otherwise throw
// `IllegalTransitionError` out of the POST-COMMIT fire, leaving a wedged decision (see step 2).
// EXPIRED is here because D4 preserves a re-quoted forwarder's retained price through the expiry
// sweep (rfq-schedule.listener.ts — read its note on what that price is and is not) and promises it
// stays approvable, not merely visible. It is self-limiting the same way the comparison is: an
// EXPIRED quote with no `draftJson` never reaches this guard at all. CORRECTED (review round 1) —
// the reason is NOT that `o.priced` evaluates false. `buildLeg` skips any quote with no
// `draftJson` (comparison.service.ts), so no offer row is emitted for it in the first place and
// the pre-transaction `!offer` check 400s (see the `getComparison` block below).
const SENDABLE_STATUSES: readonly QuoteStatus[] = [QuoteStatus.QUOTED, QuoteStatus.EXPIRED];

// S5.9.5 (design D2) — the statuses a leg / a quote can be WALKED BACK from by reject(), i.e. the
// exact `from` set of the reversal edges award.module.ts registers:
//   leg   — RETURN_FULL / RETURN_PARTIAL, from PENDING_APPROVAL (S5.4) and from APPROVED (D2);
//   quote — RETURN (PENDING_APPROVAL), UNAPPROVE (APPROVED), RETURN_EXPIRED (both).
// reject() uses these to decide whether a row has any edge to fire at all, and picks the event from
// the row's OWN status; keep them in lock-step with those edges, the same discipline
// SENDABLE_STATUSES keeps with the SEND_FOR_APPROVAL edges above. Both are supersets of the single
// status the decision's own mode would imply, on purpose — see the long note in reject().
const LEG_REVERSIBLE_FROM: readonly LegStatus[] = [LegStatus.PENDING_APPROVAL, LegStatus.APPROVED];
const QUOTE_REVERSIBLE_FROM: readonly QuoteStatus[] = [
  QuoteStatus.PENDING_APPROVAL,
  QuoteStatus.APPROVED,
];

// S5.9 Task 4 review round — IMPORTANT 2. lockLeg's raw SQL casts both ids to `::uuid` directly
// against Postgres, unlike a typed Prisma call, which validates the shape client-side first —
// see lockLeg's own doc for why that matters. Same `.uuid()` check `@svyft/shared`'s schemas use
// for every other UUID-shaped field (award.ts's `quoteId`, etc.), applied here to a path param
// instead of a body field.
const UUID_SCHEMA = z.string().uuid();

// S5.9.2 Task 1 review, IMPORTANT 1 — the recorded verdict for A3's DEADLINE-PASSED arm, written
// onto the send's own `StatusTransition` row when no exec-supplied reason accompanied it (A9's arm
// records the exec's own `proceedReason` instead). Human-readable on purpose: this lands in the
// leg's audit trail, where "why is a leg that was never fully quoted under review?" is a real
// question. See `latestSendForApproval` for the invariant it serves.
const A3_SEND_PERMISSION_DEADLINE = "All outstanding RFQ windows had closed at send time";

// S5.4 — the maker-checker award workflow (design §9). approve/reject (Task 3, steps 2+4,
// Manager+ + four-eyes) are the checker half. sendForApproval (Task 2, steps 1+3, validation
// catalogue §13 A1/A2/A3/A9/B2) is the maker half.
//
// CORRECTED (S5.9 Task 3 review round 2, IMPORTANT 3) — this comment used to claim
// sendForApproval "is only ever a write to LegAwardDecision + an audit event" and that,
// "unlike the maker method", only approve/reject "actually fire quote/leg status transitions".
// Both clauses went false the moment S5.9 Task 3 gave sendForApproval its own post-commit
// `status.fire` calls (see below, and the class-level note on that method) — it now fires both
// transitions itself, before approve() ever runs. What still distinguishes the two halves is WHO
// may call them and WHEN in the workflow (auth-only + before a decision exists, vs Manager+
// four-eyes + only once PENDING_APPROVAL), not whether either one touches status.
//
// S5.9 Task 3 (register B2/B3) — selecting an offer and sending it for approval used to be two
// separate calls (PUT .../shortlist then POST .../send-for-approval): the second call re-read
// whatever `legAwardDecision.shortlistedQuoteId` the first had last persisted, so a concurrent
// change between the two could submit a forwarder nobody on screen chose — 200 OK, no error
// anywhere. They are now ONE call, `sendForApproval`, that NAMES the offer it acts on and does
// the selection + guard checks + status write in a single transaction. `PUT .../shortlist` and
// the public `shortlist` method are retired; `persistSelection` below is what remains of it, now
// private and reachable only from inside this one transaction.
@Injectable()
export class AwardService {
  private readonly logger = new Logger(AwardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
    private readonly status: StatusService,
    private readonly projector: QueryStatusProjector,
    private readonly fxRates: FxRatesService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly lock: QueryLockService,
  ) {}

  // S5.9 Task 3 (register B3) — the ONE remaining write for a leg's shortlisted offer. Only
  // caller is sendForApproval's own transaction below, hence private + a `tx` parameter instead
  // of `this.prisma`. The A1 offer-validity check and the D3 recommendation snapshot are NOT
  // done here any more: they're reads through ComparisonService.getComparison, which talks to
  // `this.prisma` directly and has no way to see inside an open `tx` (Prisma transaction clients
  // are not composable that way), so sendForApproval computes them itself BEFORE opening the
  // transaction and hands the validated `input` plus the snapshotted `rec` in here. This method's
  // job is only the upsert — no audit event (sendForApproval writes the single SEND_FOR_APPROVAL
  // event that now covers what used to be two events, SHORTLIST + SEND_FOR_APPROVAL).
  private async persistSelection(
    tx: Prisma.TransactionClient,
    queryId: string,
    legId: string,
    input: SendForApprovalInput,
    rec: RecommendationDto | null,
  ): Promise<LegAwardDecision> {
    return tx.legAwardDecision.upsert({
      where: { legId },
      create: {
        legId,
        queryId,
        shortlistedQuoteId: input.quoteId,
        shortlistedVariant: input.variant,
        recommendedQuoteId: rec?.quoteId ?? null,
        recommendedVariant: rec?.variant ?? null,
        overrideReason: input.overrideReason ?? null,
        status: AwardDecisionStatus.DRAFT,
      },
      update: {
        shortlistedQuoteId: input.quoteId,
        shortlistedVariant: input.variant,
        recommendedQuoteId: rec?.quoteId ?? null,
        recommendedVariant: rec?.variant ?? null,
        overrideReason: input.overrideReason ?? null,
        status: AwardDecisionStatus.DRAFT,
      },
    });
  }

  // S5.9 Task 4 — the SAME mutual-exclusion lock sendForApproval originally inlined (Task 3,
  // review round 2, CRITICAL 1 / register B3), extracted so every entry point that can race
  // another on the same leg (send-for-approval, approve, reject) takes it identically: same
  // row, same order (Leg first, nothing else locked before or after it in the same call), same
  // raw SQL. `SELECT ... FOR UPDATE` on the leg's own row (always extant by the time any of
  // these three can run) turns the caller's whole guard-then-write sequence into that leg's
  // critical section — a second concurrent call on the same leg blocks HERE, before it reads
  // anything its own guards depend on, until this transaction commits or rolls back. Prisma has
  // no typed API for row locks, hence raw SQL — parameterized via the tagged template, never
  // string-interpolated.
  private async lockLeg(
    tx: Prisma.TransactionClient,
    queryId: string,
    legId: string,
  ): Promise<void> {
    // S5.9 Task 4 review round — IMPORTANT 2. A typed Prisma call (what `requireDecidable` used
    // to do, and what `sendForApproval` still does first via `ComparisonService.getComparison`)
    // validates a `@db.Uuid` argument client-side and a malformed one surfaces as a Prisma error
    // code `PrismaExceptionFilter` maps to 400. This raw query bypasses that entirely: a
    // malformed `legId`/`queryId` reaches Postgres itself, which rejects the `::uuid` cast with
    // its own `22P02`, wrapped by `$queryRaw` in a Prisma error code the filter does NOT map —
    // falling through to a bare 500. `approve`/`reject` call this as their very first operation
    // (no prior typed read to catch it), so validate the shape ourselves first and 400
    // identically to what a typed Prisma call would have done.
    if (!UUID_SCHEMA.safeParse(legId).success || !UUID_SCHEMA.safeParse(queryId).success) {
      throw new BadRequestException("Invalid identifier");
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Leg" WHERE "id" = ${legId}::uuid AND "queryId" = ${queryId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException("Leg not found");
  }

  // The leg status the quotes currently justify. Delegates to the ONE pure rule in @svyft/shared
  // that LegQuoteProjector also uses, so approve/reject and the rollup can never disagree (D4).
  // Takes `tx`, not `this.prisma`: approve()/reject() call this from inside the same transaction
  // that holds lockLeg's row lock, so the read is against that transaction's own consistent
  // snapshot rather than a second, unlocked connection.
  private async legRollupTarget(
    tx: Prisma.TransactionClient,
    legId: string,
  ): Promise<LegStatus | null> {
    const quotes = await tx.quote.findMany({
      where: { legId, status: { not: QuoteStatus.SELECT } },
      select: { status: true },
    });
    return rollupLegTarget(quotes.map((q) => q.status));
  }

  // S5.9 final whole-branch review — CRITICAL 1, first half.
  //
  // The leg status this leg actually LEFT when it was sent for approval. `StatusService.fire`
  // appends an immutable `StatusTransition` row for EVERY owned status change, so the send's own
  // `FULLY_QUOTED|PARTIALLY_QUOTED --send_for_approval--> PENDING_APPROVAL` edge already records
  // this fact — no new column and no migration needed to read it back.
  //
  // Latest matching row wins: a leg can be sent, rejected and re-sent, and only the most recent
  // entry describes the review currently in flight (nothing can append a LATER `to =
  // PENDING_APPROVAL` row without the leg first leaving PENDING_APPROVAL, which requires a
  // reject/approve/change-order that also clears the decision). Ordered by `seq` — a monotonic
  // autoincrement — rather than `at`, whose millisecond resolution can tie for two writes in the
  // same tick.
  //
  // `null` when no such row exists: a decision written straight into the DB by a fixture, or a leg
  // that reached PENDING_APPROVAL before this log did. Callers fall back to the live rollup alone,
  // i.e. exactly the pre-fix behaviour.
  //
  // S5.9.2 Q3, WIDENED by the Task-1 review (IMPORTANT 1) — this row now carries a SECOND fact
  // beside `from`: the PERMISSION under which A3 let the send through when the leg was not
  // FULLY_QUOTED. See `A3_SEND_PERMISSION_DEADLINE` above and `sendForApproval`'s step 4b for the
  // write; `approve()` is the only reader.
  //
  // THE INVARIANT, stated once, here: **a legally-permitted send is approvable.** `sendForApproval`
  // is the only route to PENDING_APPROVAL and it writes, on this very row, either
  //   * `reason === null`  ⟺  the leg was FULLY_QUOTED at send time (so `from` alone carries it), or
  //   * `reason !== null`  ⟺  A3 permitted the send from a NOT-fully-quoted leg, and says which arm.
  // Nothing else in the codebase fires `LegEvent.SEND_FOR_APPROVAL` (grep it), and the `event`
  // filter below pins that structurally rather than relying on "no other leg edge lands on
  // PENDING_APPROVAL" (review MINOR 1). A leg whose PENDING_APPROVAL was written straight into the
  // DB — a fixture, a legacy row from before this log, a future code path that skips A3 — has no
  // such row, so it carries NO permission and stays unapprovable. That is the whole of the
  // narrowing, and it is by construction, not by inference.
  //
  // Why the send has to RECORD its verdict rather than approve() re-deriving it: A3's
  // deadline-passed arm is not re-computable later. `requestRequote` pushes an RFQ's
  // `submissionDeadline` days into the future, and an outstanding sibling can be INVALID (no
  // `expire` edge at all), so the same question asked at approve time can answer differently — or
  // never — through no change the checker made. Only the send knows what it was allowed to do.
  //
  // Why not the `AwardDecisionEvent` log, which the brief called "the honest source": its
  // SEND_FOR_APPROVAL row's `reason` column already CONFLATES two different reasons
  // (`input.proceedReason ?? decision.overrideReason`), so a non-null value there does not mean
  // "permission" — and distinguishing them would need either a second event row paired to this one
  // by a `now()`-defaulted timestamp with no monotonic tiebreak, or a new column (forbidden).
  // NOTHING ELSE MAY WRITE `reason` ON A LEG send_for_approval FIRE — doing so silently widens
  // approve()'s guard. Mutation-proven in award-requote-fallback.e2e-spec.ts ("(k)").
  private async latestSendForApproval(
    tx: Prisma.TransactionClient,
    legId: string,
  ): Promise<{ from: LegStatus | null; permission: string | null }> {
    const row = await tx.statusTransition.findFirst({
      where: {
        entity: "leg",
        entityId: legId,
        // review MINOR 1 — pin the edge itself, not just where it lands.
        event: LegEvent.SEND_FOR_APPROVAL,
        to: LegStatus.PENDING_APPROVAL,
      },
      orderBy: { seq: "desc" },
      select: { from: true, reason: true },
    });
    const from = row?.from;
    return {
      // `StatusTransition.from` is a plain nullable String column (it serves every machine), so
      // narrow it back to the leg vocabulary rather than casting blind.
      from:
        from != null && (LEG_STATUSES as readonly string[]).includes(from)
          ? (from as LegStatus)
          : null,
      permission: row?.reason ?? null,
    };
  }

  // S5.9 final whole-branch review — CRITICAL 1. THE single "is this leg fully quoted?" rule that
  // approve() and reject() both ask, so the two can never disagree about it (the D4 discipline,
  // now applied to the right question).
  //
  // CORRECTED (S5.9.2 Task 1, and again at its review — IMPORTANT 2): this comment used to open
  // by explaining that `rollupLegTarget` alone is not the rule "because FULLY_QUOTED is a
  // HYSTERESIS state on this leg: LegQuoteProjector never walks an already-FULLY_QUOTED leg
  // backwards, so a leg with one QUOTED and one REQUOTED quote is legitimately FULLY_QUOTED by
  // history". **That mechanism no longer exists.** S5.9.2 Q1 is precisely its removal: the
  // projector now fires `REQUOTE_PARTIAL`/`REQUOTE_OUTSTANDING` on a re-quote, so a leg carrying a
  // REQUOTED quote falls back to PARTIALLY_QUOTED/RFQ_SENT and the "FULLY_QUOTED by history" state
  // is unreachable through the API (only a direct DB seed can still produce it — several older
  // fixtures do). The correction is load-bearing, not cosmetic: read in isolation, the old text
  // says the hysteresis still carries the A9 path, which invites deleting the permission term
  // below as redundant — the exact reasoning shape that produced the two previous defects on this
  // guard. The S5.9.2 paragraph was originally APPENDED beneath the false one; it now replaces it,
  // per this file's own `CORRECTED (round 2) — the previous version named the WRONG guard`
  // convention.
  //
  // What remains true, and why this predicate still has two terms — it is a question of FACT
  // ("do this leg's quotes justify FULLY_QUOTED?"), asked identically by approve() and reject():
  //   * the live rollup promotes a leg whose straggler resolved DURING review — the projector's
  //     ROLLUP_FROZEN guard skips a leg in PENDING_APPROVAL, so nothing else recomputes it (the
  //     Task-2 "nothing recomputes on unfreeze" carry-forward); and
  //   * `from === FULLY_QUOTED` covers the converse — a leg whose ROW said FULLY_QUOTED at send
  //     time while its quotes no longer justify it, where the live rollup alone would demote it
  //     below the status it actually held.
  //
  // CORRECTED (S5.9.2 Task 1, review round 2 — NEW-1). The second bullet used to justify itself
  // with "a sibling knocked OFF 'resolved' during review (e.g. a change-order INVALIDATEs it)".
  // **Traced, and it cannot happen**: ChangeOrderStrategy fires the quote's INVALIDATE *and* the
  // leg's REOPEN across every affected leg, and AwardChangeOrderListener resets the decision to
  // DRAFT — the leg leaves PENDING_APPROVAL, so `requireDecidable` 409s long before either
  // predicate runs. `requestRequote` on a sibling mid-review is refused outright by its own
  // decision-is-PENDING_APPROVAL guard. That claim replaced the false hysteresis claim in this
  // same spot and was no better; naming a mechanism without tracing it is the pattern this round
  // existed to end.
  //
  // The mechanism that IS reachable, traced end-to-end against the running app: **a later RFQ
  // distribution adding a forwarder to a leg that is already FULLY_QUOTED.** `rfq.service.ts`
  // gates its `SEND_RFQ` leg fire on `leg.status === READY_FOR_RFQ`, so the leg gets no fire at
  // all (and no error — distribution is refused only for a DRAFT leg), while the new quote's own
  // SEND fire lands it at RFQ_SENT. `LegQuoteProjector` then computes PARTIALLY_QUOTED and
  // DISCARDS it: the never-walk-backwards backstop only fires QUOTE_PARTIAL from RFQ_SENT, and
  // the Q1 backward walk is gated on a re-quote, which this is not. So the leg ROW stays
  // FULLY_QUOTED above a rollup that has dropped below it — A3 passes on the row, the send
  // records `from = FULLY_QUOTED` and NO permission, and by approve time only this term can carry
  // the decision. Verified: with this term deleted that flow 409s.
  //
  // Note the honest limit of the phrase "the leg genuinely held FULLY_QUOTED": it means the leg
  // ROW said so. As the case above shows (and `award-requote-fallback.e2e-spec.ts`'s "(j)" pins),
  // such a leg can carry an unresolved quote. The predicate's letter is exact — it reports what
  // the leg held — but it is a weaker statement about the quotes than it first reads as.
  // Neither term can make a leg WORSE than the other alone would, which is precisely the property
  // reject() needs to pick RETURN_FULL vs RETURN_PARTIAL without ever promoting a leg into a state
  // it never earned.
  //
  // What this predicate is NOT: approve()'s whole rule. A3/A9 settled "may this leg be under
  // review at all?" at SEND time, and that verdict is recorded on the send's own transition row —
  // see `latestSendForApproval`. approve() ORs that permission in; reject() deliberately does not,
  // because a permission is not evidence of fullness and folding it in here would send a
  // fallen-back leg back to FULLY_QUOTED, leaking the very mismatch Q1 removes (mutation-proven:
  // award-requote-fallback.e2e-spec.ts "(e)"). Freshness of the thing actually being decided stays
  // A8's job (approve) / the mirrored quote check (reject).
  //
  // Takes the already-read send record (review MINOR 2) so approve()/reject() read that row EXACTLY
  // once per call and cannot observe two different rows across their two terms. The cheap
  // already-in-hand term is tested first.
  private async isFullyQuotedForDecision(
    tx: Prisma.TransactionClient,
    legId: string,
    sent: { from: LegStatus | null; permission: string | null },
  ): Promise<boolean> {
    if (sent.from === LegStatus.FULLY_QUOTED) return true;
    return (await this.legRollupTarget(tx, legId)) === LegStatus.FULLY_QUOTED;
  }

  // S5.9 Task 3 (register B2/B3) — selecting an offer and sending it for approval are now ONE
  // call that NAMES the offer it acts on, in ONE transaction. The old two-call shape (PUT
  // .../shortlist, then POST .../send-for-approval) let a concurrent shortlist change the
  // persisted `shortlistedQuoteId` between the two calls; this call never re-reads a
  // separately-persisted selection, so that window doesn't exist any more.
  //
  // Read/transaction boundary: A1 (offer validity) and D3 (recommendation snapshot) are reads
  // through ComparisonService.getComparison, which queries `this.prisma` directly — it cannot
  // run inside `$transaction` and see `tx`. They run first, before the transaction opens. Every
  // other step — the leg lock + load, the B2/A1-refresh/A3/A2/A9 guards, persistSelection's
  // write, the decision's update to PENDING_APPROVAL, and the AwardDecisionEvent — runs inside
  // the ONE transaction below.
  //
  // CORRECTED (S5.9 Task 3 review round 2, CRITICAL 1) — this comment used to say the in-tx
  // guards are "atomic with the write itself" and stop there. That is true for ROLLBACK (a guard
  // failing after persistSelection's write correctly undoes it) but says nothing about MUTUAL
  // EXCLUSION between two concurrent callers, which is what B2 actually needs and did not have:
  // under READ COMMITTED, the B2 read below (`tx.legAwardDecision.findUnique`) took no lock, so
  // two simultaneous sends on the same leg could both read "no decision yet" before either had
  // written anything, both pass every guard, and both commit — the SECOND to commit silently
  // overwrites the FIRST's persisted selection while the FIRST's already-returned response still
  // claims success naming its own, now-stale offer. Reproduced empirically (two concurrent sends,
  // different quoteIds, one leg): 200/200, decision landed on the second caller's offer, BOTH
  // quotes fired into PENDING_APPROVAL because each request's post-commit fire uses its OWN
  // `input.quoteId`, independent of what actually persisted. That is register B3's bug verbatim,
  // just moved from "two sequential HTTP calls" to "two concurrent HTTP calls of the merged one".
  // Step 0 below closes it with a real mutual-exclusion lock, not just an ordering guarantee.
  async sendForApproval(
    queryId: string,
    legId: string,
    input: SendForApprovalInput,
    user: RequestUser,
  ): Promise<LegAwardDecision> {
    // S5.9.5 (D6) — a locked query (`awardSnapshot != null`, i.e. QUOTING_CLIENT /
    // AWAITING_CLIENT_DECISION) refuses every write. First, before any other read, so a locked
    // query never does partial work.
    await this.lock.assertUnlocked(queryId);
    // A1 (offer validity) + D3 (recommendation snapshot) — see the boundary note above. `&&
    // o.priced` keeps a never-quoted, zero-freight variant placeholder (comparison.service.ts
    // emits one per `variantsForMode` slot unconditionally) from passing A1. NOTE (review round
    // 2, deferred minor): this pre-tx read is not re-validated against `rec` inside the
    // transaction — only the NAMED offer's own status is (step 2 below, CRITICAL 2). A `rec`
    // that goes stale between this read and commit is out of scope for this round.
    const comparison = await this.comparison.getComparison(queryId);
    const compLeg = comparison.legs.find((l) => l.legId === legId);
    if (!compLeg) throw new NotFoundException("Leg not found");
    const offer = compLeg.offers.find(
      (o) => o.quoteId === input.quoteId && o.variant === input.variant && o.priced,
    );
    if (!offer) {
      throw new BadRequestException("Selected quote/variant is not an offer on this leg");
    }
    const rec = compLeg.recommendation;

    const { updated, sendPermission } = await this.prisma.$transaction(async (tx) => {
      // 0. MUTUAL EXCLUSION (review round 2, CRITICAL 1 / register B3) — see lockLeg's own doc
      // (S5.9 Task 4 extracted it there so approve()/reject() take the identical lock). A second
      // concurrent `sendForApproval`/approve/reject on the same leg blocks HERE — before it reads
      // anything the guards depend on — until this transaction commits or rolls back, then
      // proceeds against state that actually reflects the outcome: if this call won, the second
      // call's B2 read (step 1) now sees PENDING_APPROVAL and 409s cleanly, with nothing of its
      // own ever written and no quote it fires into PENDING_APPROVAL.
      await this.lockLeg(tx, queryId, legId);

      // 1. Load the leg (scoped to queryId) with its non-SELECT quotes. `quotes.id` (added
      // review round 2, CRITICAL 2) is what step 2 below needs to find the NAMED quote among
      // them — the pre-tx `getComparison` read above proved it was a real, priced offer as of
      // BEFORE this transaction opened; it says nothing about whether it still is.
      const leg = await tx.leg.findFirst({
        where: { id: legId, queryId },
        select: {
          status: true,
          quotes: {
            where: { status: { not: QuoteStatus.SELECT } },
            select: { id: true, status: true, rfq: { select: { submissionDeadline: true } } },
          },
        },
      });
      if (!leg) throw new NotFoundException("Leg not found");

      // 2. A1 IN-TRANSACTION REFRESH (review round 2, CRITICAL 2) — the named quote must be
      // SENDABLE right now, not merely "comparable". COMPARABLE_STATUSES (comparison.service.ts)
      // is the wider set — a REQUOTED offer, for one, is still visible/priced in the grid,
      // stale-flagged, and passes the pre-tx A1 check above — so this re-check is what keeps the
      // send narrower than the read model.
      // Without it, naming a REQUOTED (or otherwise non-sendable) offer sails through every
      // guard below, commits persistSelection's write and the PENDING_APPROVAL decision update,
      // and only THEN throws `IllegalTransitionError` out of the post-commit quote fire — a
      // committed, wedged decision with nothing to undo it but reject() (B2 blocks a re-send,
      // approve()'s A8 blocks approval). This is independent of A9 below: A9 is about a
      // DIFFERENT, still-outstanding quote elsewhere on the leg (proceed past it, with reason);
      // naming the re-quoted offer itself is refused unconditionally, override or not — mirrors
      // approve()'s own A8 freshness re-check, just applied at send time instead of decide time.
      //
      // S5.9.5 (D4) — WIDENED from "must be QUOTED" to SENDABLE_STATUSES (see its doc above), so a
      // price the expiry sweep preserved is approvable and not just rankable. The guard and the
      // machine edges are deliberately two separate gates, not one: keep them in lock-step.
      const namedQuote = leg.quotes.find((q) => q.id === input.quoteId);
      if (!namedQuote || !SENDABLE_STATUSES.includes(namedQuote.status)) {
        throw new ConflictException(
          "Only a live or expired offer can be sent for approval — this one is being re-quoted, is already under review, or has been decided or invalidated",
        );
      }

      // 3. B2 guard — a decision that has already moved past DRAFT (sent for approval, or
      // approved) must not be silently reset by a fresh send. Without this: send the winner ->
      // a different Manager approves (leg=APPROVED, quote=APPROVED, decision={APPROVED,
      // shortlist=winner}) -> send AGAIN with the LOSING (still-QUOTED) offer resets the
      // decision to PENDING_APPROVAL while the leg/quote stay APPROVED — an orphaned approval
      // with no way forward. Now genuinely exclusive against a concurrent sender too — see the
      // step-0 lock above.
      const existing = await tx.legAwardDecision.findUnique({ where: { legId } });
      if (
        existing &&
        (existing.status === AwardDecisionStatus.PENDING_APPROVAL ||
          existing.status === AwardDecisionStatus.APPROVED)
      ) {
        throw new ConflictException("This leg has already been sent for approval");
      }

      // 4a. A9 — a re-quote in flight on this leg must be explicitly proceeded past.
      //
      // S5.9.2 Q3 — MOVED AHEAD OF A3 (it used to be step 7, after persistSelection). Q1 makes a
      // re-quoted leg fall back to PARTIALLY_QUOTED/RFQ_SENT, so from now on an un-waived
      // in-flight re-quote also fails A3 — and A3's message ("not fully quoted yet and its RFQ
      // deadline has not passed") is the wrong, unactionable one for that case, since the leg IS
      // quoted and the deadline was pushed out by the re-quote itself. Evaluating A9 first keeps
      // the actionable message and fails faster; both are 400s raised before anything is written
      // (persistSelection is step 5, and the whole method is one transaction anyway), so no
      // caller can tell the difference other than by the message. The A2 override-reason check
      // stays where it is — it needs the freshly-written decision row.
      const inFlightRequotes = leg.quotes.filter((q) => q.status === QuoteStatus.REQUOTED);
      const proceedOverride =
        inFlightRequotes.length > 0 &&
        input.proceedWithoutWaiting === true &&
        !!input.proceedReason;
      if (inFlightRequotes.length > 0 && !proceedOverride) {
        throw new BadRequestException(
          "This leg has an in-flight re-quote; confirm proceeding without waiting for it",
        );
      }

      // 4b. A3 (D10) — either the rollup already reached FULLY_QUOTED, or every still-outstanding
      // FF's RFQ window has closed (so waiting longer cannot produce a better offer).
      //
      // S5.9.2 Q3 — an explicit, reasoned proceed-without-waiting WAIVES exactly the re-quotes it
      // was ticked for, and nothing else. Before Q1 this widening was unnecessary: a leg that had
      // once been FULLY_QUOTED stayed FULLY_QUOTED through a re-quote (the projector's
      // never-walk-backwards backstop), so `fullyQuoted` carried the A9 flow on its own. Now the
      // leg honestly reads PARTIALLY_QUOTED and `fullyQuoted` is false, so without this an exec
      // who asks one forwarder to sharpen a price could never send a DIFFERENT forwarder for
      // approval — the flow A9 exists to permit.
      //
      // The waiver is scoped to REQUOTED members of the outstanding set. Any OTHER outstanding
      // quote (a forwarder who simply has not answered, or an INVALID one awaiting
      // re-distribution) still has to have closed its window — proceedWithoutWaiting is licence
      // to proceed past a re-quote, never past an open RFQ. And the waiver can only ever SATISFY
      // A3, never bypass it: with no override, `stillWaitedOn` is the full outstanding set and
      // this is byte-for-byte the old check.
      const fullyQuoted = leg.status === LegStatus.FULLY_QUOTED;
      const outstanding = leg.quotes.filter((q) => OUTSTANDING_QUOTE_STATUSES.includes(q.status));
      const stillWaitedOn = proceedOverride
        ? outstanding.filter((q) => q.status !== QuoteStatus.REQUOTED)
        : outstanding;
      const deadlinePassed =
        stillWaitedOn.length > 0 &&
        stillWaitedOn.every(
          (q) => q.rfq != null && q.rfq.submissionDeadline.getTime() <= Date.now(),
        );
      // The waived re-quotes were the ONLY thing left outstanding — there is nothing further to
      // wait for. Gated on `proceedOverride` on purpose: an empty outstanding set on a leg that
      // is somehow still not FULLY_QUOTED (a lagging leg row) must keep failing A3 as it always
      // did, not sail through on an empty `every()`.
      const nothingLeftOutstanding = proceedOverride && stillWaitedOn.length === 0;
      if (!fullyQuoted && !deadlinePassed && !nothingLeftOutstanding) {
        throw new BadRequestException(
          "This leg is not fully quoted yet and its RFQ deadline has not passed",
        );
      }

      // 5. Write the selection — the named offer + the recommendation snapshotted above.
      const decision = await this.persistSelection(tx, queryId, legId, input, rec);

      // 6. A2 — an override reason is required whenever the named offer deviates from the
      // recommendation snapshotted just now (including "there was no recommendation"). Computed
      // from the freshly-written decision, not a stale read — and because this runs inside the
      // transaction, throwing here rolls persistSelection's write back too.
      const matchesRecommendation =
        decision.shortlistedQuoteId === decision.recommendedQuoteId &&
        decision.shortlistedVariant === decision.recommendedVariant;
      if (!matchesRecommendation && !decision.overrideReason) {
        throw new BadRequestException(
          "An override reason is required when the shortlist differs from the recommendation",
        );
      }

      // 7. (A9 moved to step 4a — see there.)

      // 8. Every guard passed — advance the decision and append the single audit event covering
      // this whole call (selection + send, formerly two events: SHORTLIST + SEND_FOR_APPROVAL).
      const updated = await tx.legAwardDecision.update({
        where: { legId },
        data: {
          status: AwardDecisionStatus.PENDING_APPROVAL,
          sentByUserId: user.userId,
          sentForApprovalAt: new Date(),
        },
      });
      await tx.awardDecisionEvent.create({
        data: {
          legId,
          queryId,
          type: "SEND_FOR_APPROVAL",
          quoteId: input.quoteId,
          variant: input.variant,
          reason: input.proceedReason ?? decision.overrideReason ?? null,
          actorId: user.userId,
        },
      });
      // S5.9.2 Task 1 review, IMPORTANT 1 — record WHICH arm of A3 permitted this send, for the
      // leg fire below to stamp on its own transition row.
      //
      // `fullyQuoted` ⇒ no permission needed: the fact itself is recorded as `from = FULLY_QUOTED`
      // and `isFullyQuotedForDecision` reads it back. Otherwise A3 passed via `deadlinePassed` or
      // `nothingLeftOutstanding`, and approve() cannot re-derive either later — `requestRequote`
      // pushes deadlines days out and an INVALID sibling has no `expire` edge at all — so the
      // verdict is recorded now or lost. Non-null WHENEVER `!fullyQuoted`: that total-ness is the
      // invariant approve() depends on ("a legally-permitted send is approvable").
      //
      // A9's arm records the exec's own words; the deadline arm records the fixed sentence. Derived
      // from `proceedOverride`, never the raw request flags, so a gratuitous `proceedWithoutWaiting`
      // on an already-FULLY_QUOTED leg still records nothing.
      const sendPermission = fullyQuoted
        ? null
        : proceedOverride && input.proceedReason
          ? input.proceedReason
          : A3_SEND_PERMISSION_DEADLINE;
      return { updated, sendPermission };
    });

    // After commit: fire the two transitions — quote first, then leg. `StatusService.fire` owns
    // its own transaction (it cannot participate in the one above), so this can only happen
    // once the decision write has actually landed. Quote first, leg second: LegQuoteProjector
    // (Task 2) skips legs already in PENDING_APPROVAL/APPROVED, and the leg is still
    // FULLY_QUOTED/PARTIALLY_QUOTED for the whole duration of the quote fire, so the rollup it
    // triggers sees a consistent picture regardless of order — unlike approve() below, ordering
    // here is not load-bearing, just kept consistent with it. Each fire owns its own
    // transaction, so a partial failure between the two (quote moves, leg fire then throws) is
    // an accepted risk, same as approve()/reject().
    await this.status.fire("quote", input.quoteId, QuoteEvent.SEND_FOR_APPROVAL, {
      queryId,
      actorId: user.userId,
      reason: null,
    });
    // S5.9.2 Q3 + Task-1 review IMPORTANT 1 — `reason` on THIS row is the send's recorded
    // PERMISSION, which approve() reads back (`latestSendForApproval`). Non-null iff A3 let this
    // send through from a leg that was not FULLY_QUOTED, naming the arm that permitted it. Nothing
    // else in the codebase fires `LegEvent.SEND_FOR_APPROVAL`, so nothing else can write it; do
    // not add a reason here for any other purpose without moving the marker somewhere of its own.
    await this.status.fire("leg", legId, LegEvent.SEND_FOR_APPROVAL, {
      queryId,
      actorId: user.userId,
      reason: sendPermission,
    });

    return updated;
  }

  // approve()'s preconditions: (1) the decision must exist (404); (2) it must be
  // PENDING_APPROVAL — you cannot decide something not sent for approval (409); (3) four-eyes —
  // the Manager (or Admin) deciding may not be the same user who sent it (403). The @Roles guard
  // already keeps plain Executives out before this ever runs; this additionally stops a Manager
  // from approving their own send.
  //
  // CORRECTED (S5.9.5, design D2) — this used to open "Shared preconditions for both checker
  // actions" and was called by approve() AND reject(). reject() now has its own sibling,
  // `requireRejectable` below, because D2 gave it a second mode (reversing an APPROVED decision)
  // in which neither the PENDING_APPROVAL requirement nor four-eyes applies. approve() is
  // deliberately left on this stricter version: approval only ever exists at PENDING_APPROVAL.
  //
  // S5.9 Task 4 — takes `tx`, not `this.prisma`: both callers now run this from inside the SAME
  // transaction that holds lockLeg's row lock on this leg (see approve()/reject() below), so the
  // decision read is against that transaction's own consistent snapshot rather than a second,
  // unlocked connection racing whichever of send/approve/reject currently holds the lock. The
  // leg-belongs-to-queryId 404 that used to live here is now lockLeg's job — its
  // `WHERE id = ... AND queryId = ...` raw query 404s identically (mirrors sendForApproval's own
  // scoping) and runs BEFORE this, so a mismatched queryId in the URL never reaches this method
  // at all. Only returns `decision` now (not the leg) — approve() used to read `leg.status` for
  // its own FULLY_QUOTED guard, but that guard moved onto the quotes (see legRollupTarget below).
  private async requireDecidable(
    tx: Prisma.TransactionClient,
    legId: string,
    user: RequestUser,
  ): Promise<{ decision: LegAwardDecision }> {
    const decision = await tx.legAwardDecision.findUnique({ where: { legId } });
    if (!decision) throw new NotFoundException("No award decision on this leg");
    if (decision.status !== AwardDecisionStatus.PENDING_APPROVAL) {
      throw new ConflictException("This leg is not pending approval");
    }
    if (decision.sentByUserId === user.userId) {
      throw new ForbiddenException("SELF_APPROVAL");
    }
    return { decision };
  }

  /**
   * S5.9.5 (design D2) — reject() accepts a decision in EITHER live state. This method's whole job
   * is the ONE thing the two states differ on: whether four-eyes applies.
   *
   * - PENDING_APPROVAL: the original mode. Four-eyes applies — the user who SENT it may not decide it.
   * - APPROVED: the reversal mode. Four-eyes deliberately does NOT apply: undoing your own mistake
   *   is a different act from approving your own work, and the product owner ruled explicitly that
   *   the Manager who approved a leg may reject it back. A single-manager team could otherwise never
   *   undo an approval at all.
   *
   * Anything else (DRAFT, or the REJECTED literal the enum allows but nothing ever persists) has no
   * live decision to act on and still 409s.
   *
   * Returns only the decision, NOT which of the two states it matched — deliberately, and against
   * the task brief's own signature. The only thing that "mode" was to be used for is picking the
   * reversal fires, and reject() picks those from the LEG and QUOTE rows' own statuses instead; see
   * the long note on the leg guard in reject() for the concurrent approve+reject wedge that choice
   * removes.
   *
   * Same `tx` contract as `requireDecidable` above — called from inside reject()'s transaction, after
   * lockLeg has taken this leg's row lock, so the read is against that transaction's own snapshot.
   */
  private async requireRejectable(
    tx: Prisma.TransactionClient,
    legId: string,
    user: RequestUser,
  ): Promise<{ decision: LegAwardDecision }> {
    const decision = await tx.legAwardDecision.findUnique({ where: { legId } });
    if (!decision) throw new NotFoundException("No award decision on this leg");
    if (decision.status === AwardDecisionStatus.PENDING_APPROVAL) {
      if (decision.sentByUserId === user.userId) throw new ForbiddenException("SELF_APPROVAL");
      return { decision };
    }
    if (decision.status === AwardDecisionStatus.APPROVED) {
      return { decision };
    }
    throw new ConflictException("This leg has no decision to reject");
  }

  /**
   * S5.9.5 (Step 5c) — was this quote EXPIRED at the moment it was sent for approval?
   *
   * D4 made a priced-EXPIRED offer sendable, so by the time reject() runs the quote is
   * PENDING_APPROVAL (or APPROVED) and its pre-send status is no longer readable off the row. It is
   * readable off the LOG: `StatusService.fire` appends an immutable `StatusTransition` whose `from`
   * is the status the entity held when the fire ran (status.service.ts — `from: current`, read
   * through the state store inside the same transaction that writes the row). So the send's own row
   * records verbatim what the quote was returned FROM.
   *
   * Narrow by construction, in the same shape as `latestSendForApproval` above:
   *   * the query pins the EDGE (`event` + `to`), not just the landing status, and takes the most
   *     recent one, so it describes THIS review — a quote sent, rejected and sent again appends a
   *     new row each time;
   *   * `award.service.ts:sendForApproval` is the ONLY caller in the codebase that fires
   *     `QuoteEvent.SEND_FOR_APPROVAL` (grepped), and `award.module.ts` gives that event exactly two
   *     edges — from QUOTED and from EXPIRED — so a row's `from` can only be one of those two.
   *
   * No row at all (a quote written straight into PENDING_APPROVAL by a fixture or a direct DB write)
   * answers `false`, i.e. the pre-S5.9.5 behaviour: return it to QUOTED. That is a safety bias
   * rather than an observed path — it keeps the fire on an edge that certainly exists rather than
   * guessing EXPIRED for a quote whose history we cannot see.
   */
  private async wasExpiredWhenSentForApproval(
    tx: Prisma.TransactionClient,
    quoteId: string,
  ): Promise<boolean> {
    const row = await tx.statusTransition.findFirst({
      where: {
        entity: "quote",
        entityId: quoteId,
        event: QuoteEvent.SEND_FOR_APPROVAL,
        to: QuoteStatus.PENDING_APPROVAL,
      },
      orderBy: { seq: "desc" },
      select: { from: true },
    });
    return row?.from === QuoteStatus.EXPIRED;
  }

  // S5.9 Task 4 — approve() used to guard on `leg.status !== FULLY_QUOTED`, straight off the
  // OLD machine (QUOTED/FULLY_QUOTED --approve--> APPROVED). After Task 3, the leg is always
  // PENDING_APPROVAL by the time anyone can approve (sendForApproval put it there), so that
  // guard would reject EVERY approval. What it actually meant — "no RFQ on this leg may still
  // be open" — is a property of the QUOTES, not the leg's own status, so it asks
  // `isFullyQuotedForDecision` (D4 — the same rule reject() below uses to pick its return target,
  // so the two can never disagree about it).
  //
  // S5.9 final whole-branch review, CRITICAL 1 — that guard originally asked `legRollupTarget`
  // ALONE, which permanently 409'd every leg sent through A9's "proceed without waiting" escape
  // hatch. See `isFullyQuotedForDecision` for why a pure function over the current quote statuses
  // is the wrong (and, pre-branch, never-asked) question.
  //
  // Lock/transaction shape mirrors sendForApproval (S5.9 Task 3): lockLeg FIRST inside the
  // transaction, every guard and the decision write itself INSIDE it, commit, THEN fire the
  // quote/leg transitions. `StatusService.fire` opens its own transaction on a different pool
  // connection — firing from inside a transaction that still holds this leg's row lock would
  // have that inner transaction block on the outer one's own lock until Prisma's interactive-tx
  // timeout (P2028). Firing after commit also gives approve()/reject() the SAME mutual exclusion
  // sendForApproval has: a concurrent send/approve/reject on this leg blocks on lockLeg until
  // this transaction resolves, then sees the real outcome.
  async approve(queryId: string, legId: string, user: RequestUser): Promise<LegAwardDecision> {
    const { decision, quoteId } = await this.prisma.$transaction(async (tx) => {
      // S5.9.5 (D6) — a locked query refuses every write. Inside the transaction, on `tx`,
      // because the transaction is this method's FIRST operation: the check then shares the
      // snapshot the rest of the decision is read and written under.
      await this.lock.assertUnlocked(queryId, tx);
      await this.lockLeg(tx, queryId, legId);
      const { decision } = await this.requireDecidable(tx, legId, user);

      // THE RULE, in one line: **this leg is fully quoted, OR its send was legally permitted.**
      //
      // S5.9.2 Q3 introduced the second half for A9's proceed-without-waiting arm alone; the
      // Task-1 review (IMPORTANT 1) found the same hole still open on A3's DEADLINE-PASSED arm and
      // widened it to "permitted", of which the two arms are now instances. The hole was real and
      // reproducible: a leg legally sent from PARTIALLY_QUOTED because every outstanding window had
      // closed could never be approved — `rollupLegTarget([PENDING_APPROVAL, RFQ_SENT])` is `null`
      // and the transition log says PARTIALLY_QUOTED, so both terms of `isFullyQuotedForDecision`
      // are false. Rejecting recovered the leg and re-sending re-reached PENDING_APPROVAL, and
      // approve 409'd again: nothing inside the product broke the loop, only the expiry cron (or,
      // for an INVALID sibling, nothing at all — it has no `expire` edge). Same class as the
      // Critical the last whole-branch review found, on the arm that fix did not cover.
      //
      // Why the send's verdict and not a re-derivation here: A3's deadline question is NOT
      // re-computable at approve time. `requestRequote` pushes an RFQ's `submissionDeadline` days
      // into the future, so the identical guard run minutes later answers differently through no
      // act of the checker's. Only the send knows what it was permitted to do — hence the record.
      //
      // Still narrow, and still by construction rather than inference:
      //   * the permission is read off the send's OWN immutable StatusTransition row, so it
      //     describes THIS review — nothing can append a later `to = PENDING_APPROVAL` row without
      //     the leg first LEAVING PENDING_APPROVAL, which needs a reject/approve/change-order;
      //   * `sendForApproval` — the only writer of that row, and the only route to
      //     PENDING_APPROVAL — writes a permission iff the leg was NOT FULLY_QUOTED, i.e. iff A3
      //     let it through on one of its permitting arms. A PENDING_APPROVAL decision that never
      //     went through A3 (a fixture, a legacy row, a future path that skips the guard) has no
      //     row and therefore no permission, and is still refused; and
      //   * it is NOT in `isFullyQuotedForDecision`, so reject() still returns a fallen-back leg
      //     to PARTIALLY_QUOTED rather than promoting it.
      // MINOR 2 — one read of that row, destructured into both terms, so they cannot observe two
      // different rows.
      const sent = await this.latestSendForApproval(tx, legId);
      if (!(await this.isFullyQuotedForDecision(tx, legId, sent)) && sent.permission === null) {
        throw new ConflictException(
          "This leg is not fully quoted; its outstanding RFQs must be closed out before approval",
        );
      }

      // sendForApproval only ever reaches PENDING_APPROVAL with shortlistedQuoteId set (it
      // guards on that itself) — re-narrow defensively since the column is nullable.
      const quoteId = decision.shortlistedQuoteId;
      if (!quoteId) throw new ConflictException("This leg has no shortlisted offer");

      // A8 — moved from QUOTED to PENDING_APPROVAL: Task 3's send already advanced the
      // shortlisted quote there, so freshness now means "still PENDING_APPROVAL", not "still
      // QUOTED". A concurrent re-quote/change-order could still have knocked it off that status
      // between send and this decision; re-check right before writing anything.
      const quote = await tx.quote.findUnique({ where: { id: quoteId }, select: { status: true } });
      if (!quote || quote.status !== QuoteStatus.PENDING_APPROVAL) {
        throw new ConflictException("The shortlisted quote is no longer available for approval");
      }

      const updated = await tx.legAwardDecision.update({
        where: { legId },
        data: {
          status: AwardDecisionStatus.APPROVED,
          decidedByUserId: user.userId,
          decidedAt: new Date(),
        },
      });
      await tx.awardDecisionEvent.create({
        data: {
          legId,
          queryId,
          type: "APPROVE",
          quoteId,
          variant: decision.shortlistedVariant,
          actorId: user.userId,
        },
      });
      return { decision: updated, quoteId };
    });

    // Quote first, then leg — kept consistent with sendForApproval and the e2e call-order spy.
    // Ordering is no longer load-bearing for correctness the way it was pre-Task-2: the
    // projector now skips legs in PENDING_APPROVAL/APPROVED outright (its ROLLUP_FROZEN guard),
    // so neither order can trigger a spurious rollup attempt on the leg this fires against.
    await this.status.fire("quote", quoteId, QuoteEvent.APPROVE, {
      queryId,
      actorId: user.userId,
      reason: null,
    });
    await this.status.fire("leg", legId, LegEvent.APPROVE, { queryId, actorId: user.userId });

    return decision;
  }

  // S5.9 Task 4 — reject() used to fire no status transitions at all, leaving the quote and leg
  // wedged at PENDING_APPROVAL forever. It now returns both, choosing the leg's target via
  // legRollupTarget (D4) rather than a hard-coded FULLY_QUOTED: sendForApproval's A3 path can
  // legally reach PENDING_APPROVAL from a PARTIALLY_QUOTED leg (outstanding FFs' deadlines
  // passed, not every FF actually quoted) — rejecting that leg back to a hard-coded FULLY_QUOTED
  // would promote it into a state it never earned. Same lock/transaction shape as approve()
  // above: lockLeg + every guard + the target computation + the decision write all happen
  // INSIDE one transaction, commit, THEN fire — see approve()'s doc for why (deadlock avoidance
  // — StatusService.fire cannot run while this transaction still holds the leg's row lock).
  //
  // The target is computed from the quotes' statuses AS THEY STAND at guard time, i.e. BEFORE
  // the quote fire below reverts the shortlisted quote off PENDING_APPROVAL/APPROVED — not "after
  // the return" as it might seem more natural to compute. This is deliberately safe: the shared
  // rollup rule (status.ts's LEG_ROLLUP_RESOLVED) treats every status either side of that fire —
  // PENDING_APPROVAL, APPROVED, QUOTED and EXPIRED alike — as "resolved" for the FULLY_QUOTED
  // branch, and reject() only ever uses the answer to pick between RETURN_FULL (fully quoted) and
  // RETURN_PARTIAL (everything else) — so computing pre- or post-return can never change which of
  // those two edges fires. Computing it inside the same locked transaction as the decision write
  // (rather than as a separate pre-tx read, per the brief's own illustrative ordering) is what lets
  // the lock cover it.
  //
  // S5.9.5 (design D2) — reject() now has TWO modes, chosen by `requireRejectable` from the
  // decision's own status:
  //   * PENDING_APPROVAL — the original mode, unchanged in every respect including four-eyes;
  //   * APPROVED — the reversal mode, and the ONLY way to undo an approval (D1 removes every other
  //     action from an approved leg). Four-eyes deliberately does not apply here; see
  //     `requireRejectable`.
  // The mode decides exactly ONE thing: whether four-eyes applies. Everything after
  // `requireRejectable` returns is common to both — the decision write to DRAFT, the REJECT event,
  // the two Q5 tolerance guards, the leg's RETURN_FULL/RETURN_PARTIAL choice, the quote event, the
  // executive notification — so the two modes cannot disagree about what a rejection means.
  //
  // In particular the reversal FIRES are not mode-derived. Both guards below ask the same
  // mode-independent question — is this row sitting on a status a reversal edge starts from
  // (`LEG_REVERSIBLE_FROM` / `QUOTE_REVERSIBLE_FROM`, identical for both modes) — and the quote
  // event is picked from the QUOTE ROW's own status, not the decision's. The long note on the leg
  // guard below records the concurrent approve+reject wedge that made a mode-derived version wrong,
  // and is the authority if this paragraph and that one ever drift apart.
  //
  // S5.9 final whole-branch review, CRITICAL 1 — that choice originally came from
  // `legRollupTarget` ALONE, with `null` (and everything else) falling through to RETURN_PARTIAL.
  // On a leg sent through A9 that silently DEMOTED a genuinely FULLY_QUOTED leg to
  // PARTIALLY_QUOTED: the pure rollup cannot reproduce a status the leg earned earlier and was not
  // given back (at the time, the projector's hysteresis — since removed by S5.9.2 Q1; the gap
  // still exists, reached today by a later distribution onto an already-FULLY_QUOTED leg — see
  // `isFullyQuotedForDecision`, which traces it, and do NOT substitute the change-order story that
  // used to stand here: it is unreachable), and the
  // fall-through treated "I cannot tell" as "partial". It
  // now asks `isFullyQuotedForDecision`, which also consults the status the leg actually LEFT
  // when it was sent (recorded immutably in `StatusTransition`), so a reject can never leave a
  // leg worse off than it was before it was sent. Options weighed and rejected: (a) hard-coding
  // RETURN_FULL — reintroduces exactly the D4 bug of promoting an A3-deadline-passed leg it never
  // earned; (b) persisting a `statusBeforeSend` column on `LegAwardDecision` — a migration to
  // duplicate a fact the immutable transition log already holds verbatim, with a second copy to
  // keep in sync; (c) widening `LEG_ROLLUP_RESOLVED` to include `REQUOTED` — wrong at the source,
  // it would tell the PROJECTOR that a re-quote in flight is settled, promoting unrelated legs.
  //
  // S5.9 Task 4 review round — IMPORTANT 3, SUPERSEDED by S5.9.2 Q5. reject() used to fire
  // QuoteEvent.RETURN unconditionally on `decision.shortlistedQuoteId`, discovered a race where a
  // concurrent change-order could move the shortlisted quote off PENDING_APPROVAL between this
  // transaction's commit and the post-commit fire below, and closed it by REFUSING the whole
  // rejection (409) whenever the quote wasn't PENDING_APPROVAL — mirroring approve()'s A8.
  //
  // That refusal is exactly the bug Q5 exists to fix. approve()'s A8 refuses for the identical
  // reason, so a leg whose shortlisted quote drifted off PENDING_APPROVAL (the change-order race
  // above, but just as easily a re-quote or any other resolution the checker didn't cause) could
  // be moved by NEITHER checker action — unrecoverable without a change order or DB surgery.
  // Rejection is supposed to BE the recovery path; it must not require the thing being recovered
  // from to still be healthy. So the guard below no longer throws: it TOLERATES a drifted or
  // missing quote by skipping only that quote's own RETURN fire (logged at warn) and otherwise
  // proceeding exactly as before — the decision still reaches DRAFT with the reason, and the
  // leg's own RETURN_FULL/RETURN_PARTIAL fire still runs.
  //
  // Why this is safe rather than a reintroduction of the corruption IMPORTANT 3 was written
  // against: `returnToFullyQuoted` below is computed from a LIVE read of the leg's quotes inside
  // this same locked transaction (`legRollupTarget` → `isFullyQuotedForDecision`), which reads
  // whatever status the shortlisted quote currently holds (QUOTED, REQUOTED, or simply absent
  // from the `findMany` if the row is gone) — it was never computed FROM the quote's
  // PENDING_APPROVAL-ness, only asked to answer the question fresh. So a drifted quote is already
  // correctly reflected in the leg's landing status without any extra branching:
  //   * QUOTED — already counts as "resolved" (status.ts's LEG_ROLLUP_RESOLVED), exactly as it
  //     would if the quote were still PENDING_APPROVAL (also resolved) — no behaviour change;
  //   * REQUOTED — excluded from LEG_ROLLUP_RESOLVED (Q1), so the rollup correctly treats this
  //     leg as unresolved and reject() lands it on PARTIALLY_QUOTED, never a promoted
  //     FULLY_QUOTED — it never fabricates a resolution the drifted quote doesn't have;
  //   * missing — simply excluded from `tx.quote.findMany`'s result set, so the rollup is computed
  //     from whatever quotes remain, same as if that offer had never existed.
  // A leg whose ROW said FULLY_QUOTED at send time (`sent.from`) still lands on FULLY_QUOTED
  // regardless of the drift, per `isFullyQuotedForDecision`'s own second term — unchanged by this
  // task, not something Q5 needed to touch.
  //
  // The change-order race IMPORTANT 3 was written for is still real, but no longer needs refusing
  // to be safe: the change-order's own listener (`award-change-order.listener.ts`) independently
  // resets this exact decision to DRAFT and reopens the leg moments later regardless, so a skipped
  // quote fire here loses nothing — the quote's true post-change-order status (INVALID, headed
  // for its own REOPEN) is exactly what staying untouched preserves.
  //
  // COMPLETED (final whole-branch review, IMPORTANT 1) — Q5's first pass tolerated only the QUOTE's
  // drift and left the LEG fire unguarded, which meant it did NOT close the wedge the handoff said
  // it closed. That registered wedge is `decision = PENDING_APPROVAL` + `leg = FULLY_QUOTED` +
  // `quote = QUOTED`, reachable when `sendForApproval`'s post-commit QUOTE fire throws — the leg
  // never gets its own fire, so it never leaves FULLY_QUOTED while the decision already committed
  // to PENDING_APPROVAL. On that exact triple the quote skip fired correctly and then the leg fire
  // hit `No 'return.full' transition from 'FULLY_QUOTED'` (award.module.ts's leg machine gives both
  // return edges the two review states as sources — PENDING_APPROVAL, and, since S5.9.5's D2
  // reversal mode, APPROVED — and nothing else, so FULLY_QUOTED has no such edge), i.e. an
  // `IllegalTransitionError` AFTER the decision had committed to DRAFT: HTTP 500, the UI saying
  // "Failed to reject" for a rejection that had in fact happened, and the post-reject executive
  // notification at the tail of this method never dispatching. The state "recovered" only as a side
  // effect of a partially-applied request. The leg fire is now conditioned on the SAME question the
  // quote fire asks — is this entity still where sendForApproval left it? — and skipped with a warn
  // when it is not. Skipping is right rather than lossy: a leg that never left its rollup status has
  // nothing to be returned TO, so the leg is already correct, and every other effect of the
  // rejection (the DRAFT write, the reason, the REJECT event, the notification) still runs.
  // Mutation-proven: with the guard removed, the wedge-state test below 500s.
  async reject(
    queryId: string,
    legId: string,
    input: RejectInput,
    user: RequestUser,
  ): Promise<LegAwardDecision> {
    const { decision, returnToFullyQuoted, quoteEvent, quoteNeedsReturn, legNeedsReturn } =
      await this.prisma.$transaction(async (tx) => {
        // S5.9.5 (D6) — a locked query refuses every write. Inside the transaction, on `tx`,
        // because the transaction is this method's FIRST operation: the check then shares the
        // snapshot the rest of the decision is read and written under.
        await this.lock.assertUnlocked(queryId, tx);
        await this.lockLeg(tx, queryId, legId);
        const { decision } = await this.requireRejectable(tx, legId, user);

        // Final review IMPORTANT 1 — the LEG half of the same tolerance. Read under lockLeg's own
        // row lock, so nothing can move the leg between this read and the post-commit fire that acts
        // on it (a concurrent send/approve/reject blocks on that lock; the projector's ROLLUP_FROZEN
        // guard leaves a PENDING_APPROVAL or APPROVED leg alone). The two review states are the ONLY
        // `from`s either return edge has, so a leg sitting anywhere else has no edge to fire and
        // nothing to be returned to.
        //
        // S5.9.5 (D2) — DELIBERATE DEPARTURE from the task brief's Step 5, which had this compare
        // against a single `expectedLegStatus` derived from the decision's own mode (APPROVED in
        // reversal mode, PENDING_APPROVAL otherwise). That version is measurably wrong under a
        // concurrent approve+reject, and the failure it produces is the unrecoverable kind this
        // guard exists to prevent. Measured, not reasoned: with `Promise.all([approve, reject])` on
        // one leg (the "CRITICAL — approve and reject racing" test below), approve wins lockLeg and
        // commits `decision = APPROVED`, then does its status fires AFTER the lock is released —
        // and its LEG fire immediately queues behind reject's own `SELECT … FOR UPDATE`. So reject
        // reads `decision = APPROVED` (mode APPROVED) above a leg still sitting at
        // PENDING_APPROVAL, the mode-derived expectation misses, the leg fire is skipped, and
        // approve's queued fire then lands the leg on APPROVED. Final state, observed on 5 of 5
        // runs: decision DRAFT, quote QUOTED, leg APPROVED — which nothing can move afterwards
        // (reject 409s on a DRAFT decision; sendForApproval's A3 refuses a leg that is neither
        // FULLY_QUOTED nor past an open deadline), i.e. exactly the "unrecoverable without DB
        // surgery" outcome Q5 was written to eliminate, reintroduced by the reversal mode.
        //
        // The question this guard actually needs to ask has never been "is the row where this MODE
        // expects it?" but "does this row have a reversal edge to fire at all?" — its whole purpose
        // is to avoid an `IllegalTransitionError` thrown after the decision has committed. Since
        // Step 1 registered RETURN_FULL/RETURN_PARTIAL from APPROVED as well, that answer is now
        // "either review state", for both modes; the event is then picked from the ROW's own status
        // rather than the decision's, so a row that is one fire behind is still walked back
        // correctly instead of being abandoned. Nothing is ever REFUSED — a row outside both review
        // states is still skipped with a warning, exactly as Q5 requires.
        const legRow = await tx.leg.findUnique({ where: { id: legId }, select: { status: true } });
        const legNeedsReturn =
          legRow != null && LEG_REVERSIBLE_FROM.includes(legRow.status as LegStatus);
        if (!legNeedsReturn) {
          this.logger.warn(
            `reject: leg ${legId} is ${legRow ? legRow.status : "missing"}, not under review ` +
              `(${LEG_REVERSIBLE_FROM.join("/")}) — skipping its RETURN fire and rejecting the ` +
              "decision anyway (Q5: rejection must stay possible). Reachable when sendForApproval's " +
              "post-commit quote fire threw, leaving the decision PENDING_APPROVAL above a leg that " +
              "never moved.",
          );
        }

        // Q5 — tolerate rather than refuse. Only fire the quote's own return when it is still under
        // review, i.e. sitting on a status a reversal edge starts from; otherwise skip that one fire
        // and carry on (see the class doc above for why this is safe, and the leg block above for
        // why the set is the two review states rather than the one this mode expects).
        let quoteNeedsReturn = false;
        // S5.9.5 (D2 + Step 5c) — the event that walks the quote back, resolved to ONE of three
        // while we still hold the lock:
        //   * RETURN_EXPIRED — the offer was EXPIRED when it was sent (D4 made a priced-EXPIRED
        //     offer sendable), so it goes back to EXPIRED. RETURN and UNAPPROVE both land on QUOTED,
        //     which would report a forwarder who never answered as live — rankable as live,
        //     re-sendable, and carrying a submission window that closed weeks ago. The pre-send
        //     status is read off the send's own immutable transition row; see
        //     `wasExpiredWhenSentForApproval`. Registered from BOTH review states, so it needs no
        //     further branching here.
        //   * UNAPPROVE — APPROVED → QUOTED. The edge has existed since S5.4 and nothing had ever
        //     fired it until D2's reversal mode.
        //   * RETURN — PENDING_APPROVAL → QUOTED, the original behaviour.
        // Chosen from the QUOTE ROW's own status, not the decision's mode, for the reason given on
        // the leg block above. Default value is only a placeholder for the `!quoteNeedsReturn` path,
        // where nothing fires.
        let quoteEvent: QuoteEvent = QuoteEvent.RETURN;
        if (decision.shortlistedQuoteId) {
          const quote = await tx.quote.findUnique({
            where: { id: decision.shortlistedQuoteId },
            select: { status: true },
          });
          if (quote && QUOTE_REVERSIBLE_FROM.includes(quote.status)) {
            quoteNeedsReturn = true;
            quoteEvent = (await this.wasExpiredWhenSentForApproval(tx, decision.shortlistedQuoteId))
              ? QuoteEvent.RETURN_EXPIRED
              : quote.status === QuoteStatus.APPROVED
                ? QuoteEvent.UNAPPROVE
                : QuoteEvent.RETURN;
          } else {
            this.logger.warn(
              `reject: leg ${legId}'s shortlisted quote ${decision.shortlistedQuoteId} is ` +
                `${quote ? `already ${quote.status}` : "missing"}, not under review ` +
                `(${QUOTE_REVERSIBLE_FROM.join("/")}) — skipping its RETURN fire and rejecting the ` +
                "leg anyway (Q5: rejection must stay possible).",
            );
          }
        }

        // Deliberately asks the FACT predicate alone — never `sent.permission`. A permission is
        // licence to have been under review, not evidence the leg is fully quoted; honouring it here
        // would return a fallen-back leg to FULLY_QUOTED and leak back the exact leg/quote mismatch
        // Q1 removes. Mutation-proven (award-requote-fallback.e2e-spec.ts "(e)"). Reads the SAME
        // live quote statuses regardless of whether the shortlisted quote itself just got tolerated
        // above — see the class doc's drift-by-drift walkthrough.
        const returnToFullyQuoted = await this.isFullyQuotedForDecision(
          tx,
          legId,
          await this.latestSendForApproval(tx, legId),
        );

        // Single final write straight to DRAFT (design §9.5: "REJECTED -> back to DRAFT") rather
        // than two updates (REJECTED then DRAFT) — the "REJECTED" moment is captured as audit
        // intent by the REJECT event + rejectionReason, not as a persisted intermediate decision
        // status. Clearing sentByUserId re-enables the maker to send again.
        const updated = await tx.legAwardDecision.update({
          where: { legId },
          data: {
            status: AwardDecisionStatus.DRAFT,
            sentByUserId: null,
            rejectionReason: input.reason,
            decidedByUserId: user.userId,
            decidedAt: new Date(),
          },
        });
        await tx.awardDecisionEvent.create({
          data: {
            legId,
            queryId,
            type: "REJECT",
            reason: input.reason,
            actorId: user.userId,
          },
        });
        return { decision: updated, returnToFullyQuoted, quoteEvent, quoteNeedsReturn, legNeedsReturn };
      });

    // Quote first, then leg — same order as approve()/sendForApproval. On the ordinary path the leg
    // is still in its review state for the whole duration of the quote fire — PENDING_APPROVAL, or
    // APPROVED in D2's reversal mode, both of which are in the projector's ROLLUP_FROZEN set
    // (leg-quote.projector.ts) — so the projector's freeze (Task 2) skips the rollup it would
    // otherwise trigger off this quote's status change; the
    // leg's own RETURN_FULL/RETURN_PARTIAL fire right after is what actually moves it, using the
    // `returnToFullyQuoted` answer already computed above. The one path where that is NOT true is
    // the `legNeedsReturn === false` skip below: that branch is reached only when the leg is on
    // NEITHER review status (`LEG_REVERSIBLE_FROM`), and `ROLLUP_FROZEN` is exactly those two
    // statuses (leg-quote.projector.ts) — so on that branch, and only because the branch excludes
    // both of them, the leg is unfrozen and a quote fire here would let `LegQuoteProjector`
    // recompute it. Which is fine precisely because this method then fires nothing at the leg
    // itself, so the projector's answer is the only one, and no half-applied pair of statuses can
    // result. (Do not read this as "not PENDING_APPROVAL ⇒ not frozen" — an APPROVED leg IS frozen;
    // it simply cannot reach this branch.)
    //
    // Q5 — `quoteNeedsReturn` is false whenever the shortlisted quote had already drifted off both
    // review statuses (or vanished) by guard time; firing a return event against it here
    // would find no matching edge and throw `IllegalTransitionError` AFTER the decision above has
    // already committed to DRAFT, which is precisely the half-committed hazard this skip exists to
    // avoid. `quoteEvent` was resolved inside that same locked transaction — see there.
    if (decision.shortlistedQuoteId && quoteNeedsReturn) {
      await this.status.fire("quote", decision.shortlistedQuoteId, quoteEvent, {
        queryId,
        actorId: user.userId,
        reason: input.reason,
      });
    }

    // Final review IMPORTANT 1 — same shape, same reason as the quote skip above: firing a return
    // edge at a leg that is on NEITHER review status finds no matching transition and throws
    // `IllegalTransitionError` AFTER the decision has already committed to DRAFT, turning a
    // rejection that really happened into a 500 and swallowing the notification below with it.
    // CORRECTED (S5.9.5 review round 1, IMPORTANT 2) — this used to say "a leg that is not
    // PENDING_APPROVAL", which Step 1 falsified: RETURN_FULL/RETURN_PARTIAL now start at APPROVED
    // too (award.module.ts's leg machine), so an APPROVED leg has exactly such a transition and is
    // fired at, not skipped. `LEG_REVERSIBLE_FROM` is the set that decides it.
    if (legNeedsReturn) {
      await this.status.fire(
        "leg",
        legId,
        returnToFullyQuoted ? LegEvent.RETURN_FULL : LegEvent.RETURN_PARTIAL,
        { queryId, actorId: user.userId, reason: input.reason },
      );
    }

    // S5.9.1 (R7) — the product owner asked that a rejected leg "go directly to the executive
    // queue", and the write above already cleared sentByUserId + returned the decision to DRAFT,
    // so it is workable again by whoever picks it up. What was missing is that nothing announced
    // it. CORRECTED (final whole-branch review, I1): an earlier version of this comment claimed
    // "there is no assignment concept in this schema" and broadcast to EVERY active Executive on
    // the strength of it. There IS one — `Query.assignedUserId` (schema.prisma, indexed), written
    // on every query create (`queries.service.ts`: `input.assignedUserId ?? user.userId`) — so a
    // broadcast meant ten Executives got a notification about a leg nine of them don't work,
    // across tenants. This now follows the codebase's own established rule for exactly this
    // question, mirroring ff-portal.service.ts's post-submit comms block (and
    // rfq-schedule.listener.ts / rfq-notifications.service.ts, which resolve it the same way):
    // the assigned user IS the recipient, and the all-Executives broadcast is only the fallback
    // for a query that has none. IN_APP only (no forwarder-facing side to a reject), and the whole
    // block swallows any failure so a comms problem can never turn an already-committed,
    // already-fired reject into a 500. Must stay the LAST thing this method does, after every
    // write and every status fire above.
    try {
      const [rejectedLeg, query] = await Promise.all([
        this.prisma.leg.findUnique({ where: { id: legId }, select: { legCode: true } }),
        this.prisma.query.findUnique({
          where: { id: queryId },
          select: { queryCode: true, tenantId: true, assignedUserId: true },
        }),
      ]);
      let execIds: string[] = query?.assignedUserId ? [query.assignedUserId] : [];
      if (execIds.length === 0) {
        const execs = await this.prisma.user.findMany({
          where: { role: Role.EXECUTIVE, isActive: true },
          select: { id: true },
        });
        execIds = execs.map((u) => u.id);
      }
      await this.dispatcher.dispatch("award.rejected", {
        scope: { entityType: "QUERY", entityId: queryId },
        tokens: {
          Leg_Code: rejectedLeg?.legCode ?? "",
          Query_Code: query?.queryCode ?? "",
          Reason: input.reason,
        },
        recipients: { IN_APP: execIds },
        tenantId: query?.tenantId ?? null,
      });
    } catch (err) {
      this.logger.error(`post-reject comms failed for leg ${legId}`, err as Error);
    }

    return decision;
  }

  // The two TERMINAL endpoints (design §5.6/§8.3/§9, S5.4 Task 4). Both are QUERY-scoped (no
  // legId) — unlike every method above.
  //
  // S5.9.5 (D8) CORRECTION — this comment used to say `generateClientQuote` *cannot* reuse
  // `ComparisonService.getComparison` for pricing, because COMPARABLE_STATUSES excluded APPROVED
  // and every winning quote IS APPROVED by the time this runs, so getComparison "would emit zero
  // offers". That is no longer true: D8 put APPROVED in COMPARABLE_STATUSES, so an approved
  // winner carrying a draftJson now DOES produce offers there. (The comment also cited a
  // "line-51" comment that had already moved before this correction — don't re-add line numbers
  // for another file.)
  //
  // What is unchanged is what the loop below actually does, stated here as behaviour rather than
  // as an impossibility: each winner is priced DIRECTLY off its own draftJson via
  // computeQuoteTotals — the same engine comparison.service.ts's buildLeg uses, but targeted at
  // the single shortlisted variant instead of every variantsForMode column, and gated by this
  // method's own A6/A7 409s (no draftJson, no such variant, or no FX rate on file are each a hard
  // refusal here, where getComparison would simply emit a null usdTotal). Whether it COULD now be
  // rewritten on top of getComparison is an open question nobody has evaluated; it is not being
  // claimed either way.
  async generateClientQuote(queryId: string, user: RequestUser): Promise<Query> {
    // S5.9.5 (D6) — a locked query refuses every write, and generate is NOT one of the two
    // exceptions: re-generating over a frozen snapshot would silently replace the cost basis a
    // DRAFT quotation was already priced from. Reopen first. First, before any other read.
    await this.lock.assertUnlocked(queryId);
    // MIN-3 (task-4 review) — 404 a nonexistent query explicitly (mirrors reopenComparison
    // below), so it stays distinct from a real, zero-leg query (a 409 next).
    const query = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
    if (!query) throw new NotFoundException("Query not found");

    const legRows = await this.prisma.leg.findMany({
      where: { queryId },
      select: { id: true, legCode: true, originPointId: true, destinationPointId: true },
    });
    if (legRows.length === 0) {
      throw new ConflictException("This query has no legs to generate a client quote for");
    }

    // S5.9.3 Task 2 (P4) — product owner: "Legs sequence should be as per route diagram instead
    // of showing the order they got approved." `leg.findMany` above carries no `orderBy`, so
    // without this the winners below (and the frozen `awardSnapshot.legs`) would freeze whatever
    // order Postgres happened to return — effectively insertion order, which tracks WHEN a leg
    // was created, not WHERE it sits on the route. `orderLegsByRoute` is the SAME topology sorter
    // the FF-portal's `legOrder.ts` uses (lifted into `@svyft/shared` for this reuse) — one
    // ordering rule, not a second one. Pre-sorting by `legCode` before handing legs to it turns
    // its "stable to input order" fallback into a fully DETERMINISTIC leg-code tiebreak for a
    // disconnected/ambiguous route (two legs that don't share a point, so the route itself can't
    // order them) — real award data does contain that case.
    const legs = orderLegsByRoute(
      [...legRows].sort((a, b) => a.legCode.localeCompare(b.legCode)),
      (l) => l.originPointId,
      (l) => l.destinationPointId,
    );

    // A6 — every leg must have a decision AND that decision must be APPROVED with a shortlisted
    // winner still on it. A leg with no decision at all (never shortlisted), a leg whose
    // decision exists but never reached APPROVED (e.g. still PENDING_APPROVAL), and one missing
    // a shortlistedQuoteId (structurally unreachable — approve() guarantees it — but the column
    // is nullable) all fail the same way — one gate, one message.
    const decisions = await this.prisma.legAwardDecision.findMany({ where: { queryId } });
    const decisionByLeg = new Map(decisions.map((d) => [d.legId, d]));
    for (const leg of legs) {
      const decision = decisionByLeg.get(leg.id);
      if (!decision || decision.status !== AwardDecisionStatus.APPROVED || !decision.shortlistedQuoteId) {
        throw new ConflictException("every leg must be approved before generating the client quote");
      }
    }

    // NO four-eyes gate here, deliberately (opus whole-branch review, task-4 Round 3 FIX #2 —
    // reverses a Round-2 fix that added one). Design §16 O4: "Generate = Manager+, NO extra
    // four-eyes" — per-leg four-eyes is already enforced at each leg's approve() via
    // requireDecidable below; generate is a query-wide rollup of decisions already vetted that
    // way, not a fresh decision that itself needs a second approver. `@Roles(ADMINISTRATOR,
    // MANAGER)` on the controller route is the only gate. reject()/approve() keep four-eyes —
    // unaffected by this.

    const rates = await this.fxRates.list();
    const ratesByCurrency = latestRateByCurrency(rates);

    const winners: QueryAwardSnapshotLeg[] = [];
    for (const leg of legs) {
      const decision = decisionByLeg.get(leg.id)!;
      const quote = await this.prisma.quote.findUniqueOrThrow({
        where: { id: decision.shortlistedQuoteId! },
        select: {
          id: true,
          freightForwarderId: true,
          draftJson: true,
          rfq: { select: { currency: true } },
        },
      });

      // Defensive (task-4 review MIN-1): the two lookups below are safe only by cross-request
      // invariant (a submitted, APPROVED quote always carries a draftJson with the shortlisted
      // variant's column priced). If that invariant is ever violated, fail clean (409) instead
      // of an unhandled TypeError (500) on a financial endpoint.
      if (!quote.draftJson) {
        throw new ConflictException("winning quote is not priceable");
      }
      const draft = quote.draftJson as unknown as QuoteDraft;
      const totals = computeQuoteTotals(draft);
      const variantKey = decision.shortlistedVariant ?? AIR_VARIANT_KEY;
      const vt = totals.variants.find((t) => t.key === variantKey);
      if (!vt) {
        throw new ConflictException("winning quote is not priceable");
      }
      const nativeTotal = vt.grandTotal;

      const currency = quote.rfq?.currency ?? null;
      const rate = currency ? (ratesByCurrency.get(currency) ?? null) : null;
      const usdTotal = currency ? toUsd(nativeTotal, currency, rate) : null;
      // A7 — USD passes through toUsd unconditionally; every other currency needs a rate on
      // file. A null here is the ONLY way a non-priceable winner can reach this point (A6
      // already proved the decision/quote/variant exist), so it's the sole A7 trigger.
      if (usdTotal == null) {
        throw new ConflictException(`no FX rate on file for ${currency ?? "this quote's currency"}`);
      }

      const transitDays =
        draft.transit?.guaranteedTransitDaysByVariant[
          transitKeyForVariant(draft.mode, decision.shortlistedVariant)
        ] ?? null;

      winners.push({
        legId: leg.id,
        winningQuoteId: quote.id,
        freightForwarderId: quote.freightForwarderId,
        variant: decision.shortlistedVariant,
        currency,
        unitsPerUsd: rate?.unitsPerUsd ?? null,
        usdTotal,
        nativeTotal,
        transitDays,
      });
    }

    const awardSnapshot: QueryAwardSnapshot = {
      generatedByUserId: user.userId,
      legs: winners,
      // Re-round after summing already cents-rounded values (task-4 review IMP-2) — a Σ of
      // floats each individually rounded to 2dp can still land on a binary-float artifact (e.g.
      // 1000.10 + 500.25 + 233.33 === 1733.6799999999998), and this total is persisted verbatim
      // into the frozen, client-facing snapshot.
      combinedUsd: Math.round(winners.reduce((sum, w) => sum + w.usdTotal, 0) * 100) / 100,
    };

    // ONE transaction: freeze the snapshot, audit one GENERATE event per leg (the table's legId
    // is NOT-NULL with an FK — a single query-level/sentinel row is impossible; each carries its
    // own winner's quoteId/variant — task-4 review MIN-5 — mirroring how SHORTLIST/APPROVE
    // events record them), then recompute the query rollup INSIDE the same tx so it reads the
    // just-written awardSnapshot and persists QUOTING_CLIENT atomically. Deliberately no
    // `this.status.fire(...)` call — legs stay APPROVED (leg AWARDED is reserved for
    // post-client-Won, Stage 6); query status is a projection, never fire()'d.
    const winnerByLeg = new Map(winners.map((w) => [w.legId, w]));
    return this.prisma.$transaction(async (tx) => {
      await tx.query.update({
        where: { id: queryId },
        data: { awardSnapshot: awardSnapshot as unknown as Prisma.InputJsonValue },
      });
      for (const leg of legs) {
        const winner = winnerByLeg.get(leg.id)!;
        await tx.awardDecisionEvent.create({
          data: {
            legId: leg.id,
            queryId,
            type: "GENERATE",
            quoteId: winner.winningQuoteId,
            variant: winner.variant,
            actorId: user.userId,
          },
        });
      }
      await this.projector.recompute(queryId, tx);
      return tx.query.findUniqueOrThrow({ where: { id: queryId } });
    });
  }

  async reopenComparison(queryId: string, user: RequestUser): Promise<Query> {
    const query = await this.prisma.query.findUnique({
      where: { id: queryId },
      select: { awardSnapshot: true },
    });
    if (!query) throw new NotFoundException("Query not found");
    if (query.awardSnapshot == null) {
      throw new ConflictException("this query is not being quoted to the client");
    }

    const legs = await this.prisma.leg.findMany({ where: { queryId }, select: { id: true } });

    // Leg/decision APPROVED states are LEFT INTACT — reopening the client quote doesn't
    // un-approve legs; a later per-leg change/negotiation reverses an approval (S5.5).
    return this.prisma.$transaction(async (tx) => {
      await tx.query.update({
        where: { id: queryId },
        // Prisma.DbNull (a nullable Json column -> SQL NULL, not the JSON null literal —
        // JsonNull would read back as a truthy object, defeating the projector's `!!` check and
        // reopenComparison's own `== null` guard above) — same convention as
        // rfq.service.ts/rfq-schedule.listener.ts's draftJson clears.
        data: { awardSnapshot: Prisma.DbNull },
      });
      // S5.8 Task 4 — the cost basis a quotation was priced from just disappeared above, so a
      // DRAFT can no longer be repriced (discard it) while an ISSUED version must survive only
      // as audit (supersede, never delete). Both before the projector recompute below so its
      // `issued > 0` count already reflects the supersede.
      await tx.quotation.updateMany({
        where: { queryId, status: "ISSUED" },
        data: { status: "SUPERSEDED" },
      });
      await tx.quotation.deleteMany({ where: { queryId, status: "DRAFT" } });
      for (const leg of legs) {
        await tx.awardDecisionEvent.create({
          data: { legId: leg.id, queryId, type: "REOPEN", actorId: user.userId },
        });
      }
      await this.projector.recompute(queryId, tx);
      return tx.query.findUniqueOrThrow({ where: { id: queryId } });
    });
  }
}
