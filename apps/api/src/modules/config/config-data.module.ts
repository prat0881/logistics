import { Module } from "@nestjs/common";
import { ConfigDataService } from "./config-data.service";
import { ConfigDataController } from "./config-data.controller";

@Module({ controllers: [ConfigDataController], providers: [ConfigDataService] })
export class ConfigDataModule {}
