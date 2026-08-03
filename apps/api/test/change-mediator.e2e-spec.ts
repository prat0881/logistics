process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ChangeMediator } from "../src/modules/changes/change-mediator";
import { ScopeResolver } from "../src/modules/changes/scope.resolver";
import { ImpactRegistry } from "../src/modules/changes/impact.registry";

const PFX = "p8-change-mediator-";

describe("Change Mediator (integration)", () => {
  let app: INestApplication;
  let mediator: ChangeMediator;
  let resolver: ScopeResolver;
  let registry: ImpactRegistry;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    mediator = moduleRef.get(ChangeMediator);
    resolver = moduleRef.get(ScopeResolver);
    registry = moduleRef.get(ImpactRegistry);
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } }); // cascades cargo/leg/legCargo
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks(); // each test starts with the real ScopeResolver (returns false)
  });

  it("declares the leg impact classes at startup (§7.3)", () => {
    expect(registry.classOf("leg", "originPointId")).toBe("RfqDefining");
    expect(registry.classOf("leg", "legName")).toBe("Corrective");
    expect(registry.classOf("leg", "@create")).toBe("Structural");
  });

  it("routes an RfqDefining leg edit down the FREE path (no downstream work), running the uow", async () => {
    const applied: string[] = [];
    const res = await mediator.apply(
      { entity: "leg", id: "leg-a", field: "originPointId", queryId: "q-1", actorId: null },
      async () => {
        applied.push("applied");
      },
    );
    expect(res.path).toBe("free");
    expect(res.class).toBe("RfqDefining");
    expect(res.scope).toEqual([{ type: "leg", id: "leg-a" }]);
    // Real RoutingRouteValidator now runs, but "q-1" is a synthetic pre-Prisma test id (not a
    // real query row) — resilient revalidate() short-circuits to [] without hitting validateRoute.
    expect(res.findings).toEqual([]);
    expect(applied).toEqual(["applied"]);
  });

  it("routes a Structural @create down the FREE path pre-RFQ", async () => {
    const res = await mediator.apply(
      { entity: "leg", id: "leg-b", action: "@create", actorId: null },
      async () => {},
    );
    expect(res.class).toBe("Structural");
    expect(res.path).toBe("free");
  });

  it("keeps a Corrective edit on the FREE path even WITH downstream work (§7.5)", async () => {
    jest.spyOn(resolver, "downstreamWork").mockResolvedValueOnce(true);
    const res = await mediator.apply(
      { entity: "leg", id: "leg-c", field: "legName", actorId: null },
      async () => {},
    );
    expect(res.path).toBe("free");
  });

  it("forks to CHANGE-ORDER when downstream work exists, returning a preview without applying (Task 7)", async () => {
    jest.spyOn(resolver, "downstreamWork").mockResolvedValueOnce(true);
    const uow = jest.fn(async () => {});
    // Valid-UUID-shaped synthetic id — Quote.legId is `@db.Uuid`, and ChangeOrderStrategy
    // (Task 7) now queries Prisma for real, so a non-UUID id like the old "leg-d" would
    // fail the cast. No Leg/Quote row exists for this id, so the preview is empty — including
    // `affectedLegs`, which (Task 8, minimal blast radius §11.3) is the legs that ACTUALLY carry
    // a live quote, NOT the raw classifier fan. downstreamWork is mocked here, so the fork fires
    // with zero real quotes → affectedLegs is empty.
    const legId = "00000000-0000-4000-8000-000000000001";
    const res = await mediator.apply(
      { entity: "leg", id: legId, field: "originPointId", actorId: null },
      uow,
    );
    expect(res.path).toBe("change-order");
    expect(res.needsConfirmation).toBe(true);
    expect(res.preview).toEqual({
      affectedLegs: [],
      invalidatingQuotes: [],
      refreshingQuotes: [],
      impactClass: "RfqDefining",
    });
    expect(uow).not.toHaveBeenCalled(); // no reason ⇒ preview only, nothing applied (Task 7)
  });

  // Real Query + CargoItem, self-cleaned via shipmentDescription's PFX (see afterAll).
  async function createCargoRow(suffix: string) {
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}-${suffix}`, shipmentDescription: `${PFX}q` },
    });
    const cargo = await prisma.cargoItem.create({
      data: {
        queryId: q.id,
        rowIndex: 1,
        poReference: `PO-${suffix}`,
        productName: "Widget",
        packageType: "Box",
        qty: 1,
        dimL: 10,
        dimW: 10,
        dimH: 10,
        grossWt: 100,
      },
    });
    return { queryId: q.id, cargoId: cargo.id };
  }

  it("fans a cargo edit's scope out to the legs carrying it via LegCargo (Task 8)", async () => {
    const { queryId, cargoId } = await createCargoRow("fanout");
    const legA = await prisma.leg.create({ data: { queryId, legCode: "LA" } });
    const legB = await prisma.leg.create({ data: { queryId, legCode: "LB" } });
    await prisma.legCargo.create({ data: { legId: legA.id, cargoItemId: cargoId } });
    await prisma.legCargo.create({ data: { legId: legB.id, cargoItemId: cargoId } });

    const res = await mediator.apply(
      { entity: "cargo", id: cargoId, field: "grossWt", patch: { grossWt: 200 }, queryId },
      async (tx) => {
        await tx.cargoItem.update({ where: { id: cargoId }, data: { grossWt: 200 } });
      },
    );

    const legIdSet = new Set(res.scope.map((s: { type: string; id?: string }) => s.id));
    expect(res.scope.every((s: { type: string }) => s.type === "leg")).toBe(true);
    expect(legIdSet).toEqual(new Set([legA.id, legB.id]));
  });

  it("keeps a cargo edit self-scoped when the cargo isn't assigned to any leg (Task 8)", async () => {
    const { queryId, cargoId } = await createCargoRow("unassigned");

    const res = await mediator.apply(
      { entity: "cargo", id: cargoId, field: "grossWt", patch: { grossWt: 200 }, queryId },
      async (tx) => {
        await tx.cargoItem.update({ where: { id: cargoId }, data: { grossWt: 200 } });
      },
    );

    expect(res.scope).toEqual([{ type: "cargo", id: cargoId }]);
  });
});
