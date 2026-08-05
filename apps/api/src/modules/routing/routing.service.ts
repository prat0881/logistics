// apps/api/src/modules/routing/routing.service.ts
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  validateRoute,
  type Finding,
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
    const [points, legs] = await Promise.all([
      client.point.findMany({ where: { queryId } }),
      client.leg.findMany({ where: { queryId } }),
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
      // STOPGAP (Cargo/Package/Item re-model, commit 0768b2d): CargoItem/LegCargo no longer
      // exist as Prisma delegates, so they can't be queried here anymore. Route validation's
      // cargo-level rules (R1/R2/R3/R4/R6/R9/C2/C3/T1 in validateRoute, which read RouteCargo +
      // legCargo) go quiet — not wrong, just uninformative — until a dedicated task re-derives
      // them from Package/LegPackage (Package now carries the dims/weight/DG-tag/MSDS that used
      // to live on CargoItem; LegPackage is the new leg-assignment join). Empty arrays are the
      // faithful "no CargoItem/LegCargo rows exist anymore" state, not a guess at that new
      // fan-out — deciding it (e.g. one RouteCargo per Package? per Cargo header, unioning its
      // packages?) is that task's call, not this one's. This is the minimal change needed to
      // stop buildGraph from throwing (previously: `client.cargoItem`/`client.legCargo` are
      // `undefined` post-migration, so `.findMany` threw a TypeError on every call, which broke
      // EVERY mediated write in the app — FreePathStrategy.run calls revalidate()->buildGraph()
      // unconditionally, not just for cargo edits). Leg/point-level rules (R5, R7, R8, C1, V-M1,
      // T3) are unaffected — they never read graph.cargo/legCargo.
      cargo: [],
      legCargo: [],
    };
  }

  async validate(queryId: string, phase: RoutePhase, client: Db = this.prisma): Promise<Finding[]> {
    const graph = await this.buildGraph(queryId, client);
    return validateRoute(graph, phase);
  }

  // The legs carrying a cargo row — used by the ImpactClassifier's cargo→leg fan-out (Task 8).
  // STOPGAP (Cargo/Package/Item re-model, commit 0768b2d): LegCargo is gone — a Cargo header has
  // no direct leg assignment anymore (Package does, via the new LegPackage join; re-deriving this
  // fan-out through Package is a dedicated later task's call, not this one's — see buildGraph
  // above for the full rationale). [] is the faithful "no LegCargo rows exist anymore" state and
  // keeps this from throwing (client.legCargo is not a Prisma delegate post-migration).
  // ImpactClassifier's own `default: legIds = []` branch already treats an empty result as
  // ordinary self-scope (pre-RFQ / unassigned), so this is "cargo always self-scopes until
  // package-leg assignment exists" — not a new behavior, just an early version of it.
  async legsCarryingCargo(_cargoId: string, _client: Db = this.prisma): Promise<string[]> {
    return [];
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
