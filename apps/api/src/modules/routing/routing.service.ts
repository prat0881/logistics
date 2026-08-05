// apps/api/src/modules/routing/routing.service.ts
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  effectiveTags,
  validateRoute,
  type Finding,
  type ReferenceTag,
  type RouteCargo,
  type RouteGraph,
  type RouteLeg,
  type RoutePhase,
  type RoutePoint,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class RoutingService {
  constructor(private readonly prisma: PrismaService) {}

  async buildGraph(queryId: string, client: Db = this.prisma): Promise<RouteGraph> {
    const query = await client.query.findUnique({
      where: { id: queryId },
      select: { id: true, readyDate: true, targetDelivery: true },
    });
    if (!query) throw new NotFoundException("Query not found");
    const [points, legs, packages, legPackages] = await Promise.all([
      client.point.findMany({ where: { queryId } }),
      client.leg.findMany({ where: { queryId } }),
      client.package.findMany({
        where: { queryId },
        include: { cargo: { select: { poReference: true } }, items: { select: { tags: true } } },
      }),
      client.legPackage.findMany({
        where: { package: { queryId } },
        select: { legId: true, packageId: true },
      }),
    ]);
    return {
      query: { id: query.id, readyDate: query.readyDate, targetDelivery: query.targetDelivery },
      points: points.map((p): RoutePoint => ({
        id: p.id,
        type: p.type,
        name: p.name,
        streetAddress: p.streetAddress,
        city: p.city,
        postalCode: p.postalCode,
        country: p.country,
        contactName: p.contactName,
        contactPhone: p.contactPhone,
        contactEmail: p.contactEmail,
        warehouseType: p.warehouseType,
        iataCode: p.iataCode,
        icaoCode: p.icaoCode,
        unLocode: p.unLocode,
        terminal: p.terminal,
        timezone: p.timezone,
      })),
      legs: legs.map((l): RouteLeg => ({
        id: l.id,
        legCode: l.legCode,
        mode: l.mode,
        originPointId: l.originPointId,
        destinationPointId: l.destinationPointId,
        readyDate: l.readyDate,
        targetDelivery: l.targetDelivery,
      })),
      // Grain decision (T10): one RouteCargo per Package (the atomic unit that rides legs, via
      // LegPackage) — not per Cargo header, which is just a grouping/PO-label row with no
      // dims/weight/DG-tag of its own anymore. RouteGraph.legCargo keeps its legacy shape
      // ({legId, cargoItemId}); packageId goes in the cargoItemId slot — it's an opaque id key
      // to validateRoute's rules, so no @svyft/shared change is needed for the new grain.
      cargo: packages.map((p): RouteCargo => ({
        id: p.id,
        poReference: p.cargo.poReference ?? "", // RouteCargo.poReference is `string`; cargoLabel prefers it
        productName: p.packageNo, // best per-package human label (cargoLabel fallback)
        rowIndex: p.rowIndex,
        isDangerous: effectiveTags({
          tags: p.tags as ReferenceTag[],
          items: p.items.map((i) => ({ tags: i.tags as ReferenceTag[] })),
        }).includes("DG"),
        msdsFileId: p.msdsFileId,
        grossWt: Number(p.grossWt),
        volumeCbm: p.volumeCbm === null ? null : Number(p.volumeCbm),
      })),
      legCargo: legPackages.map((lp) => ({ legId: lp.legId, cargoItemId: lp.packageId })),
    };
  }

  async validate(queryId: string, phase: RoutePhase, client: Db = this.prisma): Promise<Finding[]> {
    const graph = await this.buildGraph(queryId, client);
    return validateRoute(graph, phase);
  }

  // The legs carrying a cargo row — used by the ImpactClassifier's cargo→leg fan-out (Task 8).
  // A Cargo header has no direct leg assignment (Package does, via LegPackage), so this fans out
  // cargo → its packages → their legs, deduped (a cargo's packages may share a leg).
  async legsCarryingCargo(cargoId: string, client: Db = this.prisma): Promise<string[]> {
    const rows = await client.legPackage.findMany({
      where: { package: { cargoId } },
      select: { legId: true },
    });
    return [...new Set(rows.map((r) => r.legId))];
  }

  // The legs carrying a package — used by the ImpactClassifier's package→leg fan-out (Task 10).
  // (legId, packageId) is unique (LegPackage @@unique), so the rows are already distinct.
  async legsCarryingPackage(packageId: string, client: Db = this.prisma): Promise<string[]> {
    const rows = await client.legPackage.findMany({
      where: { packageId },
      select: { legId: true },
    });
    return rows.map((r) => r.legId);
  }

  // The legs using a point as either endpoint — ImpactClassifier's point→leg fan-out (Task 2).
  async legsUsingPoint(pointId: string, client: Db = this.prisma): Promise<string[]> {
    const rows = await client.leg.findMany({
      where: { OR: [{ originPointId: pointId }, { destinationPointId: pointId }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // All legs of a query — ImpactClassifier's query→legs fan-out for query-wide fields (Task 2).
  async legsOfQuery(queryId: string, client: Db = this.prisma): Promise<string[]> {
    const rows = await client.leg.findMany({ where: { queryId }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  // The leg a quote belongs to — ImpactClassifier's quote→leg fan-out (Task 2).
  async legOfQuote(quoteId: string, client: Db = this.prisma): Promise<string | null> {
    const q = await client.quote.findUnique({ where: { id: quoteId }, select: { legId: true } });
    return q?.legId ?? null;
  }
}
