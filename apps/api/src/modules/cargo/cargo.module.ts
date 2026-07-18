import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { FilesModule } from "../files/files.module";
import { QueriesModule } from "../queries/queries.module";
import { CargoService } from "./cargo.service";
import { CargoController } from "./cargo.controller";
import { cargoImpactMap } from "./cargo.impact";

@Module({
  imports: [ChangesModule, QueriesModule, FilesModule],
  controllers: [CargoController],
  providers: [CargoService],
})
export class CargoModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("cargo", cargoImpactMap);
  }
}
