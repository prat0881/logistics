import { Module } from "@nestjs/common";
import { FxRatesService } from "./fx-rates.service";
import { FxRatesController } from "./fx-rates.controller";

@Module({
  controllers: [FxRatesController],
  providers: [FxRatesService],
  exports: [FxRatesService], // reused read-only by ComparisonModule (S5.2)
})
export class FxRatesModule {}
