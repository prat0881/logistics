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
  exports: [MessageTemplateService, NotificationDispatcher, ScheduledEventService, CommsSettingsService],
})
export class CommsModule {}
