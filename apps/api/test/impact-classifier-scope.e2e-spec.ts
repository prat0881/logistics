process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { Test, type TestingModule } from "@nestjs/testing";
import { ImpactClass } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ImpactClassifier } from "../src/modules/changes/impact.classifier";
import { ImpactRegistry } from "../src/modules/changes/impact.registry";
import { ffFixture } from "./helpers/freight-forwarder";

const PFX = "p6-impact-scope-";

// SB6 (Task 2): the classifier's scope must always be leg-typed for point/query/quotes,
// not just cargo (design doc §5). Fixture mirrors legs.e2e-spec.ts: one Query, two Points
// wired as one Leg's origin/destination, plus one FreightForwarder + Quote on that leg so
// the quotes→its-leg fan-out can be exercised too.
describe("ImpactClassifier scope fan-out to legs (e2e)", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let classifier: ImpactClassifier;
  let registry: ImpactRegistry;

  let queryId: string;
  let originId: string;
  let destinationId: string;
  let legId: string;
  let ffId: string;
  let quoteId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    classifier = moduleRef.get(ImpactClassifier);
    registry = moduleRef.get(ImpactRegistry);

    // Task 4 (the real "quotes" impact map) hasn't landed yet — declare a minimal stand-in
    // so classify() can resolve an impact class for a "quotes" ChangeRequest through the
    // public API. Mirrors the real future entry (design doc §4): removing an FF's quote is
    // Structural. ImpactRegistry.declare merges per-entity, so this can't clobber Task 4's
    // later, real registration.
    registry.declare("quotes", { "@delete": ImpactClass.Structural });

    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` },
    });
    queryId = q.id;
    originId = (await prisma.point.create({ data: { queryId, type: "PICKUP", name: "PU", country: "IN" } })).id;
    destinationId = (await prisma.point.create({ data: { queryId, type: "DELIVERY", name: "DE", country: "DE" } }))
      .id;
    legId = (
      await prisma.leg.create({
        data: { queryId, legCode: "L1", originPointId: originId, destinationPointId: destinationId },
      })
    ).id;

    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: `${PFX}FF` } });
    const ff = await prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: `${PFX}FF`,
        companyName: "Impact Scope FF",
        pic: "PIC",
        contactNumber: "+10000000000",
        email: `${PFX}ff@e2e.test`,
        availableCountries: ["IN"],
        modes: ["ROAD"],
        handleDg: false,
      }),
    });
    ffId = ff.id;
    quoteId = (await prisma.quote.create({ data: { queryId, legId, freightForwarderId: ffId } })).id;
  });

  afterAll(async () => {
    await prisma.quote.deleteMany({ where: { legId } }).catch(() => {});
    await prisma.freightForwarder.deleteMany({ where: { id: ffId } }).catch(() => {});
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } }); // cascades points/legs
    await moduleRef.close();
  });

  it("fans a point edit's scope to the legs using it as origin or destination", async () => {
    const origin = await classifier.classify({ entity: "point", id: originId, field: "country", queryId });
    expect(origin.scope).toEqual([{ type: "leg", id: legId }]);

    const destination = await classifier.classify({
      entity: "point",
      id: destinationId,
      field: "country",
      queryId,
    });
    expect(destination.scope).toEqual([{ type: "leg", id: legId }]);
  });

  it("fans a query-wide field edit's scope to all its legs", async () => {
    const result = await classifier.classify({ entity: "query", id: queryId, field: "incoterms", queryId });
    expect(result.scope).toEqual([{ type: "leg", id: legId }]);
  });

  it("fans a quote action's scope to its leg", async () => {
    const result = await classifier.classify({ entity: "quotes", id: quoteId, action: "@delete", queryId });
    expect(result.scope).toEqual([{ type: "leg", id: legId }]);
  });

  it("still self-scopes a point with no referencing legs (unchanged fallback)", async () => {
    const orphan = await prisma.point.create({ data: { queryId, type: "SEAPORT", name: "SP", country: "SG" } });
    const result = await classifier.classify({ entity: "point", id: orphan.id, field: "country", queryId });
    expect(result.scope).toEqual([{ type: "point", id: orphan.id }]);
  });
});
