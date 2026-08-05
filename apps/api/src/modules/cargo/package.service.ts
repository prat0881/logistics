import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Item, Prisma } from "@prisma/client";
import {
  toCanonicalDim,
  toCanonicalWeight,
  type PackageCreateInput,
  type PackageDto,
  type PackageUpdateInput,
} from "@svyft/shared";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { FilesService, type MsdsUpload } from "../files/files.service";
import { shapePackage } from "./cargo-shape";

const ITEM_ORDER: Prisma.ItemOrderByWithRelationInput[] = [
  { rowIndex: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];

@Injectable()
export class PackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly files: FilesService,
  ) {}

  // Verifies the parent cargo exists *and* belongs to this query. Bad ref -> BadRequestException
  // (400), not NotFoundException: P2003 (FK violation) is unmapped by PrismaExceptionFilter (falls
  // through to a 500), so the referenced cargo MUST be pre-validated before any Package write is
  // attempted against it — mirrors LegsService.assertPointRef/assertCargoRefs.
  private async assertCargoRef(queryId: string, cargoId: string) {
    const cargo = await this.prisma.cargo.findFirst({ where: { id: cargoId, queryId } });
    if (!cargo) throw new BadRequestException(`Cargo ${cargoId} does not belong to this query`);
    return cargo;
  }

  // Scoped by all three: id + queryId + cargoId — a package looked up under the wrong cargo (or
  // wrong query) 404s, same "row not found under this exact scope" contract as CargoService.load.
  private async load(queryId: string, cargoId: string, pid: string) {
    const row = await this.prisma.package.findFirst({ where: { id: pid, queryId, cargoId } });
    if (!row) throw new NotFoundException("Package not found");
    return row;
  }

  private async getOne(queryId: string, cargoId: string, pid: string): Promise<PackageDto> {
    const row = await this.prisma.package.findFirst({
      where: { id: pid, queryId, cargoId },
      include: { items: { orderBy: ITEM_ORDER } },
    });
    if (!row) throw new NotFoundException("Package not found");
    return shapePackage(row);
  }

  // V-5 predicate: TRUE iff `packageNo` (trimmed) is already used by another package in this
  // query, case-insensitively. Belt-and-suspenders over the DB @@unique([queryId, packageNo])
  // index, which is case-SENSITIVE (so "P-1" and "p-1" would otherwise both persist). `packageNo`
  // is always trimmed on the way in (packageCreateSchema/packageUpdateSchema both `.trim()`), so
  // DB-stored values are already trimmed — only the caller-supplied needle is re-trimmed here
  // defensively. `excludeId` lets update() skip a package's own row when the caller "renames" it
  // to a value that only differs by case/space. Extracted from assertPackageNoFree (was inline
  // until Task 6) so copy()'s next-free-suffix search can probe candidates as a boolean check
  // instead of relying on exception-driven control flow — same query, same semantics.
  private async packageNoTaken(queryId: string, packageNo: string, excludeId?: string): Promise<boolean> {
    const needle = packageNo.trim();
    const dupe = await this.prisma.package.findFirst({
      where: {
        queryId,
        packageNo: { equals: needle, mode: "insensitive" },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    return dupe !== null;
  }

  private async assertPackageNoFree(queryId: string, packageNo: string, excludeId?: string): Promise<void> {
    if (await this.packageNoTaken(queryId, packageNo, excludeId)) {
      throw new ConflictException(`packageNo "${packageNo.trim()}" is already in use within this query`);
    }
  }

  // Mediated @create: verify the parent cargo, enforce V-5, mint the next rowIndex (scoped to
  // this cargo), convert entry-unit dims/weights to canonical cm/kg using the CARGO's
  // dimUnit/weightUnit, insert, shape (items always [] for a brand-new package). volumeCbm is a
  // DB-GENERATED STORED column (see migration 20260805000000_cargo_packing_list) — it is never
  // written here; Postgres computes it from dimL*dimW*dimH and Prisma reads it back via RETURNING.
  async create(
    queryId: string,
    cargoId: string,
    input: PackageCreateInput,
    user: RequestUser,
  ): Promise<PackageDto> {
    const cargo = await this.assertCargoRef(queryId, cargoId);
    await this.assertPackageNoFree(queryId, input.packageNo);

    const id = randomUUID();
    let shaped: PackageDto | undefined;
    const result = await this.mediator.apply(
      { entity: "package", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        // KNOWN RACE (deferred, not fixed): read-then-write (MAX(rowIndex)+1) inside a READ
        // COMMITTED tx with no unique constraint on (cargoId, rowIndex) — same accepted race as
        // CargoService.create (§8.5, last-write-wins). Scoped per-cargo: packages number within
        // their own cargo, independently of sibling cargos in the same query.
        const max = await tx.package.aggregate({ where: { cargoId }, _max: { rowIndex: true } });
        const created = await tx.package.create({
          data: {
            id,
            queryId,
            cargoId,
            tenantId: user.tenantId,
            rowIndex: (max._max.rowIndex ?? 0) + 1,
            packageNo: input.packageNo,
            packageType: input.packageType,
            dimL: toCanonicalDim(input.dimL, cargo.dimUnit),
            dimW: toCanonicalDim(input.dimW, cargo.dimUnit),
            dimH: toCanonicalDim(input.dimH, cargo.dimUnit),
            grossWt: toCanonicalWeight(input.grossWt, cargo.weightUnit),
            netWt: input.netWt === undefined ? null : toCanonicalWeight(input.netWt, cargo.weightUnit),
            tags: input.tags ?? [],
          },
        });
        shaped = shapePackage({ ...created, items: [] });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
    return shaped!;
  }

  // Task 6 "add N copies": clone a saved package `count` times (2..50), each a full deep copy
  // (own row + own copied items). Looked up by (id, queryId) ONLY — no cargoId param, matching
  // the brief's `copy(queryId, pid, count, user)` signature; Package.cargoId lives on the row
  // itself, so once the row is found under this query there is nothing further to scope against.
  // Bad ref (no such package in this query) -> 404 "Package not found", the same contract as
  // load()/getOne() above (NOT create()'s 400 CargoRef path — that validates a caller-SUPPLIED
  // cargoId against the query, and copy() never receives one).
  //
  // TRANSACTION BOUNDARY: each clone is mediated as its own @create — mirrors create() above
  // exactly, including letting ChangeMediator.apply open its OWN prisma.$transaction per call.
  // This is NOT one atomic DB transaction spanning the whole batch: FreePathStrategy always calls
  // `this.prisma.$transaction` itself (free-path.strategy.ts), and Prisma's TransactionClient type
  // deliberately excludes `$transaction` (no supported nesting) — composing N mediator.apply calls
  // into one atomic transaction would require either threading an external tx through the mediator
  // (shared-infra surgery, out of this task's "copy endpoint only" scope) or bypassing the mediator
  // and re-implementing FreePathStrategy's revalidate/changeLog logic inline here (which would
  // contradict "mediate each clone via ChangeMediator.apply"). This is the same accepted tradeoff
  // already standing at queries.service.ts's createQuery(), which fires each DRAFT leg forward in
  // its own tx ("own tx per fire ... last-write-wins", §8.5) rather than one all-or-nothing tx.
  // In practice `package` `@create` is unconditionally free-path in Stage 3 — Structural class,
  // but ImpactClassifier has no leg fan-out rule for entity "package" (falls to the self-scope
  // default), so ScopeResolver.downstreamWork always sees zero leg-typed scope entries and returns
  // false without a DB call — so every clone commits immediately, one at a time, never
  // concurrently, each one fully committed before the next clone's packageNo/rowIndex are
  // computed. Clones therefore cannot collide with each other or with pre-existing rows; a
  // mid-batch failure (rare — e.g. a genuine DB error) can leave a partial prefix of clones
  // committed, exactly like the leg-fire loop's accepted last-write-wins tradeoff.
  async copy(queryId: string, pid: string, count: number, user: RequestUser): Promise<PackageDto[]> {
    const source = await this.prisma.package.findFirst({
      where: { id: pid, queryId },
      include: { items: { orderBy: ITEM_ORDER } },
    });
    if (!source) throw new NotFoundException("Package not found");

    // Monotonically increasing across the WHOLE batch (not reset per clone) so the Nth clone's
    // search resumes where the (N-1)th left off instead of re-probing already-known-taken
    // suffixes from scratch — O(count + collisions) DB round-trips, not O(count²).
    let suffix = 2;
    const nextPackageNo = async (): Promise<string> => {
      for (let tries = 0; tries < 10_000; tries++) {
        const candidate = `${source.packageNo}-${suffix++}`;
        if (!(await this.packageNoTaken(queryId, candidate))) return candidate;
      }
      throw new ConflictException(`Could not find a free packageNo for "${source.packageNo}"`);
    };

    const clones: PackageDto[] = [];
    for (let i = 0; i < count; i++) {
      const packageNo = await nextPackageNo();
      const id = randomUUID();
      let shaped: PackageDto | undefined;
      const result = await this.mediator.apply(
        { entity: "package", id, action: "@create", queryId, actorId: user.userId },
        async (tx) => {
          // Same KNOWN RACE as create() above (§8.5, last-write-wins) — accepted, not fixed here.
          const max = await tx.package.aggregate({
            where: { cargoId: source.cargoId },
            _max: { rowIndex: true },
          });
          const created = await tx.package.create({
            data: {
              id,
              queryId,
              cargoId: source.cargoId,
              tenantId: user.tenantId,
              rowIndex: (max._max.rowIndex ?? 0) + 1,
              packageNo,
              // Stored canonical values, copied as-is — already cm/kg, never re-converted.
              packageType: source.packageType,
              dimL: source.dimL,
              dimW: source.dimW,
              dimH: source.dimH,
              grossWt: source.grossWt,
              netWt: source.netWt,
              tags: source.tags,
              msdsFileId: source.msdsFileId,
              packageCount: source.packageCount,
              // dgIndicator (T8) intentionally untouched — Package has no such column; Query's
              // sync lives entirely in QueriesService and is out of this task's scope.
            },
          });
          const items: Item[] = [];
          for (const [idx, item] of source.items.entries()) {
            items.push(
              await tx.item.create({
                data: {
                  id: randomUUID(),
                  packageId: created.id,
                  tenantId: user.tenantId,
                  rowIndex: idx + 1,
                  product: item.product,
                  qty: item.qty,
                  uom: item.uom,
                  hsCode: item.hsCode,
                  tags: item.tags,
                },
              }),
            );
          }
          shaped = shapePackage({ ...created, items });
        },
      );
      if (result.needsConfirmation) {
        throw new ConflictException({
          message: "Change requires confirmation",
          needsChangeOrder: true,
          preview: result.preview,
        });
      }
      clones.push(shaped!);
    }
    return clones;
  }

  // Mediated field edit. `reason` is ChangeRequest metadata, not a Package column — stripped
  // before it can reach `fields`/highestImpactField or the Prisma patch (SB6 §7.2), same pattern
  // as LegsService.update/the pre-re-model CargoService.update. Any of dimL/dimW/dimH/grossWt/
  // netWt present in the patch arrive in the CARGO's entry unit and are re-converted to
  // canonical here too (not just on create) — the ChangeRequest's `patch` still carries the raw
  // entry-unit values the caller submitted (audit trail); only the Prisma `data` write is
  // canonical.
  async update(
    queryId: string,
    cargoId: string,
    pid: string,
    input: PackageUpdateInput,
    user: RequestUser,
  ): Promise<PackageDto> {
    await this.load(queryId, cargoId, pid);
    const { reason, ...patch } = input;
    const fields = Object.keys(patch);
    if (fields.length === 0) return this.getOne(queryId, cargoId, pid);

    if (patch.packageNo !== undefined) await this.assertPackageNoFree(queryId, patch.packageNo, pid);

    const needsUnitConversion =
      patch.dimL !== undefined ||
      patch.dimW !== undefined ||
      patch.dimH !== undefined ||
      patch.grossWt !== undefined ||
      patch.netWt !== undefined;
    // cargoId is guaranteed to reference a real Cargo row here: `load` above already confirmed
    // this exact package belongs to it, and Package.cargoId is an onDelete:Cascade FK.
    const cargo = needsUnitConversion
      ? await this.prisma.cargo.findUniqueOrThrow({ where: { id: cargoId } })
      : null;

    const data: Record<string, unknown> = { ...patch };
    if (cargo) {
      if (patch.dimL !== undefined) data.dimL = toCanonicalDim(patch.dimL, cargo.dimUnit);
      if (patch.dimW !== undefined) data.dimW = toCanonicalDim(patch.dimW, cargo.dimUnit);
      if (patch.dimH !== undefined) data.dimH = toCanonicalDim(patch.dimH, cargo.dimUnit);
      if (patch.grossWt !== undefined) data.grossWt = toCanonicalWeight(patch.grossWt, cargo.weightUnit);
      if (patch.netWt !== undefined)
        data.netWt = patch.netWt === null ? null : toCanonicalWeight(patch.netWt, cargo.weightUnit);
    }

    let shaped: PackageDto | undefined;
    const result = await this.mediator.apply(
      {
        entity: "package",
        id: pid,
        field: this.impacts.highestImpactField("package", fields),
        patch,
        queryId,
        actorId: user.userId,
        reason,
      },
      async (tx) => {
        const updated = await tx.package.update({
          where: { id: pid },
          data: data as Prisma.PackageUncheckedUpdateInput,
        });
        const items = await tx.item.findMany({ where: { packageId: pid }, orderBy: ITEM_ORDER });
        shaped = shapePackage({ ...updated, items });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
    return shaped!;
  }

  // Mediated @delete. Item cascades via the schema's onDelete: Cascade (Package -> Item), so no
  // extra cleanup is needed here.
  async remove(queryId: string, cargoId: string, pid: string, user: RequestUser): Promise<void> {
    await this.load(queryId, cargoId, pid);
    const result = await this.mediator.apply(
      { entity: "package", id: pid, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.package.delete({ where: { id: pid } });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
  }

  // Store the PDF + FileAsset, then link package.msdsFileId through the mediator (Corrective).
  // ORDERING IS LOAD-BEARING: `load` (id+queryId+cargoId scoped findFirst) MUST run before
  // `storeMsds` — it verifies the package row exists under this exact query/cargo, so a
  // malformed/mismatched id 404s here rather than storeMsds ever writing a FileAsset (or
  // interpolating an attacker-controlled queryId into the storage path) for a row that isn't
  // there. Mirrors the pre-re-model CargoService.attachMsds.
  async attachMsds(
    queryId: string,
    cargoId: string,
    pid: string,
    file: MsdsUpload | undefined,
    user: RequestUser,
  ): Promise<PackageDto> {
    await this.load(queryId, cargoId, pid);
    const asset = await this.files.storeMsds(queryId, file, user.userId); // 400s a non-PDF/no-file
    let shaped: PackageDto | undefined;
    const result = await this.mediator.apply(
      {
        entity: "package",
        id: pid,
        field: "msdsFileId",
        patch: { msdsFileId: asset.id },
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        const updated = await tx.package.update({ where: { id: pid }, data: { msdsFileId: asset.id } });
        const items = await tx.item.findMany({ where: { packageId: pid }, orderBy: ITEM_ORDER });
        shaped = shapePackage({ ...updated, items });
      },
    );
    if (result.needsConfirmation) {
      throw new ConflictException({
        message: "Change requires confirmation",
        needsChangeOrder: true,
        preview: result.preview,
      });
    }
    return shaped!;
  }
}
