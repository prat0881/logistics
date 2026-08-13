import { Module } from "@nestjs/common";
import { FxRatesService } from "./fx-rates.service";
import { FxRatesController } from "./fx-rates.controller";

@Module({ controllers: [FxRatesController], providers: [FxRatesService] })
export class FxRatesModule {}
