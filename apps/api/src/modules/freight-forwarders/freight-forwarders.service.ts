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
import { resolveCountryCode } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { auditCreate, auditUpdate } from "../../common/audit";
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

  async create(input: FreightForwarderCreateInput, user?: RequestUser) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.upsert({
          where: { key: "FREIGHT_FORWARDER" },
          create: { key: "FREIGHT_FORWARDER", lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const freightForwarderCode = `FF-${String(row.lastNumber).padStart(4, "0")}`;
        return tx.freightForwarder.create({
          data: { freightForwarderCode, ...input, ...auditCreate(user) },
        });
      });
    } catch (e) {
      throw this.mapUnique(e, "A freight forwarder with that company name already exists");
    }
  }

  async update(id: string, input: FreightForwarderUpdateInput, user?: RequestUser) {
    await this.get(id);
    try {
      return await this.prisma.freightForwarder.update({
        where: { id },
        data: { ...input, ...auditUpdate(user) },
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

  /**
   * Keeps the four columns rfq.service.ts snapshots (pic, contactNumber, email, whLocation)
   * aligned with the primary contact. Phase 1 of the parallel change — the RFQ payload keeps
   * reading columns while the contact table becomes the source of truth. Retired in the
   * Stage-4 pass; see the design doc §2.2.
   *
   * When no primary contact remains (e.g. the primary was just deleted, or demoted via an
   * update), this is a deliberate no-op: pic/contactNumber/email are NOT NULL on
   * FreightForwarder, there is no other authoritative source to fall back to, and
   * ContactList has no UI yet to reassign a primary (known gap, not this task's to fix). The
   * columns keep their last-known values rather than being nulled or replaced with a
   * placeholder — "the last real contact we had" is a better snapshot for the RFQ payload
   * than a fabricated one.
   */
  private async syncPrimaryContactColumns(tx: Prisma.TransactionClient, ffId: string) {
    const primary = await tx.freightForwarderContact.findFirst({
      where: { freightForwarderId: ffId, pocLevel: "PRIMARY" },
    });
    if (!primary) return;
    await tx.freightForwarder.update({
      where: { id: ffId },
      data: { pic: primary.name, contactNumber: primary.contactNo, email: primary.email },
    });
  }

  async createContact(ffId: string, input: ContactCreateInput, user?: RequestUser) {
    await this.get(ffId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const contact = await tx.freightForwarderContact.create({
          data: { freightForwarderId: ffId, ...input, ...auditCreate(user) },
        });
        await this.syncPrimaryContactColumns(tx, ffId);
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
        await this.syncPrimaryContactColumns(tx, ffId);
        return contact;
      });
    } catch (e) {
      throw this.mapUnique(e, "A contact with that value already exists");
    }
  }

  async deleteContact(ffId: string, contactId: string) {
    const existing = await this.prisma.freightForwarderContact.findFirst({
      where: { id: contactId, freightForwarderId: ffId },
    });
    if (!existing) throw new NotFoundException("Contact not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.freightForwarderContact.delete({ where: { id: contactId } });
      await this.syncPrimaryContactColumns(tx, ffId);
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
      // check is unambiguous between the two callers of mapUnique.
      const target = String((e.meta as { target?: string | string[] })?.target ?? "");
      if (target.includes("freightForwarderId")) {
        return new ConflictException("This freight forwarder already has a primary contact");
      }
      return new ConflictException(fallback);
    }
    return e;
  }
}
