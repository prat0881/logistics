process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ChangeMediator } from "../src/modules/changes/change-mediator";
import { ScopeResolver } from "../src/modules/changes/scope.resolver";
import { ImpactRegistry } from "../src/modules/changes/impact.registry";
import { ChangeOrderNotAvailableError } from "../src/modules/changes/errors";

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

  it("forks to CHANGE-ORDER when downstream work exists, and the stub throws without applying", async () => {
    jest.spyOn(resolver, "downstreamWork").mockResolvedValueOnce(true);
    const uow = jest.fn(async () => {});
    await expect(
      mediator.apply({ entity: "leg", id: "leg-d", field: "originPointId", actorId: null }, uow),
    ).rejects.toBeInstanceOf(ChangeOrderNotAvailableError);
    expect(uow).not.toHaveBeenCalled(); // nothing applied on the change-order path in Stage 3
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
