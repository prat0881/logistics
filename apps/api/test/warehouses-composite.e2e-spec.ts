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
import { warehouseCreateBody } from "./helpers/warehouse";

const WH = "WH Composite E2E";

// TruckTonnage is a Prisma enum (T_1 … TRAILER_30_40T) while the shared schema types `tonnage`
// as a plain non-empty string, so a made-up value like "10T" passes Zod and only blows up at the
// Prisma write. Use real enum members here.
const BIG = "T_12";
const SMALL = "T_5";

describe("Warehouses composite create/update (e2e)", () => {
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
    await prisma.warehouse.deleteMany({ where: { name: { startsWith: WH } } });
  });

  afterAll(async () => {
    await prisma.warehouse.deleteMany({ where: { name: { startsWith: WH } } });
    await app.close();
  });

  it("creates a warehouse with contacts and vehicles in one request", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        warehouseCreateBody({
          name: `${WH} A`,
          vehicles: [
            { tonnage: BIG, quantity: 3 },
            { tonnage: SMALL, quantity: 1 },
          ],
        }),
      )
      .expect(201);

    expect(await prisma.warehouseContact.count({ where: { warehouseId: res.body.id } })).toBe(1);
    expect(await prisma.warehouseVehicle.count({ where: { warehouseId: res.body.id } })).toBe(2);
  });

  it("400s a create with no primary contact", async () => {
    await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        warehouseCreateBody({
          name: `${WH} B`,
          contacts: [{ name: "N", email: "n@x.com", contactNo: "+971501234567", pocLevel: "NONE" }],
        }),
      )
      .expect(400);
  });

  it("removes a vehicle omitted from the array and keeps the rest", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        warehouseCreateBody({
          name: `${WH} C`,
          vehicles: [
            { tonnage: BIG, quantity: 3 },
            { tonnage: SMALL, quantity: 1 },
          ],
        }),
      )
      .expect(201);
    const rows = await prisma.warehouseVehicle.findMany({
      where: { warehouseId: created.body.id },
    });
    const keep = rows.find((v) => v.tonnage === BIG)!;

    await request(app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({ vehicles: [{ id: keep.id, tonnage: BIG, quantity: 5 }] })
      .expect(200);

    const after = await prisma.warehouseVehicle.findMany({
      where: { warehouseId: created.body.id },
    });
    expect(after).toHaveLength(1);
    expect(after[0].quantity).toBe(5);
  });

  // The contract-invariant regression guard: superRefine must still be attached after Task 3
  // added child fields to the object.
  it("still rejects an OWNED warehouse with no agreement date", async () => {
    await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(warehouseCreateBody({ name: `${WH} D`, type: "OWNED", agreementValidUntil: undefined }))
      .expect(400);
  });

  // Proves reconcileContacts is wired to the WarehouseContact delegate with the right owner key:
  // a single payload that demotes the current primary and promotes the other contact would
  // violate WarehouseContact_one_primary at the intermediate state if the writes were reordered.
  it("swaps which contact is primary in one PATCH", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        warehouseCreateBody({
          name: `${WH} E`,
          contacts: [
            { name: "Alpha", email: "alpha@e2e.test", contactNo: "+971501111111", pocLevel: "PRIMARY" },
            { name: "Beta", email: "beta@e2e.test", contactNo: "+971502222222", pocLevel: "NONE" },
          ],
        }),
      )
      .expect(201);
    const rows = await prisma.warehouseContact.findMany({ where: { warehouseId: created.body.id } });
    const alpha = rows.find((c) => c.name === "Alpha")!;
    const beta = rows.find((c) => c.name === "Beta")!;

    await request(app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          { id: alpha.id, name: "Alpha", email: "alpha@e2e.test", contactNo: "+971501111111", pocLevel: "SECONDARY" },
          { id: beta.id, name: "Beta", email: "beta@e2e.test", contactNo: "+971502222222", pocLevel: "PRIMARY" },
        ],
      })
      .expect(200);

    const after = await prisma.warehouseContact.findMany({ where: { warehouseId: created.body.id } });
    expect(after.filter((c) => c.pocLevel === "PRIMARY").map((c) => c.name)).toEqual(["Beta"]);
  });

  // The whole point of doing this in one transaction: a rejected child must leave the parent
  // row and its other children untouched, not half-written.
  it("rolls the parent write back when a vehicle id belongs to no row on this warehouse", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        warehouseCreateBody({
          name: `${WH} F`,
          city: "Original City",
          vehicles: [{ tonnage: BIG, quantity: 2 }],
        }),
      )
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        city: "Rolled Back City",
        vehicles: [{ id: "00000000-0000-4000-8000-000000000000", tonnage: SMALL, quantity: 9 }],
      })
      .expect(404);

    const after = await prisma.warehouse.findUnique({
      where: { id: created.body.id },
      include: { vehicles: true },
    });
    expect(after?.city).toBe("Original City");
    expect(after?.vehicles).toHaveLength(1);
    expect(after?.vehicles[0].quantity).toBe(2);
  });
});
