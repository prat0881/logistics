import { Controller, Get } from "@nestjs/common";
import type { ChargeLineDefinitionDto } from "@svyft/shared";
import { ChargeCatalogueService } from "./charge-catalogue.service";

@Controller("charge-line-definitions")
export class ChargeCatalogueController {
  constructor(private readonly svc: ChargeCatalogueService) {}

  @Get()
  list(): Promise<ChargeLineDefinitionDto[]> {
    return this.svc.list();
  }
}
