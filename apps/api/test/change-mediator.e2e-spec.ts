process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { ChangeMediator } from "../src/modules/changes/change-mediator";
import { ScopeResolver } from "../src/modules/changes/scope.resolver";
import { ImpactRegistry } from "../src/modules/changes/impact.registry";
import { ChangeOrderNotAvailableError } from "../src/modules/changes/errors";

describe("Change Mediator (integration)", () => {
  let app: INestApplication;
  let mediator: ChangeMediator;
  let resolver: ScopeResolver;
  let registry: ImpactRegistry;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    mediator = moduleRef.get(ChangeMediator);
    resolver = moduleRef.get(ScopeResolver);
    registry = moduleRef.get(ImpactRegistry);
  });

  afterAll(async () => {
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
    expect(res.findings).toEqual([]); // no-op route validator
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
});
