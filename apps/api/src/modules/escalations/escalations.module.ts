import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { EmailsModule } from "../emails/emails.module";
import { EscalationsService } from "./escalations.service";
import { EscalationsScheduler } from "./escalations.scheduler";

@Module({
  imports: [NotificationsModule, EmailsModule],
  providers: [EscalationsService, EscalationsScheduler],
  exports: [EscalationsService],
})
export class EscalationsModule {}
