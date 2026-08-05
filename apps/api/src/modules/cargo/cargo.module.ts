import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { FilesModule } from "../files/files.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { CargoService } from "./cargo.service";
import { CargoController } from "./cargo.controller";
import { cargoImpactMap } from "./cargo.impact";
import { PackageService } from "./package.service";
import { PackageController } from "./package.controller";
import { packageImpactMap } from "./package.impact";

// FilesModule (re-added in Task 5): PackageService.attachMsds needs FilesService.storeMsds —
// Task 4 dropped this import when it removed CargoService's own (now-package-level) MSDS route.
@Module({
  imports: [ChangesModule, FilesModule],
  controllers: [CargoController, PackageController],
  providers: [CargoService, PackageService],
})
export class CargoModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("cargo", cargoImpactMap);
    this.impacts.declare("package", packageImpactMap);
  }
}
