import { Module, type OnModuleInit } from "@nestjs/common";
import { LegEvent, LegStatus, QuoteEvent, QuoteStatus } from "@svyft/shared";
import { StatusModule } from "../status/status.module";
import { StatusRegistry } from "../status/status.registry";
import { ComparisonModule } from "../comparison/comparison.module";
import { FxRatesModule } from "../fx-rates/fx-rates.module";
import { RfqModule } from "../rfq/rfq.module";
import { CommsModule } from "../comms/comms.module";
import { PrismaModule } from "../../prisma/prisma.module";
import { AwardController } from "./award.controller";
import { AwardService } from "./award.service";
import { NegotiationService } from "./negotiation.service";
import { AwardChangeOrderListener } from "./award-change-order.listener";

// Stage 5 (S5.3, Technical Design §8.1/§8.2): the award/negotiation edges layered on top of
// the Stage-3/4 "quote"/"leg" machines. Mirrors rfq.module.ts's onModuleInit — CONTRIBUTES
// transitions onto the already-registered machines, never edits leg.machine.ts/quote.machine.ts
// and never calls `register()` (that already happened in legs.module.ts / rfq.module.ts).
// S5.4 Task 2: AwardController/AwardService (send-for-approval, the maker half — see
// award.service.ts) now wired in. ComparisonModule is imported for ComparisonService
// (getComparison, reused to validate the named offer and to snapshot the recommendation).
// CORRECTED (S5.9 final whole-branch review) — this used to read "shortlist +
// send-for-approval", the retired two-call shape. S5.9 Task 3 merged them: `PUT .../shortlist`
// and the public `shortlist` method are gone, and one transactional `send-for-approval` call
// names the offer it acts on.
// S5.4 Task 4: FxRatesModule added for FxRatesService (generateClientQuote prices each leg's
// winner directly off its own draftJson + the FX table — getComparison can't be reused there,
// see award.service.ts). QueryStatusProjector needs no new import — StatusModule already
// exports it.
// S5.5 Task 2: NegotiationService (request-requote, negotiation.service.ts) needs RfqService
// (reissueToken + the new resetDeadlineAndRearm — RfqModule now exports RfqService) and
// NotificationDispatcher (CommsModule). No DI cycle: RfqModule imports
// StatusModule/ChangesModule/FreightForwardersModule/CommsModule — none of those import
// AwardModule, and app.module.ts registers RfqModule before AwardModule.
// S5.5 Task 4: AwardChangeOrderListener (award-change-order.listener.ts, design §10.2) reacts to
// ChangesModule's "changeorder.leg.reopened" event to reverse an award on a leg a change-order
// just reopened. It's an EVENT subscriber (EventEmitter2 is global), not a DI edge — no import of
// ChangesModule needed here, only a `type`-only import of its event shape (no cycle). Needs no
// new module import: PrismaService (PrismaModule) and QueryStatusProjector (StatusModule) are
// both already imported above for AwardService's own use.
// S5.9 Task 2 (§4.4): PENDING_APPROVAL edges inserted between QUOTED/FULLY_QUOTED and APPROVED —
// send-for-approval is now the ONLY route to approval. `QUOTED --approve--> APPROVED` and
// `FULLY_QUOTED --approve--> APPROVED` are RETIRED (removed, not left in place alongside the new
// edges) so an approval can no longer bypass review. CORRECTED (S5.9 final whole-branch review)
// — this used to end with a mid-build note saying AwardService's sendForApproval/approve "still
// drive the OLD direct edges as of this task" and were "broken by this contribution until Task
// 3/4". That state is long gone: Tasks 3 and 4 rewrote both methods onto the edges below, and
// award-workflow-maker/checker.e2e-spec.ts run green against them. Left as a warning on the file
// that DEFINES the state machine, it described a machine that no longer exists.
@Module({
  imports: [StatusModule, ComparisonModule, FxRatesModule, PrismaModule, RfqModule, CommsModule],
  controllers: [AwardController],
  providers: [AwardService, NegotiationService, AwardChangeOrderListener],
})
export class AwardModule implements OnModuleInit {
  constructor(private readonly registry: StatusRegistry) {}

  onModuleInit(): void {
    this.registry.contribute("quote", [
      { from: QuoteStatus.QUOTED, on: QuoteEvent.SEND_FOR_APPROVAL, to: QuoteStatus.PENDING_APPROVAL, kind: "forward" },
      // S5.9.5 (D4) — an EXPIRED offer that still carries a price is approvable, not merely visible.
      // D4's whole point is that the forwarder's silence must not cost us a price we would have
      // accepted; a price nobody can act on would deliver half of that.
      { from: QuoteStatus.EXPIRED, on: QuoteEvent.SEND_FOR_APPROVAL, to: QuoteStatus.PENDING_APPROVAL, kind: "forward" },
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.APPROVE, to: QuoteStatus.APPROVED, kind: "forward" },
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.RETURN, to: QuoteStatus.QUOTED, kind: "reopen" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.UNAPPROVE, to: QuoteStatus.QUOTED, kind: "reopen" },
      // negotiation sources — a re-quote can be asked for from any live state
      { from: QuoteStatus.QUOTED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      // S5.9.5 (D4) — an EXPIRED quote that still carries a price can be asked again. Without this
      // edge, D4's price-preservation would freeze the forwarder OUT: their price visible and
      // approvable, their portal closed, and no way to reopen it. Re-negotiating is the deliberate act
      // that reopens it with a fresh deadline, exactly as it is for a live quote.
      { from: QuoteStatus.EXPIRED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      // durable REQUOTED re-submit
      { from: QuoteStatus.REQUOTED, on: QuoteEvent.SUBMIT, to: QuoteStatus.QUOTED, kind: "forward" },
      { from: QuoteStatus.REQUOTED, on: QuoteEvent.EXPIRE, to: QuoteStatus.EXPIRED, kind: "forward" },
      // change-order source. PENDING_APPROVAL (S5.9 Task 2 addition, beyond the brief's Step 3 —
      // see change-order.strategy.ts:74/84's mirrored "invalidating" group and its comment) is a
      // live commitment mid-review, exactly like an already-approved one: a change-order must
      // invalidate it too, not silently skip it. Without this edge, ChangeOrderStrategy.apply's
      // `status.fire("quote", ..., QuoteEvent.INVALIDATE, ...)` would throw IllegalTransitionError
      // the moment a change-order ever touched a leg carrying a PENDING_APPROVAL quote.
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.INVALIDATE, to: QuoteStatus.INVALID, kind: "reopen" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.INVALIDATE, to: QuoteStatus.INVALID, kind: "reopen" },
    ]);
    this.registry.contribute("leg", [
      { from: LegStatus.FULLY_QUOTED, on: LegEvent.SEND_FOR_APPROVAL, to: LegStatus.PENDING_APPROVAL, kind: "forward" },
      { from: LegStatus.PARTIALLY_QUOTED, on: LegEvent.SEND_FOR_APPROVAL, to: LegStatus.PENDING_APPROVAL, kind: "forward" },
      { from: LegStatus.PENDING_APPROVAL, on: LegEvent.APPROVE, to: LegStatus.APPROVED, kind: "forward" },
      { from: LegStatus.PENDING_APPROVAL, on: LegEvent.RETURN_FULL, to: LegStatus.FULLY_QUOTED, kind: "reopen" },
      { from: LegStatus.PENDING_APPROVAL, on: LegEvent.RETURN_PARTIAL, to: LegStatus.PARTIALLY_QUOTED, kind: "reopen" },
      { from: LegStatus.APPROVED, on: LegEvent.REOPEN_AWARD, to: LegStatus.FULLY_QUOTED, kind: "reopen" },
      // change-order source
      { from: LegStatus.APPROVED, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
      { from: LegStatus.PENDING_APPROVAL, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
      // S5.9.2 Task 1 (Q1, register C7) — the BACKWARD rollup edges a re-quote walks. Until now
      // a re-quote moved neither leg nor query: `rollupLegTarget` already answered
      // PARTIALLY_QUOTED/null for a leg carrying a REQUOTED quote (LEG_ROLLUP_RESOLVED excludes
      // REQUOTED on purpose), but `LegQuoteProjector`'s never-walk-backwards backstop discarded
      // the answer, so a leg read "Fully Quoted" while we were waiting on a forwarder again.
      // ONLY LegQuoteProjector's re-quote branch fires these (see its own doc for why nothing
      // else can) — hence `requote.*` event names rather than reusing the forward rollup's.
      // `requote.outstanding` also has PARTIALLY_QUOTED as a source: re-quoting the single
      // comparable offer of a leg whose other forwarder never answered leaves nothing comparable
      // at all, and that leg must fall to RFQ_SENT too, not sit at PARTIALLY_QUOTED claiming a
      // quote it no longer has.
      { from: LegStatus.FULLY_QUOTED, on: LegEvent.REQUOTE_PARTIAL, to: LegStatus.PARTIALLY_QUOTED, kind: "reopen" },
      {
        from: [LegStatus.FULLY_QUOTED, LegStatus.PARTIALLY_QUOTED],
        on: LegEvent.REQUOTE_OUTSTANDING,
        to: LegStatus.RFQ_SENT,
        kind: "reopen",
      },
    ]);
  }
}
