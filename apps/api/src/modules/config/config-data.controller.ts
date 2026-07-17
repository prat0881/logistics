import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { Role, checklistItemUpdateSchema, densityFactorUpdateSchema } from "@svyft/shared";
import type { ChecklistItemUpdateInput, DensityFactorUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { ConfigDataService } from "./config-data.service";

@Controller("config")
export class ConfigDataController {
  constructor(private readonly config: ConfigDataService) {}

  @Get("density-factors")
  densityFactors() {
    return this.config.densityFactors();
  }

  @Roles(Role.ADMINISTRATOR)
  @Patch("density-factors/:mode")
  updateDensity(
    @Param("mode") mode: string,
    @Body(new ZodValidationPipe(densityFactorUpdateSchema)) body: DensityFactorUpdateInput,
  ) {
    return this.config.updateDensityFactor(mode, body);
  }

  @Get("checklist-definition")
  checklist() {
    return this.config.checklist();
  }

  @Roles(Role.ADMINISTRATOR)
  @Patch("checklist-definition/:itemKey")
  updateChecklist(
    @Param("itemKey") itemKey: string,
    @Body(new ZodValidationPipe(checklistItemUpdateSchema)) body: ChecklistItemUpdateInput,
  ) {
    return this.config.updateChecklistItem(itemKey, body);
  }
}
