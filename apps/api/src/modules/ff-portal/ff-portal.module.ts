import { Module } from "@nestjs/common";
import { ConfigDataModule } from "../config/config-data.module";
import { StatusModule } from "../status/status.module";
import { RfqTokenService } from "../rfq/rfq-token.service";
import { FfPortalController } from "./ff-portal.controller";
import { FfPortalService } from "./ff-portal.service";
import { RfqTokenGuard } from "./rfq-token.guard";

// PrismaModule is @Global() — no need to import it here.
// RfqModule is NOT imported to avoid re-triggering its onModuleInit (which contributes
// to the "leg" status machine and requires LegsModule to have run first). Instead,
// RfqTokenService is provided directly — PrismaService is already global.
// StatusModule is imported for T6 submit (exports StatusService; does NOT contribute status edges).
@Module({
  imports: [ConfigDataModule, StatusModule],
  controllers: [FfPortalController],
  providers: [FfPortalService, RfqTokenGuard, RfqTokenService],
})
export class FfPortalModule {}
