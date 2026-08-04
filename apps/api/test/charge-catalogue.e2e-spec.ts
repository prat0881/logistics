import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";

describe("charge catalogue seed", () => {
  const prisma = new PrismaService();
  beforeAll(async () => { await prisma.$connect(); await seedReferenceData(prisma); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("seeds today's per-mode line-up with 3 inactive rows", async () => {
    const rows = await prisma.chargeLineDefinition.findMany();
    const by = (m: string, r: string) => rows.filter((x) => x.mode === m && x.role === r && x.isActive);
    expect(by("AIR", "CORE")).toHaveLength(9);
    expect(by("SEA", "CORE")).toHaveLength(6);
    expect(by("AIR", "STANDARD")).toHaveLength(3);   // dest THC/import/storage (last-mile inactive)
    expect(by("SEA", "STANDARD")).toHaveLength(3);   // delivery + last-mile inactive
    expect(by("ROAD", "STANDARD")).toHaveLength(8);
    expect(rows.filter((x) => x.role === "TAG_DRIVEN")).toHaveLength(15); // 5 × 3 modes
    expect(rows.filter((x) => !x.isActive).map((x) => x.key).sort()).toEqual(
      ["AIR_DEST_LAST_MILE", "SEA_DEST_DELIVERY", "SEA_DEST_LAST_MILE"]);
    expect(rows.find((x) => x.key === "ROAD_CORE_TRUCKING")?.inputType).toBe("TRUCKING");
    expect(rows.find((x) => x.key === "ROAD_WH_HANDLING")?.role).toBe("WAREHOUSE");
  });

  it("is idempotent (second seed adds no rows)", async () => {
    const before = await prisma.chargeLineDefinition.count();
    await seedReferenceData(prisma);
    expect(await prisma.chargeLineDefinition.count()).toBe(before);
  });
});
