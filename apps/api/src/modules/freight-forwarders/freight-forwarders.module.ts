import { Module } from "@nestjs/common";
import { FreightForwardersService } from "./freight-forwarders.service";
import { FreightForwardersController } from "./freight-forwarders.controller";

@Module({
  controllers: [FreightForwardersController],
  providers: [FreightForwardersService],
  exports: [FreightForwardersService],
})
export class FreightForwardersModule {}
