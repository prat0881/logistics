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

  async create(input: ClientCreateInput, user?: RequestUser) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.upsert({
          where: { key: "CLIENT" },
          create: { key: "CLIENT", lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const clientCode = `CL-${String(row.lastNumber).padStart(4, "0")}`;
        return tx.client.create({ data: { clientCode, ...input, ...auditCreate(user) } });
      });
    } catch (e) {
      throw this.mapUnique(e, "A client with that company name already exists");
    }
  }

  async update(id: string, input: ClientUpdateInput, user?: RequestUser) {
    await this.get(id);
    try {
      return await this.prisma.client.update({
        where: { id },
        data: { ...input, ...auditUpdate(user) },
      });
    } catch (e) {
      throw this.mapUnique(e, "A client with that company name already exists");
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
    return this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.clientContact.updateMany({
          where: { clientId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      return tx.clientContact.create({
        data: { clientId, ...input, ...auditCreate(user) },
      });
    });
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
    return this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.clientContact.updateMany({
          where: { clientId, isPrimary: true, NOT: { id: contactId } },
          data: { isPrimary: false },
        });
      }
      return tx.clientContact.update({
        where: { id: contactId },
        data: { ...input, ...auditUpdate(user) },
      });
    });
  }

  async removeContact(clientId: string, contactId: string) {
    const existing = await this.prisma.clientContact.findFirst({
      where: { id: contactId, clientId },
    });
    if (!existing) throw new NotFoundException("Contact not found");
    await this.prisma.clientContact.delete({ where: { id: contactId } });
  }

  private mapUnique(e: unknown, msg: string): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new ConflictException(msg);
    }
    return e;
  }
}
