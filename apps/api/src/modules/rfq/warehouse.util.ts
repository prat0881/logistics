import type { PrismaService } from "../../prisma/prisma.service";

/** The warehouse point ids a leg touches (origin/destination of PointType WAREHOUSE). */
export function warehousePointIds(
  endpoints: ({ id: string; type: string } | null | undefined)[],
): string[] {
  return endpoints
    .filter((p): p is { id: string; type: string } => !!p && p.type === "WAREHOUSE")
    .map((p) => p.id);
}

/** Another leg in the same query that already carries Yes for one of these warehouses; else null. */
export async function findWarehouseYesConflict(
  prisma: Pick<PrismaService, "leg">,
  args: { queryId: string; legId: string; warehousePointIds: string[] },
): Promise<string | null> {
  if (args.warehousePointIds.length === 0) return null;
  const sibling = await prisma.leg.findFirst({
    where: {
      queryId: args.queryId,
      id: { not: args.legId },
      warehouseHandlingIncluded: true,
      OR: [
        { originPointId: { in: args.warehousePointIds } },
        { destinationPointId: { in: args.warehousePointIds } },
      ],
    },
    select: { id: true },
  });
  return sibling?.id ?? null;
}
