import { Module } from "@nestjs/common";
import { MessageTemplateService } from "./message-template.service";
import { NotificationDispatcher } from "./notification-dispatcher.service";
import { ScheduledEventService } from "./scheduled-event.service";
import { ScheduledEventScheduler } from "./scheduled-event.scheduler";
import { CommsSettingsService } from "./comms-settings.service";
import { MESSAGE_TRANSPORT, LogTransport } from "./transport";

@Module({
  providers: [
    MessageTemplateService,
    NotificationDispatcher,
    ScheduledEventService,
    ScheduledEventScheduler,
    CommsSettingsService,
    { provide: MESSAGE_TRANSPORT, useClass: LogTransport },
  ],
  // MESSAGE_TRANSPORT exported (fix round 1, S5.8 Task 4 review IMPORTANT #2) — QuotationService
  // writes its own MessageLog row directly (its issue() needs the transaction client, which
  // NotificationDispatcher doesn't take), so it needs the same transport NotificationDispatcher
  // uses to actually call .send() after that transaction commits.
  exports: [
    MessageTemplateService,
    NotificationDispatcher,
    ScheduledEventService,
    CommsSettingsService,
    MESSAGE_TRANSPORT,
  ],
})
export class CommsModule {}
