import { Injectable } from "@nestjs/common";
import type { Finding } from "@svyft/shared";
import type { Prisma } from "@prisma/client";

export const ROUTE_VALIDATOR = Symbol("ROUTE_VALIDATOR");

export interface RouteValidator {
  // Re-run route validation for the touched query after a Free-path apply.
  revalidate(queryId: string | undefined, tx: Prisma.TransactionClient): Promise<Finding[]>;
}

// No-op now; Plan 5 implements this with validateRoute() over the query graph.
@Injectable()
export class NoopRouteValidator implements RouteValidator {
  async revalidate(
    _queryId: string | undefined,
    _tx: Prisma.TransactionClient,
  ): Promise<Finding[]> {
    return [];
  }
}
