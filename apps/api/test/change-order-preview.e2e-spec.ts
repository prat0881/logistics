process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { QuoteStatus } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ChangeMediator } from "../src/modules/changes/change-mediator";
import { createCargoWithPackages, assignPackagesToLeg } from "./helpers/cargo";

// Task 7: the change-order PREVIEW phase — a change-order-path request arriving WITHOUT a
// `reason` must compute + return the blast radius and apply nothing. The APPLY half (with
// `reason` → the saga) is Task 8.
//
// Cargo→Package re-model (Unit 5 ripple): the fixture builds a Cargo→Package (+LegPackage) via
// the shared helper instead of the dropped flat CargoItem/LegCargo model, and the edit under
// test is `entity: "package"` (grossWt is RfqDefining on Package — package.impact.ts — cargo
// itself now carries only Corrective grouping metadata).
const PFX = "chg-order-preview-";
const CODE = `${PFX}query`;
const FF_PREFIX = `FF-${PFX}`;

describe("ChangeOrderStrategy preview phase (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mediator: ChangeMediator;

  // Order matters: Quote.freightForwarder is onDelete:Restrict, so quotes must go before
  // the FFs they reference; Query cascades legs/legPackages/cargo/packages/items on delete.
  const cleanup = async () => {
    const q = await prisma.query.findUnique({ where: { queryCode: CODE }, select: { id: true } });
    if (q) {
      await prisma.quote.deleteMany({ where: { queryId: q.id } });
    }
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { startsWith: FF_PREFIX } } });
    if (q) {
      await prisma.query.delete({ where: { id: q.id } }); // cascades legs/legPackages/cargo/packages/items
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    mediator = moduleRef.get(ChangeMediator);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("previews (writes nothing) an RfqDefining package edit on a distributed leg: QUOTED→invalidating, RFQ_SENT→refreshing", async () => {
    // --- fixtures (self-contained) ---
    const query = await prisma.query.create({ data: { queryCode: CODE } });
    const { packageIds } = await createCargoWithPackages(prisma, {
      queryId: query.id,
      packages: [{ dimL: 10, dimW: 10, dimH: 10, grossWt: 100 }],
    });
    const packageId = packageIds[0];
    const leg = await prisma.leg.create({
      data: {
        queryId: query.id,
        legCode: "L1",
        mode: "AIR",
        status: "RFQ_SENT", // distributed
      },
    });
    await assignPackagesToLeg(prisma, leg.id, packageIds);

    const mkFf = (code: string) =>
      prisma.freightForwarder.create({
        data: {
          freightForwarderCode: code,
          companyName: `${code} Co`,
          pic: "P",
          contactNumber: "+1000000000",
          email: `${code}@e2e.test`,
          availableCountries: ["AE"],
          modes: ["AIR"],
          status: "ACTIVE",
        },
      });
    const ffQuoted = await mkFf(`${FF_PREFIX}QUOTED`);
    const ffSent = await mkFf(`${FF_PREFIX}SENT`);

    const quotedQuote = await prisma.quote.create({
      data: { queryId: query.id, legId: leg.id, freightForwarderId: ffQuoted.id, status: QuoteStatus.QUOTED },
    });
    const sentQuote = await prisma.quote.create({
      data: { queryId: query.id, legId: leg.id, freightForwarderId: ffSent.id, status: QuoteStatus.RFQ_SENT },
    });

    // --- act: RfqDefining field (package.grossWt) on a leg with live quotes, no `reason` ---
    const uow = jest.fn(async (tx) => {
      await tx.package.update({ where: { id: packageId }, data: { grossWt: 999 } });
    });
    const res = await mediator.apply(
      { entity: "package", id: packageId, field: "grossWt", queryId: query.id, patch: { grossWt: 999 } },
      uow,
    );

    // --- assert: change-order path, preview only, nothing applied ---
    expect(res.path).toBe("change-order");
    expect(res.class).toBe("RfqDefining");
    expect(res.needsConfirmation).toBe(true);
    expect(uow).not.toHaveBeenCalled(); // no reason ⇒ preview only, the uow never runs

    expect(res.preview).toBeDefined();
    const preview = res.preview!;
    expect(preview.affectedLegs).toEqual([leg.id]);
    expect(preview.invalidatingQuotes).toEqual([
      { quoteId: quotedQuote.id, freightForwarderId: ffQuoted.id },
    ]);
    expect(preview.refreshingQuotes).toEqual([
      { quoteId: sentQuote.id, freightForwarderId: ffSent.id },
    ]);
    expect(preview.impactClass).toBe("RfqDefining");

    // the field was NOT written — re-read the row
    const packageAfter = await prisma.package.findUnique({ where: { id: packageId } });
    expect(Number(packageAfter?.grossWt)).toBe(100);
  });
});
