import type { RequestUser } from "../modules/auth/types";

/**
 * The only place actor columns are written. Services call these rather than setting
 * createdById/updatedById inline, so a missed write is a compile error at the call site
 * rather than a silently unaudited row.
 */
export function auditCreate(user?: RequestUser) {
  const id = user?.userId ?? null;
  return { createdById: id, updatedById: id };
}

export function auditUpdate(user?: RequestUser) {
  return { updatedById: user?.userId ?? null };
}
