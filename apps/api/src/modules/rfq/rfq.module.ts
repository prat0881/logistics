import { Module, type OnModuleInit } from "@nestjs/common";
import { StatusModule } from "../status/status.module";
import { StatusRegistry } from "../status/status.registry";
import { RfqNumberService } from "./rfq-number.service";
import { RfqTokenService } from "./rfq-token.service";
import { quoteMachine } from "./quote.machine";
import { LegQuoteProjector } from "./leg-quote.projector";
import type { StatusMachine } from "../status/status.types";
import { LegStatus, LegEvent } from "@svyft/shared";
import { FreightForwardersModule } from "../freight-forwarders/freight-forwarders.module";
import { RfqController } from "./rfq.controller";
import { EligibilityService } from "./eligibility.service";
import { RfqService } from "./rfq.service";

@Module({
  imports: [StatusModule, FreightForwardersModule],
  controllers: [RfqController],
  providers: [RfqNumberService, RfqTokenService, LegQuoteProjector, EligibilityService, RfqService],
  exports: [RfqNumberService, RfqTokenService],
})
export class RfqModule implements OnModuleInit {
  constructor(private readonly registry: StatusRegistry) {}
  onModuleInit(): void {
    this.registry.register(quoteMachine as StatusMachine);
    this.registry.contribute("leg", [
      { from: LegStatus.READY_FOR_RFQ, on: LegEvent.SEND_RFQ, to: LegStatus.RFQ_SENT, kind: "forward" },
      { from: LegStatus.RFQ_SENT, on: LegEvent.QUOTE_PARTIAL, to: LegStatus.PARTIALLY_QUOTED, kind: "forward" },
      { from: LegStatus.RFQ_SENT, on: LegEvent.QUOTE_FULL, to: LegStatus.FULLY_QUOTED, kind: "forward" },
      { from: LegStatus.PARTIALLY_QUOTED, on: LegEvent.QUOTE_FULL, to: LegStatus.FULLY_QUOTED, kind: "forward" },
    ]);
  }
}
