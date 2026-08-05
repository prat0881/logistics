import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { ItemCreateInput, ItemDto, ItemUpdateInput } from "@svyft/shared";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { QueriesService } from "../queries/queries.service";
import { shapeItem } from "./cargo-shape";

@Injectable()
export class ItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly queries: QueriesService,
  ) {}

  // Verifies the parent package exists under this exact (queryId, cargoId) scope — 404 if
  // missing. Mirrors PackageService.load's scoped-lookup contract (NOT PackageService's OWN
  // assertCargoRef, which 400s): here `:pid` is part of THIS controller's route path, one level
  // below PackageController's own `:pid` collection — a missing/mismatched package means "this
  // items collection doesn't exist," the same "row not found under this exact scope" 404
  // contract as any nested-resource lookup (e.g. PackageService.copy's pid lookup). Pre-
  // verifying this way is what keeps a bad packageId from hitting the unmapped P2003 (FK
  // violation) -> 500 on any Item write — mirrors PackageService.assertCargoRef's rationale,
  // just with a 404 instead of a 400.
  private async assertPackageRef(queryId: string, cargoId: string, packageId: string) {
    const pkg = await this.prisma.package.findFirst({ where: { id: packageId, queryId, cargoId } });
    if (!pkg) throw new NotFoundException("Package not found");
    return pkg;
  }

  // Scoped by id + packageId — an item looked up under the wrong package 404s (same
  // "row not found under this exact scope" contract as PackageService.load). Item has no
  // queryId/cargoId column of its own (see prisma/schema.prisma) — once assertPackageRef above
  // has confirmed the caller's packageId belongs to this exact query/cargo, scoping the item
  // lookup to just packageId is sufficient and correct.
  private async load(packageId: string, iid: string) {
    const row = await this.prisma.item.findFirst({ where: { id: iid, packageId } });
    if (!row) throw new NotFoundException("Item not found");
    return row;
  }

  // Mediated @create: verify the parent package (FK chain), reject an empty item (brief: an
  // item with neither product nor qty is meaningless — schema validation alone doesn't stop a
  // fully-blank `{}` body, since every itemCreateSchema field is optional and its V-4 refine
  // trivially passes when qty is absent), mint the next rowIndex (scoped to this package), and
  // shape the created row via the shared shapeItem (cargo-shape.ts) — NOT the parent package.
  async create(
    queryId: string,
    cargoId: string,
    packageId: string,
    input: ItemCreateInput,
    user: RequestUser,
  ): Promise<ItemDto> {
    await this.assertPackageRef(queryId, cargoId, packageId);

    const hasProduct = input.product != null && input.product.trim().length > 0;
    const hasQty = input.qty != null;
    if (!hasProduct && !hasQty) {
      throw new BadRequestException("An item needs at least a product or a quantity");
    }

    const id = randomUUID();
    let shaped: ItemDto | undefined;
    const result = await this.mediator.apply(
      { entity: "item", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        // KNOWN RACE (deferred, not fixed): read-then-write (MAX(rowIndex)+1) inside a READ
        // COMMITTED tx with no unique constraint on (packageId, rowIndex) — same accepted race
        // as PackageService.create (scoped to cargoId there, last-write-wins). Scoped per-
        // package: items number within their own package, independently of sibling packages.
        const max = await tx.item.aggregate({ where: { packageId }, _max: { rowIndex: true } });
        const created = await tx.item.create({
          data: {
            id,
            packageId,
            tenantId: user.tenantId,
            rowIndex: (max._max.rowIndex ?? 0) + 1,
            product: input.product ?? null,
            qty: input.qty ?? null,
            uom: input.uom ?? null,
            hsCode: input.hsCode ?? null,
            tags: input.tags ?? [],
          },
        });
        shaped = shapeItem(created);
        // A brand-new item can carry a DG tag straight from @create — re-sync inside this same
        // tx (Task 8). `queryId` is already a method param here (threaded from the route), so
        // this needs no extra DB round-trip to derive it.
        await this.queries.syncDgIndicator(queryId, tx);
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

  // Mediated field edit. Unlike PackageService.update, there is no `reason` to strip (Item has
  // no such field in itemUpdateSchema / no ChangeRequest metadata to separate out) and no unit
  // conversion (qty has no per-item unit the way Package's dims/weights convert against the
  // cargo's entry unit) — `input` doubles directly as both the mediator's `patch` and (spread
  // into `data` below) the Prisma update payload.
  //
  // Carry-forward fix (Task 7 §A2, merge-then-validate): itemUpdateSchema has NO cross-field
  // refine (packages/shared/src/cargo.ts) — a partial patch structurally can't see the item's
  // STORED uom, so V-4 (qty ⇒ uom) is enforced here instead: merge patched-or-stored qty/uom
  // and validate the EFFECTIVE pair. `!=`/`==` null (loose) is intentional — treats both `null`
  // and `undefined` as "absent" alike, and a Prisma Decimal (existing.qty) as "present" either
  // way. This is the same merge-then-validate shape as PackageService.update's V-2 fix (§A1);
  // the asymmetry (item's schema refine removed entirely, package's schema refine kept) is
  // deliberate — package's refine never false-rejects a single-sided patch (it only rejects a
  // both-fields-present violation), item's DID (see the itemUpdateSchema comment in
  // packages/shared/src/cargo.ts).
  async update(
    queryId: string,
    cargoId: string,
    packageId: string,
    iid: string,
    input: ItemUpdateInput,
    user: RequestUser,
  ): Promise<ItemDto> {
    await this.assertPackageRef(queryId, cargoId, packageId);
    const existing = await this.load(packageId, iid);

    const fields = Object.keys(input);
    if (fields.length === 0) return shapeItem(existing);

    const effQty = input.qty !== undefined ? input.qty : existing.qty;
    const effUom = input.uom !== undefined ? input.uom : existing.uom;
    if (effQty != null && effUom == null) {
      throw new BadRequestException("Unit of measure is required when a quantity is entered");
    }

    const data: Record<string, unknown> = { ...input };

    let shaped: ItemDto | undefined;
    const result = await this.mediator.apply(
      {
        entity: "item",
        id: iid,
        field: this.impacts.highestImpactField("item", fields),
        patch: input,
        queryId,
        actorId: user.userId,
      },
      async (tx) => {
        const updated = await tx.item.update({
          where: { id: iid },
          data: data as Prisma.ItemUncheckedUpdateInput,
        });
        shaped = shapeItem(updated);
        // A field edit can add (or already carry) a DG tag — re-sync (Task 8).
        await this.queries.syncDgIndicator(queryId, tx);
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

  // Mediated @delete. No cascade cleanup needed — Item is the leaf of the Cargo->Package->Item
  // tree.
  async remove(
    queryId: string,
    cargoId: string,
    packageId: string,
    iid: string,
    user: RequestUser,
  ): Promise<void> {
    await this.assertPackageRef(queryId, cargoId, packageId);
    await this.load(packageId, iid);
    const result = await this.mediator.apply(
      { entity: "item", id: iid, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.item.delete({ where: { id: iid } });
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
}
