// apps/api/src/modules/routing/routing.route-validator.ts
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Finding } from "@svyft/shared";
import type { RouteValidator } from "../changes/route-validator";
import { RoutingService } from "./routing.service";

// Replaces NoopRouteValidator. Runs validateRoute at DRAFT phase after a Free-path apply, in the
// SAME tx (reads the just-written state). Resilient to a missing/absent query → [] (no findings):
// covers both "no such row" (findUnique → null) and a malformed id — `queryId` is `@db.Uuid`, so a
// non-UUID string (e.g. a synthetic test id predating real Prisma-backed queries) throws P2023
// rather than returning null. Caught narrowly here; confirmed (against a live Postgres instance)
// that catching it inside an interactive transaction does NOT poison the tx for later statements.
@Injectable()
export class RoutingRouteValidator implements RouteValidator {
  constructor(private readonly routing: RoutingService) {}

  async revalidate(queryId: string | undefined, tx: Prisma.TransactionClient): Promise<Finding[]> {
    if (!queryId) return [];
    let found: { id: string } | null;
    try {
      found = await tx.query.findUnique({ where: { id: queryId }, select: { id: true } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2023") return [];
      throw e;
    }
    if (!found) return [];
    return this.routing.validate(queryId, "draft", tx);
  }
}
