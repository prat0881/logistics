process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

// Route note: the controller is registered as `charge-line-definitions` (see
// charge-catalogue.controller.ts), not `config/charge-catalogue` — the brief's task
// description names the concern, not the literal path, and the existing @Get() must keep
// working unchanged at its current route.
const BASE = "/api/charge-line-definitions";

const line = {
  mode: "SEA", variant: "FCL", category: "DESTINATION",
  label: "Catalogue E2E Charge", isAdditional: true,
};

describe("Charge catalogue write API (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    // create-only upserts: guarantees SEA_DEST_WHARFAGE (used by the duplicate-label test below)
    // exists regardless of test order/DB state (CI has no seed step).
    await seedReferenceData(prisma);
  });

  afterAll(async () => {
    await prisma.legChargeLineSelection.deleteMany({ where: { leg: { legCode: "L1" } } });
    await prisma.leg.deleteMany({ where: { legCode: "L1" } });
    await prisma.query.deleteMany({ where: { queryCode: "Q-CATALOGUE-E2E" } });
    // By key AND by label. The rename test below PATCHes a row's label to "wharfage charges", so
    // a label-only cleanup leaves that row behind whenever the test fails part-way — and an
    // orphan SEA/DESTINATION/STANDARD row breaks both the POST in this suite (duplicate key on
    // the next run) and charge-catalogue.e2e-spec.ts's per-mode role counts. The key is minted at
    // create and never changes, so it is the reliable handle.
    await prisma.chargeLineDefinition.deleteMany({
      where: {
        OR: [
          { label: { startsWith: "Catalogue E2E" } },
          { key: { startsWith: "SEA_DEST_CATALOGUE_E2E" } },
        ],
      },
    });
    await app.close(); // mandatory — prevents cron hang
  });

  it("writes the derived zone and role alongside the new columns", async () => {
    const res = await request(app.getHttpServer())
      .post(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send(line).expect(201);

    const row = await prisma.chargeLineDefinition.findUnique({ where: { id: res.body.id } });
    expect(row?.category).toBe("DESTINATION");
    expect(row?.zone).toBe("DESTINATION"); // derived
    expect(row?.role).toBe("STANDARD"); // derived: additional, no tag
    expect(row?.key).toBe("SEA_DEST_CATALOGUE_E2E_CHARGE");
  });

  it("rejects a duplicate label even when it would mint a different key than the curated existing row (case-insensitive)", async () => {
    // SEA_DEST_WHARFAGE is seeded with a curated key, not the one chargeLineKey("SEA",
    // "DESTINATION", "Wharfage Charges") would mint (SEA_DEST_WHARFAGE_CHARGES) — see
    // reference-seed.ts. A key-uniqueness check alone would let this create a near-duplicate
    // row meaning the same thing under a different key; it must be caught by label instead.
    const existing = await prisma.chargeLineDefinition.findUniqueOrThrow({
      where: { key: "SEA_DEST_WHARFAGE" },
    });
    expect(existing.label).toBe("Wharfage Charges");

    const dup = await request(app.getHttpServer())
      .post(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ mode: "SEA", variant: "BOTH", category: "DESTINATION", label: "wharfage charges", isAdditional: true })
      .expect(409);

    expect(dup.body.message).toMatch(/already exists/i);
    expect(dup.body.message).toContain("SEA_DEST_WHARFAGE");
    // Confirms no near-duplicate row was created under the chargeLineKey-generated key.
    expect(
      await prisma.chargeLineDefinition.findUnique({ where: { key: "SEA_DEST_WHARFAGE_CHARGES" } }),
    ).toBeNull();
  });

  it("rejects renaming a line onto an existing line's label (the same guard create() applies)", async () => {
    // The near-duplicate create() refuses was reachable in one PATCH: the update schema permits
    // `label`, and `key` is minted once at create and never re-derived — so renaming a row to
    // "Wharfage Charges" produced exactly the pair of rows create() exists to prevent, with the
    // key unique constraint no help at all since neither key changed.
    const created = await request(app.getHttpServer())
      .post(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...line, label: "Catalogue E2E Renamer" }).expect(201);

    const dup = await request(app.getHttpServer())
      .patch(`${BASE}/${created.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ label: "wharfage charges" }) // different case, same SEA/DESTINATION label
      .expect(409);
    expect(dup.body.message).toMatch(/already exists/i);
    expect(dup.body.message).toContain("SEA_DEST_WHARFAGE");

    // The refused PATCH must not have landed.
    const row = await prisma.chargeLineDefinition.findUnique({ where: { id: created.body.id } });
    expect(row?.label).toBe("Catalogue E2E Renamer");
  });

  it("still allows a PATCH that re-sends the row's own current label", async () => {
    // The duplicate check excludes the row's own id, so a no-op or partial edit that happens to
    // carry the unchanged label is not mistaken for a collision with itself.
    const created = await request(app.getHttpServer())
      .post(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...line, label: "Catalogue E2E Self Rename" }).expect(201);

    await request(app.getHttpServer())
      .patch(`${BASE}/${created.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ label: "Catalogue E2E Self Rename", sortOrder: 777 })
      .expect(200);

    const row = await prisma.chargeLineDefinition.findUnique({ where: { id: created.body.id } });
    expect(row?.sortOrder).toBe(777);
  });

  it("refuses to change category after creation", async () => {
    const res = await request(app.getHttpServer())
      .post(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...line, label: "Catalogue E2E Immutable" }).expect(201);

    await request(app.getHttpServer())
      .patch(`${BASE}/${res.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ category: "ORIGIN" }).expect(400);
  });

  it("deletes a definition nothing references", async () => {
    const res = await request(app.getHttpServer())
      .post(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...line, label: "Catalogue E2E Unused" }).expect(201);

    await request(app.getHttpServer())
      .delete(`${BASE}/${res.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(200);
    expect(await prisma.chargeLineDefinition.findUnique({ where: { id: res.body.id } })).toBeNull();
  });

  it("refuses to delete a definition a leg references", async () => {
    const res = await request(app.getHttpServer())
      .post(BASE).set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ ...line, label: "Catalogue E2E In Use" }).expect(201);

    // Build the reference rather than hunting for one: a database with no distributed quote
    // would let this test pass without exercising the guard at all. Query needs only queryCode
    // and Leg only queryId + legCode — every other column is optional or defaulted.
    const query = await prisma.query.create({ data: { queryCode: "Q-CATALOGUE-E2E" } });
    const leg = await prisma.leg.create({ data: { queryId: query.id, legCode: "L1" } });
    await prisma.legChargeLineSelection.create({
      data: { legId: leg.id, definitionId: res.body.id },
    });

    const refused = await request(app.getHttpServer())
      .delete(`${BASE}/${res.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
      .expect(409);
    expect(refused.body.message).toMatch(/in use on 1 leg/i);
    expect(await prisma.chargeLineDefinition.findUnique({ where: { id: res.body.id } })).not.toBeNull();
  });

  it("refuses writes from an executive", async () => {
    await request(app.getHttpServer())
      .post(BASE).set("Cookie", cookie(Role.EXECUTIVE))
      .send({ ...line, label: "Catalogue E2E RBAC" }).expect(403);
  });
});
