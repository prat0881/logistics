// apps/api/src/modules/routing/routing.service.ts
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  validateRoute,
  type Finding,
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
    const [points, legs, cargo, legCargo] = await Promise.all([
      client.point.findMany({ where: { queryId } }),
      client.leg.findMany({ where: { queryId } }),
      client.cargoItem.findMany({
        where: { queryId },
        select: { id: true, poReference: true, productName: true, rowIndex: true, isDangerous: true, msdsFileId: true, grossWt: true, volumeCbm: true },
      }),
      client.legCargo.findMany({ where: { leg: { queryId } }, select: { legId: true, cargoItemId: true } }),
    ]);
    return {
      query: { id: query.id, readyDate: query.readyDate, targetDelivery: query.targetDelivery },
      points: points.map(
        (p): RoutePoint => ({
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
        }),
      ),
      legs: legs.map(
        (l): RouteLeg => ({
          id: l.id,
          legCode: l.legCode,
          mode: l.mode,
          originPointId: l.originPointId,
          destinationPointId: l.destinationPointId,
          readyDate: l.readyDate,
          targetDelivery: l.targetDelivery,
        }),
      ),
      cargo: cargo.map(
        (c): RouteCargo => ({
          id: c.id,
          poReference: c.poReference,
          productName: c.productName,
          rowIndex: c.rowIndex,
          isDangerous: c.isDangerous,
          msdsFileId: c.msdsFileId,
          grossWt: c.grossWt == null ? null : Number(c.grossWt),
          volumeCbm: c.volumeCbm == null ? null : Number(c.volumeCbm),
        }),
      ),
      legCargo,
    };
  }

  async validate(queryId: string, phase: RoutePhase, client: Db = this.prisma): Promise<Finding[]> {
    const graph = await this.buildGraph(queryId, client);
    return validateRoute(graph, phase);
  }

  // The legs carrying a cargo row — used by the ImpactClassifier's cargo→leg fan-out (Task 8).
  async legsCarryingCargo(cargoId: string, client: Db = this.prisma): Promise<string[]> {
    const rows = await client.legCargo.findMany({ where: { cargoItemId: cargoId }, select: { legId: true } });
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
