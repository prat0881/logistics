import type { Machine } from "@svyft/shared";
import type { Finding } from "@svyft/shared";
import type { Prisma } from "@prisma/client";

// Context handed to a transition's guard/effect during StatusService.fire.
// Guards are pure (they read routeValid/findings); `tx` is present so effects can
// run inside fire's transaction. The index signature keeps it open for future
// stages' domain data without editing this type.
export interface FireContext {
  actorId?: string | null;
  tenantId?: string | null;
  queryId?: string;
  routeValid?: boolean;
  findings?: Finding[];
  tx?: Prisma.TransactionClient;
  [k: string]: unknown;
}

// All machines share the fire context, so the registry can store them uniformly.
export type StatusMachine = Machine<string, string, FireContext>;
