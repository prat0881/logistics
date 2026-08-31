import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { FreightForwarder, FreightMode } from "@prisma/client";
import type {
  ContactCreateInput,
  ContactUpdateInput,
  FreightForwarderCreateInput,
  FreightForwarderUpdateInput,
  Paginated,
} from "@svyft/shared";
import { PocLevel, resolveCountryCode } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { auditCreate, auditUpdate } from "../../common/audit";
import { mapOwnershipRace } from "../../common/ownership-race";
import { reconcileContacts, type ContactDelegate } from "../../common/reconcile-contacts";
import type { RequestUser } from "../auth/types";

@Injectable()
export class FreightForwardersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { q?: string; status?: string; page: number; pageSize: number }): Promise<Paginated<unknown>> {
    const where: Prisma.FreightForwarderWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { companyName: { contains: params.q, mode: "insensitive" } },
              { freightForwarderCode: { contains: params.q, mode: "insensitive" } },
              { pic: { contains: params.q, mode: "insensitive" } },
              { email: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.freightForwarder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.freightForwarder.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async get(id: string) {
    const ff = await this.prisma.freightForwarder.findUnique({ where: { id } });
    if (!ff) throw new NotFoundException("Freight forwarder not found");
    return ff;
  }

  /**
   * `contacts`/`warehouseIds` are split off before the Prisma write — FreightForwarder has no
   * scalar columns for either, so passing them straight through is read as an (invalid) nested
   * write. Unlike Clients/Warehouses, `contacts` stays OPTIONAL here (design: backward
   * compatible) because every existing FF caller sends only pic/contactNumber/email and none of
   * them supply `contacts` at all — see the seed-skip below.
   */
  async create(input: FreightForwarderCreateInput, user?: RequestUser) {
    const { contacts, warehouseIds, ...fields } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.upsert({
          where: { key: "FREIGHT_FORWARDER" },
          create: { key: "FREIGHT_FORWARDER", lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const freightForwarderCode = `FF-${String(row.lastNumber).padStart(4, "0")}`;
        const ff = await tx.freightForwarder.create({
          data: { freightForwarderCode, ...fields, ...auditCreate(user) },
        });
        // Seed the primary contact from the pic/contactNumber/email the create schema still
        // requires, in the same transaction. Without this, the "every forwarder has exactly
        // one PRIMARY contact" invariant only held for rows the migration backfilled — every
        // newly-created forwarder had populated columns but an empty contact list. This makes
        // the invariant hold from row 0, and it's also what makes update() safe to stop
        // writing these columns (below): there's now always a contact row for
        // syncPrimaryContactColumns to read from.
        //
        // Skipped, not merged, when the caller supplies its own PRIMARY: writing both would
        // insert two PRIMARY rows and FreightForwarderContact_one_primary would reject the
        // whole transaction.
        const suppliedPrimary = (contacts ?? []).some((c) => c.pocLevel === PocLevel.PRIMARY);
        if (!suppliedPrimary) {
          await tx.freightForwarderContact.create({
            data: {
              freightForwarderId: ff.id,
              name: ff.pic,
              email: ff.email,
              contactNo: ff.contactNumber,
              pocLevel: "PRIMARY",
              ...auditCreate(user),
            },
          });
        }
        if (contacts?.length) {
          await reconcileContacts({
            delegate: tx.freightForwarderContact as unknown as ContactDelegate,
            ownerKey: "freightForwarderId",
            ownerId: ff.id,
            contacts,
            user,
          });
        }
        // pic/contactNumber/email are derived from the primary contact after this point —
        // syncPrimaryContactColumns is their sole writer post-create (see its own doc comment).
        await this.syncPrimaryContactColumns(tx, ff.id, user);
        if (warehouseIds) await this.setWarehousesTx(tx, ff.id, warehouseIds, user);
        return ff;
      });
    } catch (e) {
      throw this.mapUnique(e, "A freight forwarder with that company name already exists");
    }
  }

  async update(id: string, input: FreightForwarderUpdateInput, user?: RequestUser) {
    await this.get(id);
    const { contacts, warehouseIds, ...fields } = input;
    // pic/contactNumber/email are derived — syncPrimaryContactColumns (below) is their sole
    // writer. whLocation is derived too — setWarehousesTx is its sole writer, from the
    // assigned warehouses. All four are dropped from every update so an admin editing forwarder
    // details can never race with, or be silently reverted by, an unrelated contact/warehouse
    // write (the bug this whole create()-seeds/update()-strips split exists to close — without
    // this, the form's stale cached whLocation, e.g. "" right after the picker assigns a
    // warehouse but before this page's own query refetches, would blank out a value the
    // picker had just correctly set). They stay on the *create* schema/DTO: creation still
    // needs pic/contactNumber/email (the columns are NOT NULL) and rfq.service.ts still reads
    // all four — only this write path ignores them now. freightForwarderUpdateSchema already
    // omits all four so `input`/`fields` can't carry them, but the delete stays defence in
    // depth against a caller that bypasses the schema.
    const data: Prisma.FreightForwarderUpdateInput = { ...fields, ...auditUpdate(user) };
    delete data.pic;
    delete data.contactNumber;
    delete data.email;
    delete data.whLocation;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ff = await tx.freightForwarder.update({ where: { id }, data });
        if (contacts) {
          await reconcileContacts({
            delegate: tx.freightForwarderContact as unknown as ContactDelegate,
            ownerKey: "freightForwarderId",
            ownerId: id,
            contacts,
            user,
          });
        }
        await this.syncPrimaryContactColumns(tx, id, user);
        if (warehouseIds) await this.setWarehousesTx(tx, id, warehouseIds, user);
        return ff;
      });
    } catch (e) {
      throw this.mapUnique(e, "A freight forwarder with that company name already exists");
    }
  }

  async listContacts(freightForwarderId: string) {
    await this.get(freightForwarderId);
    return this.prisma.freightForwarderContact.findMany({
      where: { freightForwarderId },
      orderBy: { createdAt: "asc" },
    });
  }

  async listWarehouses(freightForwarderId: string) {
    await this.get(freightForwarderId);
    return this.prisma.warehouse.findMany({
      where: { freightForwarderId },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Sets this forwarder's warehouses to exactly `warehouseIds`. One transaction, so a warehouse
   * can never be momentarily owned by two forwarders, and the contested check sees a consistent
   * view. Ownership lives on Warehouse rather than a join table because a join table would
   * permit the many-to-many the requirement rules out.
   *
   * The contested check's `OR` covers two conflict shapes: a warehouse already owned by a
   * *different* forwarder (`notIn: [ffId]` lets re-assigning to the same forwarder through, so
   * this call is idempotent), or a warehouse owned by any client. A warehouse this forwarder
   * already owns, or one owned by nobody, is never contested.
   */
  async setWarehouses(ffId: string, warehouseIds: string[], user?: RequestUser) {
    await this.get(ffId);
    try {
      return await this.prisma.$transaction((tx) =>
        this.setWarehousesTx(tx, ffId, warehouseIds, user),
      );
    } catch (e) {
      // Same-request conflicts are caught above by the contested check and thrown as
      // ConflictException directly (unaffected by this catch, since it's already the right
      // shape). This catch only re-maps the DB-level CHECK-constraint violation a genuine
      // concurrent race can still produce — see mapOwnershipRace.
      throw mapOwnershipRace(e);
    }
  }

  /**
   * The body of setWarehouses, taking the caller's transaction client so the composite
   * create/update can reuse the same contested-ownership logic (and the whLocation dual-write)
   * inside *their* transaction rather than duplicating it. The public setWarehouses above
   * (PUT /:id/warehouses) opens its own transaction around this and keeps its own error mapping.
   */
  private async setWarehousesTx(
    tx: Prisma.TransactionClient,
    ffId: string,
    warehouseIds: string[],
    user?: RequestUser,
  ) {
    const contested = await tx.warehouse.findFirst({
      where: {
        id: { in: warehouseIds },
        OR: [
          { freightForwarderId: { not: null, notIn: [ffId] } },
          { clientId: { not: null } },
        ],
      },
    });
    if (contested) {
      throw new ConflictException(`${contested.name} is already assigned to another record`);
    }
    await tx.warehouse.updateMany({
      where: { freightForwarderId: ffId, id: { notIn: warehouseIds } },
      data: { freightForwarderId: null, ...auditUpdate(user) },
    });
    await tx.warehouse.updateMany({
      where: { id: { in: warehouseIds } },
      data: { freightForwarderId: ffId, ...auditUpdate(user) },
    });
    const assigned = await tx.warehouse.findMany({
      where: { freightForwarderId: ffId },
      orderBy: { name: "asc" },
    });
    // Phase 1 dual-write, the counterpart to syncPrimaryContactColumns: rfq.service.ts
    // snapshots whLocation into the RFQ payload, so it tracks the assigned warehouses until
    // the Stage-4 pass repoints that read at this relation. Retired with it.
    await tx.freightForwarder.update({
      where: { id: ffId },
      data: {
        whLocation: assigned.map((w) => w.name).join(", ") || null,
        ...auditUpdate(user),
      },
    });
    return assigned;
  }

  /**
   * Keeps the three columns rfq.service.ts snapshots — pic, contactNumber, email — aligned
   * with the primary contact. `whLocation` is a fourth column rfq.service.ts also reads, but
   * this function does not touch it: it tracks warehouses, which don't exist until Task 6;
   * Task 14 wires it to the warehouse relation. Phase 1 of the parallel change — the RFQ
   * payload keeps reading columns while the contact table becomes the source of truth.
   * Retired in the Stage-4 pass; see the design doc §2.2.
   *
   * Fallback: if no ACTIVE PRIMARY remains (just deleted, demoted via an update, or
   * deactivated), fall back to the oldest remaining ACTIVE contact rather than leaving the
   * columns naming someone who's gone — an RFQ addressed to a departed contact is worse than
   * one addressed to a still-active contact who just isn't flagged primary. Both lookups filter
   * `status: "ACTIVE"`, and the primary one must: without it a deactivated PRIMARY outranked an
   * ACTIVE non-primary, and the RFQ payload named the deactivated person. Only when there is no
   * ACTIVE contact left at all do the columns keep their last-known values:
   * pic/contactNumber/email are NOT NULL on FreightForwarder with no other source of truth, and
   * ContactList has no UI yet to reassign a primary (known gap, not this task's to fix).
   *
   * Takes `user` for the same reason `setWarehouses` does — this is a write to FreightForwarder,
   * and the branch that added createdById/updatedById must not leave a writer that doesn't
   * stamp them.
   */
  private async syncPrimaryContactColumns(
    tx: Prisma.TransactionClient,
    ffId: string,
    user?: RequestUser,
  ) {
    const primary = await tx.freightForwarderContact.findFirst({
      where: { freightForwarderId: ffId, pocLevel: "PRIMARY", status: "ACTIVE" },
    });
    const source =
      primary ??
      (await tx.freightForwarderContact.findFirst({
        where: { freightForwarderId: ffId, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      }));
    if (!source) return;
    await tx.freightForwarder.update({
      where: { id: ffId },
      data: {
        pic: source.name,
        contactNumber: source.contactNo,
        email: source.email,
        ...auditUpdate(user),
      },
    });
  }

  async createContact(ffId: string, input: ContactCreateInput, user?: RequestUser) {
    await this.get(ffId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const contact = await tx.freightForwarderContact.create({
          data: { freightForwarderId: ffId, ...input, ...auditCreate(user) },
        });
        await this.syncPrimaryContactColumns(tx, ffId, user);
        return contact;
      });
    } catch (e) {
      throw this.mapUnique(e, "A contact with that value already exists");
    }
  }

  async updateContact(
    ffId: string,
    contactId: string,
    input: ContactUpdateInput,
    user?: RequestUser,
  ) {
    const existing = await this.prisma.freightForwarderContact.findFirst({
      where: { id: contactId, freightForwarderId: ffId },
    });
    if (!existing) throw new NotFoundException("Contact not found");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const contact = await tx.freightForwarderContact.update({
          where: { id: contactId },
          data: { ...input, ...auditUpdate(user) },
        });
        await this.syncPrimaryContactColumns(tx, ffId, user);
        return contact;
      });
    } catch (e) {
      throw this.mapUnique(e, "A contact with that value already exists");
    }
  }

  async deleteContact(ffId: string, contactId: string, user?: RequestUser) {
    const existing = await this.prisma.freightForwarderContact.findFirst({
      where: { id: contactId, freightForwarderId: ffId },
    });
    if (!existing) throw new NotFoundException("Contact not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.freightForwarderContact.delete({ where: { id: contactId } });
      await this.syncPrimaryContactColumns(tx, ffId, user);
    });
  }

  async findEligible(criteria: {
    countries: string[];
    countriesComplete: boolean;
    mode: FreightMode | null;
    requireDg: boolean;
    broaden: boolean;
  }): Promise<FreightForwarder[]> {
    const active = await this.prisma.freightForwarder.findMany({
      where: { status: "ACTIVE", ...(criteria.requireDg ? { handleDg: true } : {}) },
      orderBy: { companyName: "asc" },
    });
    if (criteria.broaden) return active;
    return active.filter((ff) => {
      const modeOk = criteria.mode === null || ff.modes.includes(criteria.mode);
      // Country: an FF must cover EVERY endpoint country, and BOTH endpoints must
      // have a resolvable country (`countriesComplete`) — a leg missing/unresolvable
      // endpoint country matches no FF (show none). `criteria.countries` are already
      // ISO codes (resolved in leg-context); resolve the FF's availableCountries too
      // so any legacy/case difference can't cause a false miss.
      const ffCodes = new Set<string>(
        ff.availableCountries
          .map((c): string | null => resolveCountryCode(c))
          .filter((c): c is string => !!c),
      );
      const countryOk =
        criteria.countriesComplete && criteria.countries.every((c) => ffCodes.has(c));
      return modeOk && countryOk;
    });
  }

  private mapUnique(e: unknown, fallback: string): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // FreightForwarderContact_one_primary is a raw-SQL partial unique index (Prisma can't
      // declare one via @@unique), so Prisma can't map the violated constraint to a name it
      // knows — it reports the column list instead. As with ClientContact (Task 4), P2002's
      // meta.target here is ["freightForwarderId"], never the index name. The FreightForwarder
      // model's own unique constraint (companyName) never reports "freightForwarderId", so this
      // check is unambiguous between the two callers of mapUnique. This branch is the sole
      // source of the 409 for the standalone POST/PATCH /:id/contacts endpoints (design keeps
      // them; ff-contacts.e2e-spec.ts:146 asserts this exact message), and it also serves the
      // composite create/update path's concurrent-promotion race: reconcileContacts' guard is
      // query-before-write, so two concurrent PATCHes can still both pass the check and race
      // each other to this index.
      const target = String((e.meta as { target?: string | string[] })?.target ?? "");
      if (target.includes("freightForwarderId")) {
        return new ConflictException("This freight forwarder already has a primary contact");
      }
      return new ConflictException(fallback);
    }
    return e;
  }
}
