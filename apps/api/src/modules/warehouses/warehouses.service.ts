import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ContactCreateInput,
  ContactUpdateInput,
  Paginated,
  WarehouseCreateInput,
  WarehouseUpdateInput,
  WarehouseVehicleInput,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { auditCreate, auditUpdate } from "../../common/audit";
import type { RequestUser } from "../auth/types";

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

  async create(input: WarehouseCreateInput, user?: RequestUser) {
    try {
      return await this.prisma.warehouse.create({
        data: { ...input, ...auditCreate(user) } as Prisma.WarehouseUncheckedCreateInput,
      });
    } catch (e) {
      throw this.mapUnique(e, "A warehouse with that name already exists");
    }
  }

  async update(id: string, input: WarehouseUpdateInput, user?: RequestUser) {
    await this.get(id);
    try {
      return await this.prisma.warehouse.update({
        where: { id },
        data: { ...input, ...auditUpdate(user) } as Prisma.WarehouseUncheckedUpdateInput,
      });
    } catch (e) {
      throw this.mapUnique(e, "A warehouse with that name already exists");
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
      // mapUnique (create/update on Warehouse itself vs. its contacts).
      const target = String((e.meta as { target?: string | string[] })?.target ?? "");
      if (target.includes("warehouseId")) {
        return new ConflictException("This warehouse already has a primary contact");
      }
      return new ConflictException(fallback);
    }
    return e as Error;
  }
}
