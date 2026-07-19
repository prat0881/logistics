import { Module } from "@nestjs/common";
import { StatusRegistry } from "./status.registry";
import { StatusService } from "./status.service";
import { QueryStatusProjector } from "./query-status.projector";
import { STATUS_STATE_STORE, DispatchingStateStore } from "./state-store";

@Module({
  providers: [
    StatusRegistry,
    StatusService,
    QueryStatusProjector,
    { provide: STATUS_STATE_STORE, useClass: DispatchingStateStore },
  ],
  exports: [StatusService, StatusRegistry, QueryStatusProjector],
})
export class StatusModule {}
