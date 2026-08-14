import { Module } from "@nestjs/common";
import { FxRatesModule } from "../fx-rates/fx-rates.module";
import { ComparisonController } from "./comparison.controller";
import { ComparisonService } from "./comparison.service";

@Module({
  imports: [FxRatesModule],
  controllers: [ComparisonController],
  providers: [ComparisonService],
})
export class ComparisonModule {}
