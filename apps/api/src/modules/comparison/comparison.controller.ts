import { Controller, Get, Param } from "@nestjs/common";
import { ComparisonService } from "./comparison.service";

@Controller("queries/:id")
export class ComparisonController {
  constructor(private readonly comparison: ComparisonService) {}

  // Executive+ (no @Roles) — authenticated only. Read model for the Compare Quotes screen
  // (design §11 GET .../comparison).
  @Get("comparison")
  getComparison(@Param("id") id: string) {
    return this.comparison.getComparison(id);
  }
}
