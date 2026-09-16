import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { refineWarehouseInvariants } from "@svyft/shared";
import type {
  ContactCreateInput,
  ContactUpdateInput,
  ContactUpsert,
  ContactUpsertInput,
  Paginated,
  WarehouseCreateInput,
  WarehouseInvariantInput,
  WarehouseMasterType,
  WarehouseUpdateInput,
  WarehouseVehicleInput,
  WarehouseVehicleUpsert,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { auditCreate, auditUpdate } from "../../common/audit";
import { reconcileContacts, type ContactDelegate } from "../../common/reconcile-contacts";
import type { RequestUser } from "../auth/types";

/**
 * `WarehouseCreateInput`/`WarehouseUpdateInput` are `z.input` types (the web form types its
 * react-hook-form state with them, where `.default()`ed fields are legitimately absent), but what
 * actually reaches this service is the ZodValidationPipe's OUTPUT — every default applied. The two
 * differ only in optionality, so this narrows the contacts array to the post-parse shape
 * `reconcileContacts` expects instead of making every field `?? fallback`.
 */
const parsed = (contacts: ContactUpsertInput[]): ContactUpsert[] => contacts as ContactUpsert[];

@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    q?: string;
    status?: string;
    type?: string;
    unassigned?: boolean;
    page: number;
    pageSize: number;
  }): Promise<Paginated<unknown>> {
    const where: Prisma.WarehouseWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.type ? { type: params.type as never } : {}),
      ...(params.unassigned ? { freightForwarderId: null, clientId: null } : {}),
      ...(params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: "insensitive" } },
              { city: { contains: params.q, mode: "insensitive" } },
              { country: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.warehouse.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.warehouse.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async get(id: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id },
      include: { contacts: true, vehicles: true },
    });
    if (!warehouse) throw new NotFoundException("Warehouse not found");
    return {
      ...warehouse,
      totalVehicles: warehouse.vehicles.reduce((sum, v) => sum + v.quantity, 0),
    };
  }

  /**
   * One transaction for the warehouse row, its contacts and its vehicles (design C1) — the three
   * used to be three separate requests from three buttons, so a failure halfway left a warehouse
   * with no contact. The children are split off the payload before the Prisma write: `Warehouse`
   * has no `contacts`/`vehicles` scalar columns, so passing them straight through is read as an
   * (invalid) nested write and Prisma rejects the whole call.
   *
   * The `as Prisma.WarehouseUncheckedCreateInput` this write used to carry is deliberately gone.
   * It was load-bearing for nothing and it suppressed the excess-property error that is the only
   * compile-time signal that a child key leaked into the row write — Clients and Freight
   * Forwarders both fail `typecheck` in that case; with the cast, warehouses failed only at
   * runtime, as a 400 "Invalid request" from PrismaExceptionFilter.
   */
  async create(input: WarehouseCreateInput, user?: RequestUser) {
    const { contacts, vehicles, ...fields } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const warehouse = await tx.warehouse.create({
          data: { ...fields, ...auditCreate(user) },
        });
        await reconcileContacts({
          delegate: tx.warehouseContact as unknown as ContactDelegate,
          ownerKey: "warehouseId",
          ownerId: warehouse.id,
          contacts: parsed(contacts),
          user,
        });
        if (vehicles) await this.reconcileVehicles(tx, warehouse.id, vehicles);
        return warehouse;
      });
    } catch (e) {
      throw this.mapUnique(e, "A warehouse with that name already exists");
    }
  }

  async update(id: string, input: WarehouseUpdateInput, user?: RequestUser) {
    const existing = await this.get(id);
    // Split the children off before anything else: `merged` below probes the patch with
    // `"<field>" in ...`, so it must see the row's own fields only — never `contacts`/`vehicles`.
    const { contacts, vehicles, ...fields } = input;

    // The invariant (owned/contracted needs agreement+insurance dates; a rate needs a
    // currency+unit) is a property of the row *after* the write, not of the patch alone: a
    // partial-schema superRefine on the patch can't tell "type is OWNED and the dates are
    // already set" from "type is OWNED and this patch leaves them unset". So build the
    // post-write row here — existing values overlaid with whatever keys the patch actually
    // supplied — and validate that, before ever touching Prisma. Only the fields the invariant
    // reads are merged (never id/timestamps/audit/relations): everything else about the write
    // stays a genuine partial update.
    const merged: WarehouseInvariantInput = {
      type: (fields.type ?? existing.type) as WarehouseMasterType,
      agreementValidUntil: "agreementValidUntil" in fields ? fields.agreementValidUntil : existing.agreementValidUntil,
      insuranceValidUntil: "insuranceValidUntil" in fields ? fields.insuranceValidUntil : existing.insuranceValidUntil,
      handlingRate: "handlingRate" in fields ? fields.handlingRate : existing.handlingRate,
      storageRate: "storageRate" in fields ? fields.storageRate : existing.storageRate,
      weekendWorkingFee: "weekendWorkingFee" in fields ? fields.weekendWorkingFee : existing.weekendWorkingFee,
      rateCurrency: "rateCurrency" in fields ? fields.rateCurrency : existing.rateCurrency,
      handlingUnit: "handlingUnit" in fields ? fields.handlingUnit : existing.handlingUnit,
      storageUnit: "storageUnit" in fields ? fields.storageUnit : existing.storageUnit,
    };
    const issues: { path: (string | number)[]; message: string }[] = [];
    refineWarehouseInvariants(merged, {
      addIssue: (issue) => issues.push({ path: issue.path ?? [], message: issue.message ?? "Invalid" }),
    });
    if (issues.length > 0) {
      throw new BadRequestException({ message: "Validation failed", issues });
    }

    try {
      // Still writes only what the patch supplied — the merge above exists solely to evaluate the
      // invariant. An omitted `contacts`/`vehicles` key means "leave the children alone"; an empty
      // array means "remove them all", which is why these are `if (children)`, not truthiness on
      // length.
      return await this.prisma.$transaction(async (tx) => {
        const warehouse = await tx.warehouse.update({
          where: { id },
          data: { ...fields, ...auditUpdate(user) },
        });
        if (contacts) {
          await reconcileContacts({
            delegate: tx.warehouseContact as unknown as ContactDelegate,
            ownerKey: "warehouseId",
            ownerId: id,
            contacts: parsed(contacts),
            user,
          });
        }
        if (vehicles) await this.reconcileVehicles(tx, id, vehicles);
        return warehouse;
      });
    } catch (e) {
      throw this.mapUnique(e, "A warehouse with that name already exists");
    }
  }

  /**
   * Reconcile one warehouse's vehicle list to exactly `vehicles`: rows whose id is absent from the
   * payload are deleted, rows carrying an id are updated, rows without one are created.
   *
   * Unlike contacts, WarehouseVehicle carries no unique constraint at all (only a plain
   * `@@index([warehouseId])`), so nothing here is order-sensitive the way reconcileContacts'
   * deletes/demotions/promotions/creates sequence is — this is a plain delete-then-upsert. MUST
   * still be called inside the caller's transaction, with `tx` as its client, so a rejected id
   * leaves the parent write rolled back too.
   */
  private async reconcileVehicles(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    vehicles: WarehouseVehicleUpsert[],
  ) {
    const existing = await tx.warehouseVehicle.findMany({ where: { warehouseId } });
    const keptIds = new Set(
      vehicles.map((v) => v.id).filter((id): id is string => typeof id === "string"),
    );
    // Checked against THIS warehouse's rows, not globally: an id belonging to another warehouse
    // is a 404 here, never a silent cross-warehouse write.
    for (const id of keptIds) {
      if (!existing.some((e) => e.id === id)) {
        throw new NotFoundException("Vehicle not found on this warehouse");
      }
    }
    const removed = existing.filter((e) => !keptIds.has(e.id)).map((e) => e.id);
    if (removed.length > 0) {
      await tx.warehouseVehicle.deleteMany({ where: { id: { in: removed } } });
    }
    for (const v of vehicles) {
      // `tonnage` is a plain string in the shared schema but a TruckTonnage enum column, same as
      // in addVehicle above — the cast is the column type, not a way around a real type error.
      if (v.id) {
        await tx.warehouseVehicle.update({
          where: { id: v.id },
          data: { tonnage: v.tonnage, quantity: v.quantity } as Prisma.WarehouseVehicleUncheckedUpdateInput,
        });
      } else {
        await tx.warehouseVehicle.create({
          data: { warehouseId, tonnage: v.tonnage, quantity: v.quantity } as Prisma.WarehouseVehicleUncheckedCreateInput,
        });
      }
    }
  }

  async listContacts(warehouseId: string) {
    await this.get(warehouseId);
    return this.prisma.warehouseContact.findMany({
      where: { warehouseId },
      orderBy: { createdAt: "asc" },
    });
  }

  async addContact(warehouseId: string, input: ContactCreateInput, user?: RequestUser) {
    await this.get(warehouseId);
    try {
      return await this.prisma.warehouseContact.create({
        data: { warehouseId, ...input, ...auditCreate(user) },
      });
    } catch (e) {
      throw this.mapUnique(e, "A contact with that value already exists");
    }
  }

  async updateContact(
    warehouseId: string,
    contactId: string,
    input: ContactUpdateInput,
    user?: RequestUser,
  ) {
    const existing = await this.prisma.warehouseContact.findFirst({
      where: { id: contactId, warehouseId },
    });
    if (!existing) throw new NotFoundException("Contact not found");
    try {
      return await this.prisma.warehouseContact.update({
        where: { id: contactId },
        data: { ...input, ...auditUpdate(user) },
      });
    } catch (e) {
      throw this.mapUnique(e, "A contact with that value already exists");
    }
  }

  async removeContact(warehouseId: string, contactId: string) {
    const existing = await this.prisma.warehouseContact.findFirst({
      where: { id: contactId, warehouseId },
    });
    if (!existing) throw new NotFoundException("Contact not found");
    await this.prisma.warehouseContact.delete({ where: { id: contactId } });
  }

  async listVehicles(warehouseId: string) {
    await this.get(warehouseId);
    return this.prisma.warehouseVehicle.findMany({
      where: { warehouseId },
      orderBy: { createdAt: "asc" },
    });
  }

  async addVehicle(warehouseId: string, input: WarehouseVehicleInput) {
    await this.get(warehouseId);
    try {
      return await this.prisma.warehouseVehicle.create({
        data: { warehouseId, ...input } as Prisma.WarehouseVehicleUncheckedCreateInput,
      });
    } catch (e) {
      throw this.mapUnique(e, "A vehicle entry with that value already exists");
    }
  }

  async removeVehicle(warehouseId: string, vehicleId: string) {
    const existing = await this.prisma.warehouseVehicle.findFirst({
      where: { id: vehicleId, warehouseId },
    });
    if (!existing) throw new NotFoundException("Vehicle not found");
    await this.prisma.warehouseVehicle.delete({ where: { id: vehicleId } });
  }

  private mapUnique(e: unknown, fallback: string) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // WarehouseContact_one_primary is a raw-SQL partial unique index (Prisma can't declare
      // one via @@unique), so Prisma can't map the violated constraint to a name it knows — it
      // reports the column list instead. Verified against the live error shape: P2002's
      // meta.target here is ["warehouseId"], never the index name
      // "WarehouseContact_one_primary". The Warehouse model's own unique constraint (name)
      // never reports "warehouseId", so this check is unambiguous between the callers of
      // mapUnique (create/update on Warehouse itself vs. its contacts). Since the composite
      // create/update path went in, this branch serves only the standalone
      // POST/PATCH /:id/contacts endpoints: on the composite path reconcileContacts refuses a
      // second primary before it writes anything, so no P2002 ever reaches here from there.
      const target = String((e.meta as { target?: string | string[] })?.target ?? "");
      if (target.includes("warehouseId")) {
        return new ConflictException("This warehouse already has a primary contact");
      }
      return new ConflictException(fallback);
    }
    return e as Error;
  }
}
