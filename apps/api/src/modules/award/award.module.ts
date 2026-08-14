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
@Module({
  imports: [StatusModule, ComparisonModule, FxRatesModule, PrismaModule, RfqModule, CommsModule],
  controllers: [AwardController],
  providers: [AwardService, NegotiationService, AwardChangeOrderListener],
})
export class AwardModule implements OnModuleInit {
  constructor(private readonly registry: StatusRegistry) {}

  onModuleInit(): void {
    this.registry.contribute("quote", [
      { from: QuoteStatus.QUOTED, on: QuoteEvent.APPROVE, to: QuoteStatus.APPROVED, kind: "forward" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.UNAPPROVE, to: QuoteStatus.QUOTED, kind: "reopen" },
      { from: QuoteStatus.QUOTED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      { from: QuoteStatus.APPROVED, on: QuoteEvent.REQUEST_REQUOTE, to: QuoteStatus.REQUOTED, kind: "reopen" },
      // durable REQUOTED re-submit
      { from: QuoteStatus.REQUOTED, on: QuoteEvent.SUBMIT, to: QuoteStatus.QUOTED, kind: "forward" },
      { from: QuoteStatus.REQUOTED, on: QuoteEvent.EXPIRE, to: QuoteStatus.EXPIRED, kind: "forward" },
      // change-order source
      { from: QuoteStatus.APPROVED, on: QuoteEvent.INVALIDATE, to: QuoteStatus.INVALID, kind: "reopen" },
    ]);
    this.registry.contribute("leg", [
      { from: LegStatus.FULLY_QUOTED, on: LegEvent.APPROVE, to: LegStatus.APPROVED, kind: "forward" },
      { from: LegStatus.APPROVED, on: LegEvent.REOPEN_AWARD, to: LegStatus.FULLY_QUOTED, kind: "reopen" },
      // change-order source
      { from: LegStatus.APPROVED, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
    ]);
  }
}
