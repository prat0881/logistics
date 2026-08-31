import { Module } from "@nestjs/common";
import { CommsModule } from "../comms/comms.module";
import { QueryLockModule } from "../award/query-lock.module";
import { EmailsController } from "./emails.controller";
import { EmailsService } from "./emails.service";

@Module({
  imports: [CommsModule, QueryLockModule],
  controllers: [EmailsController],
  providers: [EmailsService],
  exports: [EmailsService],
})
export class EmailsModule {}
