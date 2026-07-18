import { Inject, Injectable } from "@nestjs/common";
import type {
  ChangeRequest,
  Finding,
  FindingScope,
  ImpactClass,
  ImpactDecision,
  ImpactPath,
} from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { CHANGE_LOG, type ChangeLog } from "./change-log";
import { ROUTE_VALIDATOR, type RouteValidator } from "./route-validator";

// The caller supplies HOW to persist the patch; the strategy owns the transaction
// boundary + revalidation + change-log. Plan 5's LegsService passes the real leg write.
export type UnitOfWork = (tx: Prisma.TransactionClient) => Promise<void>;

export interface ChangeResult {
  path: ImpactPath;
  class: ImpactClass;
  scope: FindingScope[];
  findings: Finding[];
}

// FreePath (§7.3): apply in a tx → re-run route validation → changeLog.record (no-op now).
@Injectable()
export class FreePathStrategy {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ROUTE_VALIDATOR) private readonly routes: RouteValidator,
    @Inject(CHANGE_LOG) private readonly changeLog: ChangeLog,
  ) {}

  async run(req: ChangeRequest, decision: ImpactDecision, uow: UnitOfWork): Promise<ChangeResult> {
    const findings = await this.prisma.$transaction(async (tx) => {
      await uow(tx);
      const f = await this.routes.revalidate(req.queryId, tx);
      await this.changeLog.record({
        entity: req.entity,
        id: req.id,
        field: req.field,
        action: req.action,
        reason: req.reason,
        affected: decision.scope,
        actorId: req.actorId,
      });
      return f;
    });
    return { path: "free", class: decision.class, scope: decision.scope, findings };
  }
}
