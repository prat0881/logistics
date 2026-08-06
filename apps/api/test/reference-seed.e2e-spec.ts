import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import {
  resolveChargeConfig,
  REFERENCE_TAGS,
  type ChargeLineDefinitionDto,
  type ReferenceTag,
} from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";

describe("seedReferenceData", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = m.get(PrismaService);
  });
  afterAll(async () => await app.close());

  it("is idempotent (3 factors, 9 items, 2 code sequences) and preserves edits", async () => {
    await seedReferenceData(prisma);
    await prisma.freightDensityFactor.update({ where: { mode: "AIR" }, data: { kgPerCbm: 999 } });
    await seedReferenceData(prisma); // second run
    expect(await prisma.freightDensityFactor.count()).toBe(3);
    expect(await prisma.checklistDefinition.count()).toBe(9);
    expect(
      (await prisma.freightDensityFactor.findUnique({ where: { mode: "AIR" } }))!.kgPerCbm,
    ).toBe(999); // not overwritten
    expect(await prisma.codeSequence.findUnique({ where: { key: "CLIENT" } })).not.toBeNull();
  });

  // Task 8: Air FSC/Peak cores + Heavy-Weight flipped to a calc line; SEA_MAIN_FREIGHT retired
  // (design §5.2 replaces the flat Sea line with the structured seaRates[] dual-rate — leaving
  // it active would double-count via draft.charges AND seaRates in computeQuoteTotals).
  it("seeds AIR_MAIN_FSC / AIR_MAIN_PEAK_SEASON cores and flips AIR_MAIN_HEAVY_WEIGHT to HEAVY_WEIGHT_CALC", async () => {
    await seedReferenceData(prisma);

    const fsc = await prisma.chargeLineDefinition.findUniqueOrThrow({ where: { key: "AIR_MAIN_FSC" } });
    expect(fsc.mode).toBe("AIR");
    expect(fsc.role).toBe("CORE");
    expect(fsc.isActive).toBe(true);

    const peak = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "AIR_MAIN_PEAK_SEASON" },
    });
    expect(peak.mode).toBe("AIR");
    expect(peak.role).toBe("CORE");
    expect(peak.isActive).toBe(true);

    const heavy = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "AIR_MAIN_HEAVY_WEIGHT" },
    });
    expect(heavy.inputType).toBe("HEAVY_WEIGHT_CALC");
  });

  it("retires SEA_MAIN_FREIGHT (isActive:false) and excludes it from a resolved Sea chargeConfigSnapshot", async () => {
    await seedReferenceData(prisma); // create-only — does NOT flip an already-seeded row; the data migration does

    const seaFreight = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "SEA_MAIN_FREIGHT" },
    });
    expect(seaFreight.isActive).toBe(false);

    // Integration check: resolveChargeConfig over the live seeded Sea catalogue must never
    // surface SEA_MAIN_FREIGHT, even when every Sea key is "selected" and every reference tag
    // is present — inactive definitions are excluded regardless of role/selection.
    const seaDefs = await prisma.chargeLineDefinition.findMany({ where: { mode: "SEA" } });
    const dtos: ChargeLineDefinitionDto[] = seaDefs.map((d) => ({
      id: d.id,
      key: d.key,
      mode: d.mode,
      role: d.role,
      inputType: d.inputType,
      zone: d.zone,
      tagKey: d.tagKey,
      label: d.label,
      sortOrder: d.sortOrder,
      isActive: d.isActive,
    }));
    const snap = resolveChargeConfig(
      dtos,
      seaDefs.map((d) => d.key),
      true,
      REFERENCE_TAGS as unknown as ReferenceTag[],
    );
    expect(snap.lines.map((l) => l.definitionKey)).not.toContain("SEA_MAIN_FREIGHT");
  });
});
