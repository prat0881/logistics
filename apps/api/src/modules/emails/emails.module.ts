import { Module } from "@nestjs/common";
import { CommsModule } from "../comms/comms.module";
import { EmailsController } from "./emails.controller";
import { EmailsService } from "./emails.service";

@Module({
  imports: [CommsModule],
  controllers: [EmailsController],
  providers: [EmailsService],
  exports: [EmailsService],
})
export class EmailsModule {}
