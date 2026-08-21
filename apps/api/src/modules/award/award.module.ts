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
// S5.4 Task 2: AwardController/AwardService (shortlist + send-for-approval, the maker half —
// see award.service.ts) now wired in. ComparisonModule is imported for ComparisonService
// (getComparison, reused to validate a shortlist and to snapshot the recommendation).
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
// edges) so an approval can no longer bypass review. AwardService's own sendForApproval/approve
// (award.service.ts) still drive the OLD direct edges as of this task — Task 3/4 update them to
// route through PENDING_APPROVAL for real; until then those two service methods are broken by
// this contribution (see award-workflow-checker.e2e-spec.ts, sequenced to Task 3/4).
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
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.APPROVE, to: QuoteStatus.APPROVED, kind: "forward" },
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.RETURN, to: QuoteStatus.QUOTED, kind: "reopen" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.UNAPPROVE, to: QuoteStatus.QUOTED, kind: "reopen" },
      // negotiation sources — a re-quote can be asked for from any live state
      { from: QuoteStatus.QUOTED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      { from: QuoteStatus.PENDING_APPROVAL, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
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
    ]);
  }
}
