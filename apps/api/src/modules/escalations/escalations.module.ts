import { Module } from "@nestjs/common";
import { CommsModule } from "../comms/comms.module";
import { EscalationsService } from "./escalations.service";

@Module({
  imports: [CommsModule],
  providers: [EscalationsService],
  exports: [EscalationsService],
})
export class EscalationsModule {}
