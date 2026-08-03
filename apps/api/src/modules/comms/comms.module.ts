import { Module } from "@nestjs/common";
import { MessageTemplateService } from "./message-template.service";
import { NotificationDispatcher } from "./notification-dispatcher.service";
import { ScheduledEventService } from "./scheduled-event.service";
import { ScheduledEventScheduler } from "./scheduled-event.scheduler";
import { MESSAGE_TRANSPORT, LogTransport } from "./transport";

@Module({
  providers: [
    MessageTemplateService,
    NotificationDispatcher,
    ScheduledEventService,
    ScheduledEventScheduler,
    { provide: MESSAGE_TRANSPORT, useClass: LogTransport },
  ],
  exports: [MessageTemplateService, NotificationDispatcher, ScheduledEventService],
})
export class CommsModule {}
