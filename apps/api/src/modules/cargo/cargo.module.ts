import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { QueryLockModule } from "../award/query-lock.module";
import { FilesModule } from "../files/files.module";
import { QueriesModule } from "../queries/queries.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { CargoService } from "./cargo.service";
import { CargoController } from "./cargo.controller";
import { cargoImpactMap } from "./cargo.impact";
import { PackageService } from "./package.service";
import { PackageController } from "./package.controller";
import { packageImpactMap } from "./package.impact";
import { ItemService } from "./item.service";
import { ItemController } from "./item.controller";
import { itemImpactMap } from "./item.impact";

// FilesModule (re-added in Task 5): PackageService.attachMsds needs FilesService.storeMsds —
// Task 4 dropped this import when it removed CargoService's own (now-package-level) MSDS route.
// QueriesModule (Unit 1 / Task 8): PackageService/ItemService need QueriesService.syncDgIndicator
// after a create/update that can add a DG tag. Cycle-safe — only app.module.ts imports
// CargoModule, and QueriesModule's own imports (Changes/Status/Legs/Routing) never reach back to
// CargoModule; QueriesModule already `exports: [QueriesService]`.
@Module({
  imports: [ChangesModule, FilesModule, QueriesModule, QueryLockModule],
  controllers: [CargoController, PackageController, ItemController],
  providers: [CargoService, PackageService, ItemService],
})
export class CargoModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("cargo", cargoImpactMap);
    this.impacts.declare("package", packageImpactMap);
    this.impacts.declare("item", itemImpactMap);
  }
}
