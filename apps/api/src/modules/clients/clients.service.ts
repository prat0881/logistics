import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ClientCreateInput,
  ClientUpdateInput,
  ContactCreateInput,
  ContactUpdateInput,
  Paginated,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { auditCreate, auditUpdate } from "../../common/audit";
import { mapOwnershipRace } from "../../common/ownership-race";
import { reconcileContacts, type ContactDelegate } from "../../common/reconcile-contacts";
import type { RequestUser } from "../auth/types";

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    q?: string;
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<Paginated<unknown>> {
    const where: Prisma.ClientWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { companyName: { contains: params.q, mode: "insensitive" } },
              { clientCode: { contains: params.q, mode: "insensitive" } },
              { country: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.client.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.client.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async get(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { contacts: true },
    });
    if (!client) throw new NotFoundException("Client not found");
    return client;
  }

  /**
   * One transaction for the parent row, its contacts and its warehouse links (design C1): the
   * three used to be three separate requests from three buttons, so a failure halfway left a
   * client with no contact. The children are split off the payload before the Prisma write —
   * `Client` has no `contacts`/`warehouseIds` scalar columns, so passing them straight through
   * would be read as an (invalid) nested write.
   */
  async create(input: ClientCreateInput, user?: RequestUser) {
    const { contacts, warehouseIds, ...fields } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.upsert({
          where: { key: "CLIENT" },
          create: { key: "CLIENT", lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const clientCode = `CL-${String(row.lastNumber).padStart(4, "0")}`;
        const client = await tx.client.create({
          data: { clientCode, ...fields, ...auditCreate(user) },
        });
        await reconcileContacts({
          delegate: tx.clientContact as unknown as ContactDelegate,
          ownerKey: "clientId",
          ownerId: client.id,
          contacts,
          user,
        });
        if (warehouseIds) await this.setWarehousesTx(tx, client.id, warehouseIds, user);
        return client;
      });
    } catch (e) {
      throw this.mapUnique(mapOwnershipRace(e), "A client with that company name already exists");
    }
  }

  async update(id: string, input: ClientUpdateInput, user?: RequestUser) {
    await this.get(id);
    const { contacts, warehouseIds, ...fields } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const client = await tx.client.update({
          where: { id },
          data: { ...fields, ...auditUpdate(user) },
        });
        if (contacts) {
          await reconcileContacts({
            delegate: tx.clientContact as unknown as ContactDelegate,
            ownerKey: "clientId",
            ownerId: id,
            contacts,
            user,
          });
        }
        if (warehouseIds) await this.setWarehousesTx(tx, id, warehouseIds, user);
        return client;
      });
    } catch (e) {
      throw this.mapUnique(mapOwnershipRace(e), "A client with that company name already exists");
    }
  }

  async listContacts(clientId: string) {
    await this.get(clientId);
    return this.prisma.clientContact.findMany({
      where: { clientId },
      orderBy: { createdAt: "asc" },
    });
  }

  async addContact(clientId: string, input: ContactCreateInput, user?: RequestUser) {
    await this.get(clientId);
    try {
      return await this.prisma.clientContact.create({
        data: { clientId, ...input, ...auditCreate(user) },
      });
    } catch (e) {
      throw this.mapUnique(e, "A contact with that value already exists");
    }
  }

  async updateContact(
    clientId: string,
    contactId: string,
    input: ContactUpdateInput,
    user?: RequestUser,
  ) {
    const existing = await this.prisma.clientContact.findFirst({
      where: { id: contactId, clientId },
    });
    if (!existing) throw new NotFoundException("Contact not found");
    try {
      return await this.prisma.clientContact.update({
        where: { id: contactId },
        data: { ...input, ...auditUpdate(user) },
      });
    } catch (e) {
      throw this.mapUnique(e, "A contact with that value already exists");
    }
  }

  async removeContact(clientId: string, contactId: string) {
    const existing = await this.prisma.clientContact.findFirst({
      where: { id: contactId, clientId },
    });
    if (!existing) throw new NotFoundException("Contact not found");
    await this.prisma.clientContact.delete({ where: { id: contactId } });
  }

  async listWarehouses(clientId: string) {
    await this.get(clientId);
    return this.prisma.warehouse.findMany({
      where: { clientId },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Mirrors FreightForwardersService.setWarehouses: one transaction so a warehouse is never
   * momentarily owned by two parents, contested against a *different* client or against any
   * forwarder, and re-assignment to the same client is not a conflict. Client has no
   * whLocation-equivalent column for rfq.service.ts to read, so there is no snapshot to
   * keep in sync here.
   */
  async setWarehouses(clientId: string, warehouseIds: string[], user?: RequestUser) {
    await this.get(clientId);
    try {
      return await this.prisma.$transaction((tx) =>
        this.setWarehousesTx(tx, clientId, warehouseIds, user),
      );
    } catch (e) {
      // See FreightForwardersService.setWarehouses's identical catch: the contested check
      // in setWarehousesTx already throws ConflictException directly for the same-request
      // case; this only
      // re-maps the DB-level CHECK-constraint violation a genuine concurrent race can produce.
      throw mapOwnershipRace(e);
    }
  }

  /**
   * The body of setWarehouses, taking the caller's transaction client so the composite
   * create/update can reuse the same contested-ownership logic inside *their* transaction
   * rather than duplicating it. The public setWarehouses above (PUT /:id/warehouses,
   * design C8) opens its own transaction around this and keeps its own error mapping.
   */
  private async setWarehousesTx(
    tx: Prisma.TransactionClient,
    clientId: string,
    warehouseIds: string[],
    user?: RequestUser,
  ) {
    const contested = await tx.warehouse.findFirst({
      where: {
        id: { in: warehouseIds },
        OR: [{ clientId: { not: null, notIn: [clientId] } }, { freightForwarderId: { not: null } }],
      },
    });
    if (contested) {
      throw new ConflictException(`${contested.name} is already assigned to another record`);
    }
    await tx.warehouse.updateMany({
      where: { clientId, id: { notIn: warehouseIds } },
      data: { clientId: null, ...auditUpdate(user) },
    });
    await tx.warehouse.updateMany({
      where: { id: { in: warehouseIds } },
      data: { clientId, ...auditUpdate(user) },
    });
    return tx.warehouse.findMany({ where: { clientId }, orderBy: { name: "asc" } });
  }

  private mapUnique(e: unknown, fallback: string) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // ClientContact_one_primary is a raw-SQL partial unique index (Prisma can't declare
      // one via @@unique), so Prisma can't map the violated constraint to a name it knows —
      // it reports the column list instead. Verified against the live error shape: P2002's
      // meta.target here is ["clientId"], never the index name "ClientContact_one_primary".
      // The Client model's own unique constraint (companyName) never reports "clientId", so
      // this check is unambiguous between the callers of mapUnique.
      //
      // This branch now serves ONLY addContact/updateContact — the standalone POST/PATCH
      // /:id/contacts endpoints, which stay live (design C8) and whose 409 message two e2e
      // specs assert (clients.e2e-spec.ts, clients-address.e2e-spec.ts). The composite
      // create/update path never reaches it: reconcileContacts raises the same conflict
      // itself, before the write, where it can name the rule instead of the column.
      const target = String((e.meta as { target?: string | string[] })?.target ?? "");
      if (target.includes("clientId")) {
        return new ConflictException("This client already has a primary contact");
      }
      return new ConflictException(fallback);
    }
    return e as Error;
  }
}
