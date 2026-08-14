import { Module } from "@nestjs/common";
import { FxRatesModule } from "../fx-rates/fx-rates.module";
import { ComparisonController } from "./comparison.controller";
import { ComparisonService } from "./comparison.service";

@Module({
  imports: [FxRatesModule],
  controllers: [ComparisonController],
  providers: [ComparisonService],
  // Exported so other Stage-5 modules (award.module.ts) can inject getComparison() rather
  // than re-deriving offers/recommendations themselves.
  exports: [ComparisonService],
})
export class ComparisonModule {}
