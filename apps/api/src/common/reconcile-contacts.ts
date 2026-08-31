import { ConflictException, NotFoundException } from "@nestjs/common";
import { PocLevel, PRIMARY_DUPLICATE_MESSAGE, type ContactUpsert } from "@svyft/shared";
import { auditCreate, auditUpdate } from "./audit";
import type { RequestUser } from "../modules/auth/types";

/**
 * The structural subset of a Prisma contact delegate this module needs. Declared structurally
 * rather than importing Prisma's three generated delegate types so ClientContact,
 * FreightForwarderContact and WarehouseContact share one implementation — the three tables have
 * identical columns (design D5/D6) and differ only in their owner FK.
 */
export interface ContactDelegate {
  findMany(args: { where: Record<string, string> }): Promise<{ id: string }[]>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

/** The column payload for one contact: everything the caller sent except `id`, which addresses
 *  the row rather than being written to it. */
function row(c: ContactUpsert): Record<string, unknown> {
  const data: Record<string, unknown> = { ...c };
  delete data.id;
  return data;
}

const isPrimary = (c: ContactUpsert) => c.pocLevel === PocLevel.PRIMARY;

/**
 * Reconcile one owner's contact list to exactly `contacts`. MUST be called inside the caller's
 * transaction, with `delegate` taken from that transaction client.
 *
 * Write order is deletes -> demotions -> promotions -> creates, and that order is the whole
 * point. `<Owner>Contact_one_primary` is a partial unique index, so a payload that swaps which
 * contact is primary is valid as a whole but violates the index at every intermediate state if
 * the promotion lands before the demotion. Reordering these four blocks reintroduces a bug that
 * only appears on a swap, never on a plain edit.
 */
export async function reconcileContacts(opts: {
  delegate: ContactDelegate;
  ownerKey: string;
  ownerId: string;
  contacts: ContactUpsert[];
  user?: RequestUser;
}): Promise<void> {
  const { delegate, ownerKey, ownerId, contacts, user } = opts;

  // Query-before-write rather than catching P2002. Prisma reports the violated partial index as
  // its COLUMN list (["<ownerKey>"]), never the index name, so a caught conflict on the
  // composite path could not be told apart from any other unique violation on that column.
  // Checking here gives the user a real message. Deliberately before the first delegate call:
  // an invalid payload must not write anything at all.
  if (contacts.filter(isPrimary).length > 1) {
    throw new ConflictException(PRIMARY_DUPLICATE_MESSAGE);
  }

  const existing = await delegate.findMany({ where: { [ownerKey]: ownerId } });
  const existingIds = new Set(existing.map((c) => c.id));
  const keptIds = new Set(
    contacts.map((c) => c.id).filter((id): id is string => typeof id === "string"),
  );

  for (const id of keptIds) {
    if (!existingIds.has(id)) {
      throw new NotFoundException("Contact not found on this record");
    }
  }

  // 1. deletes
  const removed = [...existingIds].filter((id) => !keptIds.has(id));
  if (removed.length > 0) {
    await delegate.deleteMany({ where: { id: { in: removed } } });
  }

  // 2. demotions — every surviving row that is NOT becoming primary is written first, which
  //    frees the index before step 3 claims it.
  for (const c of contacts) {
    if (!c.id || isPrimary(c)) continue;
    await delegate.update({ where: { id: c.id }, data: { ...row(c), ...auditUpdate(user) } });
  }

  // 3. promotions on existing rows
  for (const c of contacts) {
    if (!c.id || !isPrimary(c)) continue;
    await delegate.update({ where: { id: c.id }, data: { ...row(c), ...auditUpdate(user) } });
  }

  // 4. creates, non-primary first. NOT for an index reason — there is no index hazard left
  //    among creates: the guard at the top of this function caps the payload at one PRIMARY,
  //    the deletes have already run, and the promotions have already run, so a single primary
  //    create cannot collide with anything. This ordering is defensive consistency with the
  //    demote-then-promote pass above (a reader tracing "when does a primary get written?" finds
  //    one answer, always last), and it is what reconcile-contacts.spec.ts pins.
  const fresh = contacts.filter((c) => !c.id);
  for (const c of [...fresh.filter((f) => !isPrimary(f)), ...fresh.filter(isPrimary)]) {
    await delegate.create({
      data: { [ownerKey]: ownerId, ...row(c), ...auditCreate(user) },
    });
  }
}
