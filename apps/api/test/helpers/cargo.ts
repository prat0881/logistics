import type { PrismaService } from "../../src/prisma/prisma.service";
import type { DimUnit, PackageType, ReferenceTag, UnitOfMeasure, WeightUnit } from "@svyft/shared";

// Task 19 (Unit 5, FF Portal v2 ripple): the legacy Stage-4 e2e specs build cargo through the
// DROPPED flat CargoItem/LegCargo model. Every spec that touches cargo now has to build the real
// Cargo -> Package -> Item + LegPackage graph instead — the shape `rfq-manifest.e2e-spec.ts`,
// `ff-portal-grain.e2e-spec.ts` and `tag-two-gate.e2e-spec.ts` already proved out by hand. This
// helper generalizes that graph-build so the ~25 spec rewrites (Tasks 20-23) don't each hand-roll
// it. Scope is deliberately narrow: build rows at CANONICAL units (cm/kg) directly via Prisma —
// no unit conversion, no HTTP round-trip. Specs that need non-canonical entry units should still
// go through the real `cargo`/`package`/`item` controllers.

export interface ItemSpec {
  product?: string;
  qty?: number | string;
  uom?: UnitOfMeasure;
  hsCode?: string;
  tags?: ReferenceTag[]; // default []
}

export interface PackageSpec {
  /** Unique per query (`@@unique([queryId, packageNo])`). Auto-minted ("AUTO-P-<n>") if omitted —
   *  see `mintPackageNo` for the collision-avoidance scheme. Callers supplying an explicit
   *  `packageNo` should NOT use the `AUTO-P-` prefix, to stay clear of the auto-minted namespace. */
  packageNo?: string;
  packageType?: PackageType; // default PALLET
  dimL?: number | string; // canonical cm; default 120
  dimW?: number | string; // canonical cm; default 80
  dimH?: number | string; // canonical cm; default 100
  grossWt?: number | string; // canonical kg; default 100
  netWt?: number | string; // canonical kg; omitted -> NULL
  tags?: ReferenceTag[]; // default []
  items?: ItemSpec[]; // default []
}

export interface CreatedCargo {
  cargoId: string;
  packageIds: string[]; // same order as opts.packages
  itemIds: string[]; // flattened, package order then item order
}

// Module-level: Jest gives each spec FILE a fresh module registry, so this counter resets per
// file but stays monotonic for that file's whole run — which is exactly the scope
// `@@unique([queryId, packageNo])` needs. It guarantees any two calls to
// `createCargoWithPackages` in the same file, for the same query or different ones, never mint
// the same packageNo, without callers having to track a counter themselves.
let packageNoSeq = 0;

// Auto-minted packageNos live in their own `AUTO-P-` namespace, distinct from the `V-`/`PK-`
// prefixes specs commonly use for explicit packageNos — so an explicit `packageNo` can never
// collide with an auto-minted one, even in the same query.
function mintPackageNo(): string {
  packageNoSeq += 1;
  return `AUTO-P-${packageNoSeq}`;
}

/**
 * Create one Cargo (canonical cm/kg by default) under `opts.queryId`, with its Packages and their
 * Items, at canonical units — the proven `rfq-manifest.e2e-spec.ts` shape, generalized. Returns
 * the created ids so callers can assign packages to a leg (`assignPackagesToLeg`) or read the rows
 * back to assert on them.
 *
 * Sensible defaults mean `createCargoWithPackages(prisma, { queryId, packages: [{}] })` alone
 * yields one valid PALLET package.
 */
export async function createCargoWithPackages(
  prisma: Pick<PrismaService, "cargo" | "package" | "item">,
  opts: {
    queryId: string;
    tenantId?: string | null;
    dimUnit?: DimUnit;
    weightUnit?: WeightUnit;
    rowIndex?: number;
    packages: PackageSpec[];
  },
): Promise<CreatedCargo> {
  const cargo = await prisma.cargo.create({
    data: {
      queryId: opts.queryId,
      tenantId: opts.tenantId,
      rowIndex: opts.rowIndex ?? 0,
      dimUnit: opts.dimUnit ?? "CM",
      weightUnit: opts.weightUnit ?? "KG",
    },
  });

  const packageIds: string[] = [];
  const itemIds: string[] = [];

  for (const [rowIndex, spec] of opts.packages.entries()) {
    const pkg = await prisma.package.create({
      data: {
        queryId: opts.queryId,
        tenantId: opts.tenantId,
        cargoId: cargo.id,
        rowIndex,
        packageNo: spec.packageNo ?? mintPackageNo(),
        packageType: spec.packageType ?? "PALLET",
        dimL: spec.dimL ?? 120,
        dimW: spec.dimW ?? 80,
        dimH: spec.dimH ?? 100,
        grossWt: spec.grossWt ?? 100,
        netWt: spec.netWt,
        tags: spec.tags ?? [],
      },
    });
    packageIds.push(pkg.id);

    for (const [itemRowIndex, itemSpec] of (spec.items ?? []).entries()) {
      const item = await prisma.item.create({
        data: {
          packageId: pkg.id,
          tenantId: opts.tenantId,
          rowIndex: itemRowIndex,
          product: itemSpec.product,
          qty: itemSpec.qty,
          uom: itemSpec.uom,
          hsCode: itemSpec.hsCode,
          tags: itemSpec.tags ?? [],
        },
      });
      itemIds.push(item.id);
    }
  }

  return { cargoId: cargo.id, packageIds, itemIds };
}

/** Assign packages to a leg via LegPackage rows (`@@unique([legId, packageId])`). No-op on []. */
export async function assignPackagesToLeg(
  prisma: Pick<PrismaService, "legPackage">,
  legId: string,
  packageIds: string[],
  tenantId?: string | null,
): Promise<void> {
  if (packageIds.length === 0) return;
  await prisma.legPackage.createMany({
    data: packageIds.map((packageId) => ({ legId, packageId, tenantId })),
  });
}
