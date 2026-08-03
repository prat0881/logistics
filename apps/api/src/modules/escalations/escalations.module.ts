import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { CommsModule } from "../comms/comms.module";
import { EscalationsService } from "./escalations.service";

@Module({
  imports: [NotificationsModule, CommsModule],
  providers: [EscalationsService],
  exports: [EscalationsService],
})
export class EscalationsModule {}
