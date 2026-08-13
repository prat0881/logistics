process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ChangeMediator } from "../src/modules/changes/change-mediator";
import { ScopeResolver } from "../src/modules/changes/scope.resolver";
import { ImpactRegistry } from "../src/modules/changes/impact.registry";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

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
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } }); // cascades legs/legPackages/cargo/packages/items
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

  // Cargo→Package re-model: Package (not Cargo) now carries the dims/weights an FF quotes
  // against, so the package-grain impact map is what gates the change-order fork — pin its
  // declaration at startup the same way the leg one above is pinned.
  it("declares the package impact classes at startup (restored package-grain gating)", () => {
    expect(registry.classOf("package", "grossWt")).toBe("RfqDefining");
    expect(registry.classOf("package", "packageNo")).toBe("Corrective");
    expect(registry.classOf("package", "@create")).toBe("Structural");
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

  // Real Query + Cargo + Package (v2 grain, via the shared helper), self-cleaned via
  // shipmentDescription's PFX (see afterAll).
  async function createCargoRow(suffix: string) {
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}-${suffix}`, shipmentDescription: `${PFX}q` },
    });
    const { cargoId, packageIds } = await createCargoWithPackages(prisma, {
      queryId: q.id,
      packages: [{ packageNo: `PK-${suffix}`, grossWt: 100 }],
    });
    return { queryId: q.id, cargoId, packageId: packageIds[0] };
  }

  it("fans a cargo edit's scope out to the legs carrying its packages via LegPackage (Task 8)", async () => {
    const { queryId, cargoId, packageId } = await createCargoRow("fanout");
    const legA = await prisma.leg.create({ data: { queryId, legCode: "LA" } });
    const legB = await prisma.leg.create({ data: { queryId, legCode: "LB" } });
    await assignPackagesToLeg(prisma, legA.id, [packageId]);
    await assignPackagesToLeg(prisma, legB.id, [packageId]);

    const res = await mediator.apply(
      {
        entity: "cargo",
        id: cargoId,
        field: "poReference",
        patch: { poReference: "PO-CHANGED" },
        queryId,
      },
      async (tx) => {
        await tx.cargo.update({ where: { id: cargoId }, data: { poReference: "PO-CHANGED" } });
      },
    );

    const legIdSet = new Set(res.scope.map((s: { type: string; id?: string }) => s.id));
    expect(res.scope.every((s: { type: string }) => s.type === "leg")).toBe(true);
    expect(legIdSet).toEqual(new Set([legA.id, legB.id]));
  });

  it("keeps a cargo edit self-scoped when none of its packages are assigned to a leg (Task 8)", async () => {
    const { queryId, cargoId } = await createCargoRow("unassigned");

    const res = await mediator.apply(
      {
        entity: "cargo",
        id: cargoId,
        field: "poReference",
        patch: { poReference: "PO-CHANGED" },
        queryId,
      },
      async (tx) => {
        await tx.cargo.update({ where: { id: cargoId }, data: { poReference: "PO-CHANGED" } });
      },
    );

    expect(res.scope).toEqual([{ type: "cargo", id: cargoId }]);
  });

  // Package-grain SCOPE RESOLUTION (restored gating, Unit 2): `case "package"` in
  // ImpactClassifier now resolves scope via routing.legsCarryingPackage (LegPackage) — the SAME
  // shape as the cargo fan-out above, but one level down the tree. This is a distinct classifier
  // branch from "cargo" (which fans via a package's cargoId, not the package's own id), so it
  // needs its own direct coverage. These two tests assert only the scope-resolution INPUT to the
  // fork decision (class + scoped legs); the end-to-end change-order FORK itself — a package edit
  // on a leg with a LIVE quote returning needsChangeOrder — is proven separately against the real
  // mediated-service path in change-order-cascade.e2e-spec.ts.
  it("fans a package edit's scope out to the legs carrying it via LegPackage (restored package-grain gating)", async () => {
    const { queryId, packageId } = await createCargoRow("pkg-fanout");
    const legC = await prisma.leg.create({ data: { queryId, legCode: "LC" } });
    const legD = await prisma.leg.create({ data: { queryId, legCode: "LD" } });
    await assignPackagesToLeg(prisma, legC.id, [packageId]);
    await assignPackagesToLeg(prisma, legD.id, [packageId]);

    const res = await mediator.apply(
      { entity: "package", id: packageId, field: "grossWt", patch: { grossWt: 200 }, queryId },
      async (tx) => {
        await tx.package.update({ where: { id: packageId }, data: { grossWt: 200 } });
      },
    );

    expect(res.class).toBe("RfqDefining");
    const legIdSet = new Set(res.scope.map((s: { type: string; id?: string }) => s.id));
    expect(res.scope.every((s: { type: string }) => s.type === "leg")).toBe(true);
    expect(legIdSet).toEqual(new Set([legC.id, legD.id]));
  });

  it("keeps a package edit self-scoped when it isn't assigned to any leg (package-grain fallback)", async () => {
    const { queryId, packageId } = await createCargoRow("pkg-unassigned");

    const res = await mediator.apply(
      { entity: "package", id: packageId, field: "grossWt", patch: { grossWt: 200 }, queryId },
      async (tx) => {
        await tx.package.update({ where: { id: packageId }, data: { grossWt: 200 } });
      },
    );

    expect(res.scope).toEqual([{ type: "package", id: packageId }]);
  });
});
