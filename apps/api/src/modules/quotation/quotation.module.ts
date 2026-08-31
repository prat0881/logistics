import { Module } from "@nestjs/common";
import { CommsModule } from "../comms/comms.module";
import { StatusModule } from "../status/status.module";
import { QuotationController } from "./quotation.controller";
import { QuotationService } from "./quotation.service";

// Task 4 — issue() needs MessageTemplateService (CommsModule) to compose the audit MessageLog
// row, and QueryStatusProjector (StatusModule) to recompute AWAITING_CLIENT_DECISION inside the
// same transaction, exactly as AwardModule wires generateClientQuote/reopenComparison.
@Module({
  imports: [CommsModule, StatusModule],
  controllers: [QuotationController],
  providers: [QuotationService],
  exports: [QuotationService],
})
export class QuotationModule {}
