import { Injectable } from "@nestjs/common";
import type { ChangeRequest, ImpactDecision } from "@svyft/shared";
import type { ChangeResult, UnitOfWork } from "./free-path.strategy";
import { ChangeOrderNotAvailableError } from "./errors";

// Stage 4+ cascade lands here: impact preview → confirm + reason → cascade to the
// minimal scope → drive `reopen` transitions (the seam) → invalidate quotes →
// durable change-log. Unreachable in Stage 3 (ScopeResolver.downstreamWork ≡ false),
// so it is a stub that can never fire — proven by change-mediator.e2e-spec.
@Injectable()
export class ChangeOrderStrategy {
  async run(
    _req: ChangeRequest,
    _decision: ImpactDecision,
    _uow: UnitOfWork,
  ): Promise<ChangeResult> {
    throw new ChangeOrderNotAvailableError();
  }
}
