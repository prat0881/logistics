import { Module, type OnModuleInit } from "@nestjs/common";
import { StatusRegistry } from "./status.registry";
import { StatusService } from "./status.service";
import { QueryStatusProjector } from "./query-status.projector";
import { STATUS_STATE_STORE, LogBackedStateStore } from "./state-store";
import { legMachine } from "./leg.machine";
import type { StatusMachine } from "./status.types";

@Module({
  providers: [
    StatusRegistry,
    StatusService,
    QueryStatusProjector,
    { provide: STATUS_STATE_STORE, useClass: LogBackedStateStore },
  ],
  exports: [StatusService, StatusRegistry],
})
export class StatusModule implements OnModuleInit {
  constructor(private readonly registry: StatusRegistry) {}

  onModuleInit(): void {
    // The legs module owns these edges; registered here until it lands (Plan 5).
    this.registry.register(legMachine as StatusMachine);
  }
}
