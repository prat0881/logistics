import { Module } from "@nestjs/common";
import { MessageTemplateService } from "./message-template.service";
import { NotificationDispatcher } from "./notification-dispatcher.service";
import { MESSAGE_TRANSPORT, LogTransport } from "./transport";

@Module({
  providers: [
    MessageTemplateService,
    NotificationDispatcher,
    LogTransport,
    { provide: MESSAGE_TRANSPORT, useClass: LogTransport },
  ],
  exports: [MessageTemplateService, NotificationDispatcher],
})
export class CommsModule {}
