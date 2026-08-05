// apps/api/src/modules/cargo/cargo-shape.ts
//
// Pure shaping functions (Prisma row(s) -> DTO) for the Cargo -> Package -> Item tree. Kept as
// standalone functions (not private CargoService methods) so Package/Item services (Tasks 5/7)
// can shape their own create/update responses without depending on CargoService.
import type { Cargo, Item, Package } from "@prisma/client";
import { effectiveTags, type CargoDto, type ItemDto, type PackageDto, type ReferenceTag } from "@svyft/shared";

export type ItemRow = Item;
export type PackageRow = Package & { items: ItemRow[] };
export type CargoRow = Cargo & { packages: PackageRow[] };

// A straight field-for-field mapping — Item has no derived fields of its own (effectiveTags is a
// PACKAGE-level roll-up, computed in shapePackage below). Task 7 owns any further refinement.
// `as ReferenceTag[]`: consistent with shapePackage's identical cast below (T4-review) — Prisma's
// generated Item.tags type and @svyft/shared's ReferenceTag are structurally identical string
// unions but nominally distinct types, so both call sites assert the same way rather than one
// relying on structural inference to happen to line up.
export function shapeItem(item: ItemRow): ItemDto {
  return {
    id: item.id,
    rowIndex: item.rowIndex,
    product: item.product,
    qty: item.qty === null ? null : item.qty.toString(),
    uom: item.uom,
    hsCode: item.hsCode,
    tags: item.tags as ReferenceTag[],
  };
}

// Base fields, nested items, and effectiveTags (implemented in @svyft/shared). Dims/weights
// (dimL/dimW/dimH/grossWt/netWt) are returned RAW canonical cm/kg, by design (Task 5, per the
// task-5 brief) — NOT converted to the parent Cargo's display unit here. The DTO stays canonical
// end-to-end; whichever layer renders for a human (web) converts for display using the owning
// Cargo's dimUnit/weightUnit, same as PackageService converts entry-unit input INTO canonical on
// the way in (see package.service.ts create/update).
export function shapePackage(pkg: PackageRow): PackageDto {
  const items = pkg.items.map(shapeItem);
  return {
    id: pkg.id,
    rowIndex: pkg.rowIndex,
    packageNo: pkg.packageNo,
    packageType: pkg.packageType,
    dimL: pkg.dimL.toString(),
    dimW: pkg.dimW.toString(),
    dimH: pkg.dimH.toString(),
    grossWt: pkg.grossWt.toString(),
    netWt: pkg.netWt === null ? null : pkg.netWt.toString(),
    volumeCbm: pkg.volumeCbm === null ? null : pkg.volumeCbm.toString(),
    tags: pkg.tags as ReferenceTag[],
    effectiveTags: effectiveTags({ tags: pkg.tags as ReferenceTag[], items }),
    msdsFileId: pkg.msdsFileId,
    items,
  };
}

// H4-H8 derived header (Task 4, spec §7.3): packageCount/grossWeightKg/volumeCbm/tags roll up
// over this cargo's shaped packages; none of it is stored. chargeableWeight (H7) stays null at
// Stage 3 — no rate card yet to compute it against (Stage 4+ territory).
export function shapeCargo(cargo: CargoRow): CargoDto {
  const packages = cargo.packages.map(shapePackage);
  const tags: ReferenceTag[] = [];
  for (const p of packages) for (const t of p.effectiveTags) if (!tags.includes(t)) tags.push(t);
  return {
    id: cargo.id,
    rowIndex: cargo.rowIndex,
    poReference: cargo.poReference,
    label: cargo.label,
    dimUnit: cargo.dimUnit,
    weightUnit: cargo.weightUnit,
    packages,
    packageCount: packages.length,
    grossWeightKg: packages.reduce((s, p) => s + Number(p.grossWt), 0).toFixed(3),
    volumeCbm: packages.reduce((s, p) => s + Number(p.volumeCbm ?? 0), 0).toFixed(6),
    tags,
    chargeableWeight: null,
  };
}
