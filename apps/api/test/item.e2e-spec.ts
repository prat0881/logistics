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

const PFX = "p7-item-";

// Item CRUD (Task 7, re-modelled Query -> Cargo -> Package -> Item). V-4 (qty ⇒ uom):
// itemCreateSchema enforces it statelessly (create validates one whole object at once) —
// itemUpdateSchema deliberately does NOT (a partial PATCH can't see the stored uom, §A2) —
// ItemService.update instead enforces V-4 service-side via merge-then-validate (patched-or-
// stored qty/uom). The brief's empty-item guard (create only) rejects a body with neither
// product nor qty.
describe("Item CRUD (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let seq = 0;
  // UUID sub — user.userId lands in an @db.Uuid column (Item.tenantId).
  const USER_ID = "55555555-5555-5555-5555-555555555555";
  const cookie = (role: Role = Role.EXECUTIVE) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: USER_ID, role, tenantId: null })}`;
  const api = () => request(app.getHttpServer());

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
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  // Mints an isolated query per test so rowIndex/FK-chain assertions never see another test's rows.
  async function freshQuery(): Promise<{ queryId: string }> {
    seq += 1;
    const q = await prisma.query.create({
      data: {
        queryCode: `Z7${Date.now()}${seq}`.slice(0, 24),
        shipmentDescription: `${PFX}${seq}`,
      },
    });
    return { queryId: q.id };
  }

  function addCargo(queryId: string, body: Record<string, unknown> = {}) {
    return api().post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie()).send(body);
  }

  function addPackage(queryId: string, cargoId: string, body: Record<string, unknown> = {}) {
    return api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages`)
      .set("Cookie", cookie())
      .send(body);
  }

  // Item endpoints always need a full query -> cargo -> package FK chain, so every test starts
  // from this rather than repeating cargo/package setup inline.
  async function freshPackage(): Promise<{ queryId: string; cargoId: string; packageId: string }> {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const pkg = await addPackage(queryId, cargo.body.id, {
      packageNo: `PK-${++seq}`,
      packageType: "BOX",
      dimL: 1,
      dimW: 1,
      dimH: 1,
      grossWt: 1,
    }).expect(201);
    return { queryId, cargoId: cargo.body.id, packageId: pkg.body.id };
  }

  function addItem(
    queryId: string,
    cargoId: string,
    packageId: string,
    body: Record<string, unknown>,
  ) {
    return api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`)
      .set("Cookie", cookie())
      .send(body);
  }

  // Task 7 brief's exact test, verbatim.
  it("rejects an item with qty but no UoM (V-4) and discards an empty item", async () => {
    const { queryId, cargoId, packageId } = await freshPackage();
    await api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`)
      .set("Cookie", cookie())
      .send({ product: "X", qty: 3 })
      .expect(400); // V-4: qty ⇒ uom
    await api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`)
      .set("Cookie", cookie())
      .send({})
      .expect(400); // no product & no qty → discarded/invalid
    const ok = await api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`)
      .set("Cookie", cookie())
      .send({ product: "Paint", qty: 8, uom: "PC", hsCode: "32081090" })
      .expect(201);
    expect(ok.body.uom).toBe("PC");
  });

  it("accepts an item with only a product (no qty ⇒ no uom required)", async () => {
    const { queryId, cargoId, packageId } = await freshPackage();
    const created = await addItem(queryId, cargoId, packageId, { product: "Just a name" }).expect(
      201,
    );
    expect(created.body.product).toBe("Just a name");
    expect(created.body.qty).toBeNull();
    expect(created.body.uom).toBeNull();
  });

  it("mints sequential rowIndex scoped to the package", async () => {
    const { queryId, cargoId, packageId } = await freshPackage();
    const i1 = await addItem(queryId, cargoId, packageId, { product: "A" }).expect(201);
    const i2 = await addItem(queryId, cargoId, packageId, { product: "B" }).expect(201);
    expect(i1.body.rowIndex).toBe(1);
    expect(i2.body.rowIndex).toBe(2);
  });

  it("404s creating an item under a package that doesn't belong to this query/cargo (bad ref, not P2003)", async () => {
    const { queryId: ownerQuery, cargoId: ownerCargo, packageId } = await freshPackage();
    const { queryId: otherQuery } = await freshQuery();

    // Non-existent packageId under the right query/cargo.
    await addItem(ownerQuery, ownerCargo, "00000000-0000-0000-0000-000000000000", {
      product: "X",
    }).expect(404);
    // Real packageId, wrong query.
    await addItem(otherQuery, ownerCargo, packageId, { product: "X" }).expect(404);
    // Real packageId, wrong cargo (different cargo under the SAME query).
    const secondCargo = await addCargo(ownerQuery, {}).expect(201);
    await addItem(ownerQuery, secondCargo.body.id, packageId, { product: "X" }).expect(404);
  });

  it("updates an item (mediated, partial); untouched fields survive the patch", async () => {
    const { queryId, cargoId, packageId } = await freshPackage();
    const created = await addItem(queryId, cargoId, packageId, {
      product: "Widget",
      qty: 2,
      uom: "PC",
    }).expect(201);
    const updated = await api()
      .patch(
        `/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items/${created.body.id}`,
      )
      .set("Cookie", cookie())
      .send({ hsCode: "12345678", tags: ["FRAGILE"] })
      .expect(200);
    expect(updated.body.hsCode).toBe("12345678");
    expect(updated.body.tags).toEqual(["FRAGILE"]);
    expect(updated.body.product).toBe("Widget"); // untouched field survives a partial patch
    expect(updated.body.qty).toBe("2");
  });

  it("404s updating/removing an item that doesn't exist under this package", async () => {
    const { queryId, cargoId, packageId } = await freshPackage();
    await api()
      .patch(
        `/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items/00000000-0000-0000-0000-000000000000`,
      )
      .set("Cookie", cookie())
      .send({ product: "X" })
      .expect(404);
    await api()
      .delete(
        `/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items/00000000-0000-0000-0000-000000000000`,
      )
      .set("Cookie", cookie())
      .expect(404);
  });

  it("removes an item (mediated @delete)", async () => {
    const { queryId, cargoId, packageId } = await freshPackage();
    const created = await addItem(queryId, cargoId, packageId, { product: "Gone" }).expect(201);
    await api()
      .delete(
        `/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items/${created.body.id}`,
      )
      .set("Cookie", cookie())
      .expect(204);
    expect(await prisma.item.findUnique({ where: { id: created.body.id } })).toBeNull();
  });

  // Carry-forward fix (Task 7 §A2/§A3): itemUpdateSchema's cross-field refine was REMOVED
  // (packages/shared/src/cargo.ts) because it false-rejected a single-sided partial PATCH even
  // when the stored row already satisfied V-4. ItemService.update now merges patched-or-stored
  // qty/uom and validates the effective pair — these three cases are exactly the ones the old
  // schema-only refine got wrong (or right for the wrong reason).
  describe("V-4 merge-then-validate on update (Task 7 §A2/§A3)", () => {
    it("(i) rejects PATCH {uom:null} on an item with a stored qty (merged qty-without-uom)", async () => {
      const { queryId, cargoId, packageId } = await freshPackage();
      const created = await addItem(queryId, cargoId, packageId, {
        product: "P",
        qty: 8,
        uom: "PC",
      }).expect(201);
      await api()
        .patch(
          `/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items/${created.body.id}`,
        )
        .set("Cookie", cookie())
        .send({ uom: null })
        .expect(400);
    });

    it("(ii) accepts PATCH {qty:5} alone when the stored uom already satisfies V-4", async () => {
      const { queryId, cargoId, packageId } = await freshPackage();
      const created = await addItem(queryId, cargoId, packageId, {
        product: "P",
        qty: 8,
        uom: "PC",
      }).expect(201);
      // The rejected PATCH {uom:null} from case (i) never applied — this item's stored uom is
      // still "PC". PATCH {qty:5} (uom omitted) must succeed: this is exactly the case the old
      // itemUpdateSchema refine wrongly rejected, since it only ever saw the patch in isolation.
      const updated = await api()
        .patch(
          `/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items/${created.body.id}`,
        )
        .set("Cookie", cookie())
        .send({ qty: 5 })
        .expect(200);
      expect(updated.body.qty).toBe("5");
      expect(updated.body.uom).toBe("PC");
    });

    it("(iii) rejects PATCH {qty:5} on an item whose stored uom is null", async () => {
      const { queryId, cargoId, packageId } = await freshPackage();
      const created = await addItem(queryId, cargoId, packageId, { product: "NoUom" }).expect(201);
      expect(created.body.uom).toBeNull();
      await api()
        .patch(
          `/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items/${created.body.id}`,
        )
        .set("Cookie", cookie())
        .send({ qty: 5 })
        .expect(400);
    });
  });
});
