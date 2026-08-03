import { Module } from "@nestjs/common";
import { MessageTemplateService } from "./message-template.service";

@Module({
  providers: [MessageTemplateService],
  exports: [MessageTemplateService],
})
export class CommsModule {}
