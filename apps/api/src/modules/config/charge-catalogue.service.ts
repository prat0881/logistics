import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  chargeLineKey,
  deriveRole,
  deriveZone,
  type ChargeLineCreateInput,
  type ChargeLineDefinitionAdminDto,
  type ChargeLineDefinitionDto,
  type ChargeLineUpdateInput,
  type ReferenceTag,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { auditCreate, auditUpdate } from "../../common/audit";
import type { RequestUser } from "../auth/types";

@Injectable()
export class ChargeCatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ChargeLineDefinitionDto[]> {
    const rows = await this.prisma.chargeLineDefinition.findMany({
      where: { isActive: true },
      orderBy: [{ mode: "asc" }, { sortOrder: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id, key: r.key, mode: r.mode, role: r.role, inputType: r.inputType,
      zone: r.zone, tagKey: r.tagKey, label: r.label, sortOrder: r.sortOrder, isActive: r.isActive,
    }));
  }

  // Additive counterpart to list(): every row (active and inactive) in the editable admin
  // shape (category/variant/isAdditional), never the role/zone shape list() serves to the RFQ
  // workspace. Ordered mode → category → sortOrder so the admin screen's default view is
  // stable; list() itself is intentionally left with no orderBy change.
  async listAdmin(): Promise<ChargeLineDefinitionAdminDto[]> {
    const rows = await this.prisma.chargeLineDefinition.findMany({
      orderBy: [{ mode: "asc" }, { category: "asc" }, { sortOrder: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id, key: r.key, mode: r.mode, variant: r.variant, category: r.category,
      label: r.label, isAdditional: r.isAdditional,
      tagKey: r.tagKey as ReferenceTag | null, // consistent with the cast convention used
      // elsewhere for this same Prisma string → ReferenceTag narrowing (e.g. cargo-shape.ts)
      inputType: r.inputType, sortOrder: r.sortOrder, isActive: r.isActive,
    }));
  }

  async create(input: ChargeLineCreateInput, user?: RequestUser) {
    const tagKey = input.tagKey ?? null;
    // Catch the real hazard before minting a key: two rows meaning the same thing. chargeLineKey
    // slugifies+truncates the label, so two labels that read as duplicates to a human (different
    // case, or different enough after truncation/slugging) can still mint different keys and
    // sail past the `key` unique constraint below as a near-duplicate row. Check by
    // mode+category+label (case-insensitive) instead, active or inactive, and name the existing
    // key in the error so the admin can go use that line instead of creating another one.
    const duplicate = await this.prisma.chargeLineDefinition.findFirst({
      where: { mode: input.mode, category: input.category, label: { equals: input.label, mode: "insensitive" } },
    });
    if (duplicate) {
      throw new ConflictException(
        `A ${input.mode} ${input.category} charge line named "${input.label}" already exists (key: ${duplicate.key}). Use that line instead of creating a near-duplicate.`,
      );
    }
    const key = chargeLineKey(input.mode, input.category, input.label);
    const maxSort = await this.prisma.chargeLineDefinition.aggregate({
      where: { mode: input.mode, category: input.category },
      _max: { sortOrder: true },
    });
    try {
      return await this.prisma.chargeLineDefinition.create({
        data: {
          key,
          mode: input.mode,
          variant: input.variant,
          category: input.category,
          label: input.label,
          isAdditional: input.isAdditional,
          tagKey,
          inputType: input.inputType ?? "PLAIN",
          isActive: input.isActive ?? true,
          sortOrder: input.sortOrder ?? (maxSort._max.sortOrder ?? 0) + 10,
          // Derived, never supplied by the caller — the quote layer still reads these.
          zone: deriveZone(input.category, input.mode),
          role: deriveRole(input.isAdditional, tagKey),
          ...auditCreate(user),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(`A charge line with the key ${key} already exists`);
      }
      throw e;
    }
  }

  async update(id: string, input: ChargeLineUpdateInput, user?: RequestUser) {
    // Same near-duplicate hazard create() guards against, reachable in one PATCH: the update
    // schema permits `label`, and `key` is minted once at create and never re-derived, so
    // renaming a row to an existing row's label produces exactly the pair of rows create()
    // refuses — with the `key` unique constraint no help at all, since neither key changes.
    // Scoped to the row's OWN mode+category (both immutable after creation, per D18) and
    // excluding the row itself, so a no-op PATCH that re-sends the current label still passes.
    if (input.label !== undefined) {
      const current = await this.prisma.chargeLineDefinition.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("Charge line not found");
      const duplicate = await this.prisma.chargeLineDefinition.findFirst({
        where: {
          id: { not: id },
          mode: current.mode,
          category: current.category,
          label: { equals: input.label, mode: "insensitive" },
        },
      });
      if (duplicate) {
        throw new ConflictException(
          `A ${current.mode} ${current.category} charge line named "${input.label}" already exists (key: ${duplicate.key}). Use that line instead of creating a near-duplicate.`,
        );
      }
    }
    return this.prisma.chargeLineDefinition.update({
      where: { id },
      data: { ...input, ...auditUpdate(user) },
    });
  }

  async remove(id: string) {
    const inUse = await this.prisma.legChargeLineSelection.count({ where: { definitionId: id } });
    if (inUse > 0) {
      throw new ConflictException(
        `This charge line is in use on ${inUse} leg${inUse === 1 ? "" : "s"} and cannot be deleted. Deactivate it instead.`,
      );
    }
    return this.prisma.chargeLineDefinition.delete({ where: { id } });
  }
}
