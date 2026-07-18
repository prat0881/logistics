// apps/api/src/modules/legs/legs.module.ts
import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { StatusModule } from "../status/status.module";
import { StatusRegistry } from "../status/status.registry";
import { legMachine } from "../status/leg.machine";
import type { StatusMachine } from "../status/status.types";
import { LegsController } from "./legs.controller";
import { LegsService } from "./legs.service";
import { legImpactMap } from "./leg.impact";

@Module({
  imports: [ChangesModule, StatusModule],
  controllers: [LegsController],
  providers: [LegsService],
  exports: [LegsService],
})
export class LegsModule implements OnModuleInit {
  constructor(
    private readonly impacts: ImpactRegistry,
    private readonly registry: StatusRegistry,
  ) {}
  onModuleInit(): void {
    this.impacts.declare("leg", legImpactMap);
    this.registry.register(legMachine as StatusMachine);
  }
}
