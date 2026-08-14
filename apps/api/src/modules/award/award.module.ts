import { Module, type OnModuleInit } from "@nestjs/common";
import { LegEvent, LegStatus, QuoteEvent, QuoteStatus } from "@svyft/shared";
import { StatusModule } from "../status/status.module";
import { StatusRegistry } from "../status/status.registry";
import { ComparisonModule } from "../comparison/comparison.module";
import { PrismaModule } from "../../prisma/prisma.module";
import { AwardController } from "./award.controller";
import { AwardService } from "./award.service";

// Stage 5 (S5.3, Technical Design §8.1/§8.2): the award/negotiation edges layered on top of
// the Stage-3/4 "quote"/"leg" machines. Mirrors rfq.module.ts's onModuleInit — CONTRIBUTES
// transitions onto the already-registered machines, never edits leg.machine.ts/quote.machine.ts
// and never calls `register()` (that already happened in legs.module.ts / rfq.module.ts).
// S5.4 Task 2: AwardController/AwardService (shortlist + send-for-approval, the maker half —
// see award.service.ts) now wired in. ComparisonModule is imported for ComparisonService
// (getComparison, reused to validate a shortlist and to snapshot the recommendation).
@Module({
  imports: [StatusModule, ComparisonModule, PrismaModule],
  controllers: [AwardController],
  providers: [AwardService],
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
