import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const ENTITY_ID = "p3-model-leg-1";

describe("StatusTransition model (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.statusTransition.deleteMany({ where: { entityId: ENTITY_ID } });
  });

  afterAll(async () => {
    await prisma.statusTransition.deleteMany({ where: { entityId: ENTITY_ID } });
    await app.close();
  });

  it("appends rows with a monotonic seq and reads the latest by (entity, entityId)", async () => {
    const a = await prisma.statusTransition.create({
      data: { entity: "leg", entityId: ENTITY_ID, from: null, to: "DRAFT", event: "create" },
    });
    const b = await prisma.statusTransition.create({
      data: {
        entity: "leg",
        entityId: ENTITY_ID,
        from: "DRAFT",
        to: "READY_FOR_RFQ",
        event: "validate.pass",
      },
    });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.actorId).toBeNull(); // system-authored default

    const latest = await prisma.statusTransition.findFirst({
      where: { entity: "leg", entityId: ENTITY_ID },
      orderBy: { seq: "desc" },
    });
    expect(latest?.to).toBe("READY_FOR_RFQ");
  });
});
