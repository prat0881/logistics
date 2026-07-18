import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { QueriesModule } from "../queries/queries.module";
import { CargoService } from "./cargo.service";
import { CargoController } from "./cargo.controller";
import { cargoImpactMap } from "./cargo.impact";

// FilesModule is NOT imported yet — FilesService is only consumed by attachMsds (Task 8).
// Import it when that method lands; importing it now would be an unused dependency.
@Module({
  imports: [ChangesModule, QueriesModule],
  controllers: [CargoController],
  providers: [CargoService],
})
export class CargoModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("cargo", cargoImpactMap);
  }
}
