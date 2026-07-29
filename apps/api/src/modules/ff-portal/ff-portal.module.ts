import { Module } from "@nestjs/common";
import { ConfigDataModule } from "../config/config-data.module";
import { RfqModule } from "../rfq/rfq.module";
import { FfPortalController } from "./ff-portal.controller";
import { FfPortalService } from "./ff-portal.service";
import { RfqTokenGuard } from "./rfq-token.guard";

// PrismaModule is @Global() — no need to import it here.
// StatusModule not imported yet — that's for T6 submit.
@Module({
  imports: [ConfigDataModule, RfqModule],
  controllers: [FfPortalController],
  providers: [FfPortalService, RfqTokenGuard],
})
export class FfPortalModule {}
