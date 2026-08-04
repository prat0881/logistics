import { Inject, Injectable } from "@nestjs/common";
import type {
  ChangeOrderPreview,
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
import { ChangeLogPolicy } from "./change-log-policy";
import { ROUTE_VALIDATOR, type RouteValidator } from "./route-validator";

// The caller supplies HOW to persist the patch; the strategy owns the transaction
// boundary + revalidation + change-log. Plan 5's LegsService passes the real leg write.
export type UnitOfWork = (tx: Prisma.TransactionClient) => Promise<void>;

export interface ChangeResult {
  path: ImpactPath;
  class: ImpactClass;
  scope: FindingScope[];
  findings: Finding[];
  // Change-order preview phase (Task 7): set instead of applying when a change-order-path
  // request arrives without a `reason`. Absent (undefined) on every free-path result.
  needsConfirmation?: boolean;
  preview?: ChangeOrderPreview;
}

// FreePath (§7.3): apply in a tx → re-run route validation → changeLog.record. Guarded by
// ChangeLogPolicy (Task 6, §10): the durable log is change-order-only, so shouldRecord("free")
// is always false here and the record() call below can never actually fire today — the guard
// is defense-in-depth against the real (Prisma-backed) sink logging every free edit, in case
// this class is ever reached with a path other than "free". The real caller of record() is
// ChangeOrderStrategy (Task 8).
@Injectable()
export class FreePathStrategy {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ROUTE_VALIDATOR) private readonly routes: RouteValidator,
    @Inject(CHANGE_LOG) private readonly changeLog: ChangeLog,
    private readonly policy: ChangeLogPolicy,
  ) {}

  async run(req: ChangeRequest, decision: ImpactDecision, uow: UnitOfWork): Promise<ChangeResult> {
    const findings = await this.prisma.$transaction(async (tx) => {
      await uow(tx);
      const f = await this.routes.revalidate(req.queryId, tx);
      if (this.policy.shouldRecord(decision.path)) {
        await this.changeLog.record({
          queryId: req.queryId ?? "",
          entity: req.entity,
          entityId: req.id,
          changeType: req.action ?? req.field ?? "edit",
          actorId: req.actorId,
          payload: { reason: req.reason, affected: decision.scope },
        });
      }
      return f;
    });
    return { path: "free", class: decision.class, scope: decision.scope, findings };
  }
}
