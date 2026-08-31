process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ImpactClass } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ImpactClassifier } from "../src/modules/changes/impact.classifier";
import { ImpactRegistry } from "../src/modules/changes/impact.registry";
import { ffFixture } from "./helpers/freight-forwarder";

const PFX = "p6-quote-impact-";

// SB6 (Task 4): the real `quotes` impact map, declared by RfqModule.onModuleInit (design §4):
// @delete (remove an FF from a sent leg) = Structural; @create (add an FF) = Corrective (a new
// distribution that invalidates nothing, below the RfqDefining fork threshold — free). Also
// covers the Task-4 prerequisite fix (surfaced in the Task 2 review): a nonexistent quote id
// must 404, not self-scope — Quote.legId is non-nullable, so `legOfQuote → null` means the
// quote row doesn't exist (unlike cargo/point, a quote has no legitimate pre-RFQ unassigned
// state to fall back to).
describe("quotes impact map (e2e)", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let classifier: ImpactClassifier;
  let registry: ImpactRegistry;

  let queryId: string;
  let legId: string;
  let ffId: string;
  let quoteId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    classifier = moduleRef.get(ImpactClassifier);
    registry = moduleRef.get(ImpactRegistry);

    // Fixture: real Query + 2 Points (leg endpoints) + 1 Leg + 1 FreightForwarder + 1 Quote,
    // mirrored from impact-classifier-scope.e2e-spec.ts / rfq-eligibility.e2e-spec.ts.
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    const q = await prisma.query.create({
      data: { queryCode: `${PFX}${Date.now()}`, shipmentDescription: `${PFX}q` },
    });
    queryId = q.id;
    const origin = await prisma.point.create({ data: { queryId, type: "PICKUP", name: "PU", country: "IN" } });
    const destination = await prisma.point.create({
      data: { queryId, type: "DELIVERY", name: "DE", country: "DE" },
    });
    legId = (
      await prisma.leg.create({
        data: { queryId, legCode: "L1", originPointId: origin.id, destinationPointId: destination.id },
      })
    ).id;

    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: `${PFX}FF` } });
    const ff = await prisma.freightForwarder.create({
      data: ffFixture({
        freightForwarderCode: `${PFX}FF`,
        companyName: "Quote Impact FF",
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

  it("declares @delete as Structural and @create as Corrective (free) for quotes", () => {
    expect(registry.classOf("quotes", "@delete")).toBe(ImpactClass.Structural);
    expect(registry.classOf("quotes", "@create")).toBe(ImpactClass.Corrective);
  });

  it("classifies removing an FF's quote as Structural, scoped to its leg", async () => {
    const result = await classifier.classify({ entity: "quotes", action: "@delete", id: quoteId, queryId });
    expect(result.class).toBe(ImpactClass.Structural);
    expect(result.scope).toEqual([{ type: "leg", id: legId }]);
  });

  it("rejects a nonexistent quote id with NotFoundException instead of self-scoping", async () => {
    await expect(
      classifier.classify({ entity: "quotes", action: "@delete", id: randomUUID(), queryId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
