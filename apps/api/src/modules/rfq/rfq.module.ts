import { Module, type OnModuleInit } from "@nestjs/common";
import { StatusModule } from "../status/status.module";
import { StatusRegistry } from "../status/status.registry";
import { ChangesModule } from "../changes/changes.module";
import { QueryLockModule } from "../award/query-lock.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { RfqNumberService } from "./rfq-number.service";
import { RfqTokenService } from "./rfq-token.service";
import { quoteMachine } from "./quote.machine";
import { quoteImpactMap } from "./quote.impact";
import { LegQuoteProjector } from "./leg-quote.projector";
import { RfqScheduleListener } from "./rfq-schedule.listener";
import { RfqNotificationsService } from "./rfq-notifications.service";
import type { StatusMachine } from "../status/status.types";
import { LegStatus, LegEvent, QuoteStatus, QuoteEvent } from "@svyft/shared";
import { FreightForwardersModule } from "../freight-forwarders/freight-forwarders.module";
import { CommsModule } from "../comms/comms.module";
import { RfqController } from "./rfq.controller";
import { EligibilityService } from "./eligibility.service";
import { RfqService } from "./rfq.service";

@Module({
  imports: [StatusModule, ChangesModule, FreightForwardersModule, CommsModule, QueryLockModule],
  controllers: [RfqController],
  providers: [RfqNumberService, RfqTokenService, LegQuoteProjector, EligibilityService, RfqService, RfqScheduleListener, RfqNotificationsService],
  // LegQuoteProjector is exported (S5.9.2 Task 1, Q1) for NegotiationService's one call to
  // `recomputeAfterRequote` — the "unfreeze gap" this projector documents on ROLLUP_FROZEN: a
  // caller that moves a leg OUT of PENDING_APPROVAL/APPROVED owns recomputing the rollup itself.
  // AwardModule already imports RfqModule (for RfqService); no new module edge, no cycle.
  exports: [RfqNumberService, RfqTokenService, RfqNotificationsService, RfqService, LegQuoteProjector],
})
export class RfqModule implements OnModuleInit {
  constructor(
    private readonly registry: StatusRegistry,
    private readonly impacts: ImpactRegistry,
  ) {}
  onModuleInit(): void {
    this.registry.register(quoteMachine as StatusMachine);
    this.registry.contribute("leg", [
      { from: LegStatus.READY_FOR_RFQ, on: LegEvent.SEND_RFQ, to: LegStatus.RFQ_SENT, kind: "forward" },
      { from: LegStatus.RFQ_SENT, on: LegEvent.QUOTE_PARTIAL, to: LegStatus.PARTIALLY_QUOTED, kind: "forward" },
      { from: LegStatus.RFQ_SENT, on: LegEvent.QUOTE_FULL, to: LegStatus.FULLY_QUOTED, kind: "forward" },
      { from: LegStatus.PARTIALLY_QUOTED, on: LegEvent.QUOTE_FULL, to: LegStatus.FULLY_QUOTED, kind: "forward" },
      // Sub-build 6 (change-order cascade): reopening a distributed leg for re-RFQ.
      { from: LegStatus.RFQ_SENT, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
      { from: LegStatus.PARTIALLY_QUOTED, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
      { from: LegStatus.FULLY_QUOTED, on: LegEvent.REOPEN, to: LegStatus.READY_FOR_RFQ, kind: "reopen" },
    ]);
    this.registry.contribute("quote", [
      // Sub-build 6: reactivating an invalidated quote on re-distribute.
      { from: QuoteStatus.INVALID, on: QuoteEvent.SEND, to: QuoteStatus.RFQ_SENT, kind: "forward" },
    ]);
    this.impacts.declare("quotes", quoteImpactMap);
  }
}
