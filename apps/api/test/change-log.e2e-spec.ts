process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("ChangeLog table", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let queryId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    const q = await prisma.query.create({
      data: { queryCode: `CLG-${Date.now()}`, status: "RFQ_SENT" },
      select: { id: true },
    });
    queryId = q.id;
  });

  afterAll(async () => {
    await prisma.query.deleteMany({ where: { id: queryId } }); // no-op if the test already deleted it
    await moduleRef.close(); // MANDATORY — otherwise jest hangs on the schedule cron
  });

  it("persists a change-log row and cascades on query delete", async () => {
    const row = await prisma.changeLog.create({
      data: {
        queryId, entity: "cargo", entityId: queryId, changeType: "change-order",
        payload: { field: "grossWt", from: "1000", to: "1200" },
      },
    });
    expect(row.id).toBeDefined();
    const found = await prisma.changeLog.findMany({ where: { queryId } });
    expect(found).toHaveLength(1);

    // Positive cascade proof: deleting the parent Query must actually remove its ChangeLog
    // rows (ChangeLog.queryId is ON DELETE CASCADE), not merely "the delete didn't throw".
    await prisma.query.delete({ where: { id: queryId } });
    const afterDelete = await prisma.changeLog.findMany({ where: { queryId } });
    expect(afterDelete).toEqual([]);
  });
});
