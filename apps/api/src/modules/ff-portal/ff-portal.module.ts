import { Module } from "@nestjs/common";
import { StatusModule } from "../status/status.module";
import { CommsModule } from "../comms/comms.module";
import { RfqTokenService } from "../rfq/rfq-token.service";
import { FfPortalController } from "./ff-portal.controller";
import { FfPortalService } from "./ff-portal.service";
import { RfqTokenGuard } from "./rfq-token.guard";

// PrismaModule is @Global() — no need to import it here.
// RfqTokenService is provided directly rather than importing the whole RfqModule — this only
// needs that one small stateless service, not RfqModule's full surface. (Originally this also
// sidestepped an onModuleInit-ordering hazard — RfqModule's own onModuleInit contributes to the
// "leg" status machine and required LegsModule's register() to have already run — but that
// hazard no longer exists: StatusRegistry.contribute()/register() are order-independent as of
// S5.5 task-2's review fix. Kept as-is since the minimal-surface reasoning still holds.)
// StatusModule is imported for T6 submit (exports StatusService; does NOT contribute status edges).
// CommsModule is imported for T11 submit comms (NotificationDispatcher + ScheduledEventService).
// ConfigDataModule dropped in Task 9 (FF Portal v2) — resolveScope no longer reads
// FreightDensityFactor (the portal now seeds no density; the FF enters Charged Wt directly).
@Module({
  imports: [StatusModule, CommsModule],
  controllers: [FfPortalController],
  providers: [FfPortalService, RfqTokenGuard, RfqTokenService],
})
export class FfPortalModule {}
