process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.UPLOADS_DIR =
  process.env.UPLOADS_DIR ?? mkdtempSync(joinPath(tmpdir(), "svyft-uploads-"));

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

const PFX = "p4-cargo-";

describe("Cargo (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let queryId: string;
  // UUID sub — user.userId lands in @db.Uuid columns (FileAsset.uploadedById on MSDS upload).
  const USER_ID = "22222222-2222-2222-2222-222222222222";
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: USER_ID, role, tenantId: null })}`;
  const baseRow = {
    poReference: "PO-1",
    productName: "Widget",
    packageType: "Pallet",
    qty: 10,
    dimL: 120,
    dimW: 80,
    dimH: 100,
    grossWt: 500,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma);
    const q = await prisma.query.create({
      data: { queryCode: `Z${Date.now()}`.slice(0, 12), shipmentDescription: `${PFX}q` },
    });
    queryId = q.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("creates a cargo row (mediated @create), auto-numbers rowIndex, computes volumeCbm", async () => {
    const r1 = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/cargo`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send(baseRow)
      .expect(201);
    expect(r1.body.rowIndex).toBe(1);
    expect(Number(r1.body.volumeCbm)).toBeCloseTo(9.6, 3);
    const r2 = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/cargo`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send(baseRow)
      .expect(201);
    expect(r2.body.rowIndex).toBe(2);
  });

  it("auto-sets the query dgIndicator when a DG cargo row is added", async () => {
    await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/cargo`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ ...baseRow, isDangerous: true })
      .expect(201);
    const q = await prisma.query.findUnique({ where: { id: queryId } });
    expect(q!.dgIndicator).toBe(true);
  });

  it("updates a row (mediated) and rejects qty <= 0", async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/cargo`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send(baseRow)
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/queries/${queryId}/cargo/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ productName: "Renamed" })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/queries/${queryId}/cargo/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ qty: 0 })
      .expect(400);
  });

  it("deletes a row (mediated @delete)", async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/cargo`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send(baseRow)
      .expect(201);
    await request(app.getHttpServer())
      .delete(`/api/queries/${queryId}/cargo/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(204);
    expect(await prisma.cargoItem.findUnique({ where: { id: created.body.id } })).toBeNull();
  });

  it("404s cargo under a mismatched query", async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/queries/${queryId}/cargo`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send(baseRow)
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/api/queries/00000000-0000-0000-0000-000000000000/cargo/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ productName: "X" })
      .expect(404);
  });
});
