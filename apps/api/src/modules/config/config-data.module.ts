import { Module } from "@nestjs/common";
import { ConfigDataService } from "./config-data.service";
import { ConfigDataController } from "./config-data.controller";
import { ChargeCatalogueService } from "./charge-catalogue.service";
import { ChargeCatalogueController } from "./charge-catalogue.controller";

@Module({
  controllers: [ConfigDataController, ChargeCatalogueController],
  providers: [ConfigDataService, ChargeCatalogueService],
  exports: [ConfigDataService],
})
export class ConfigDataModule {}
