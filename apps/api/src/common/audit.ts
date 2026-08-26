import type { RequestUser } from "../modules/auth/types";

// createdById/updatedById are @db.Uuid with no FK to User (see prisma/schema.prisma) — a
// dangling actor id is fine, but a non-UUID one is not: Postgres rejects the whole write.
// Some RBAC-only e2e fixtures sign non-UUID subs (they never persist the id anywhere else),
// so an id that isn't UUID-shaped is treated the same as no actor: null, not a thrown error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorId(user?: RequestUser): string | null {
  const id = user?.userId;
  return id && UUID_RE.test(id) ? id : null;
}

/**
 * The only place actor columns are written. Services call these rather than setting
 * createdById/updatedById inline, so a missed write is a compile error at the call site
 * rather than a silently unaudited row.
 */
export function auditCreate(user?: RequestUser) {
  const id = actorId(user);
  return { createdById: id, updatedById: id };
}

export function auditUpdate(user?: RequestUser) {
  return { updatedById: actorId(user) };
}
