process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import ExcelJS from "exceljs";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

const PFX = "p9-export-";

// Excel export (Task 9, re-modelled Query -> Cargo -> Package -> Item). T4 dropped the old flat
// per-CargoItem-row `exportXlsx`; this re-adds it at the new grain — ONE worksheet "Packing
// List", ONE ROW PER ITEM, package+cargo context repeated on every item row (design §8.3). See
// cargo.service.ts `exportXlsx` / cargo.controller.ts `export` for the implementation this spec
// drives.
describe("Cargo export — packing list xlsx (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let seq = 0;
  // UUID sub — user.userId lands in a @db.Uuid column (Cargo/Package/Item.tenantId chain).
  const USER_ID = "77777777-7777-7777-7777-777777777777";
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

  // Mints an isolated query per test so rowIndex/export-content assertions never see another
  // test's rows.
  async function freshQuery(): Promise<{ queryId: string }> {
    seq += 1;
    const q = await prisma.query.create({
      data: {
        queryCode: `Z9${Date.now()}${seq}`.slice(0, 24),
        shipmentDescription: `${PFX}${seq}`,
      },
    });
    return { queryId: q.id };
  }

  function addCargo(queryId: string, body: Record<string, unknown> = {}) {
    return api().post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie()).send(body);
  }

  function addPackage(queryId: string, cargoId: string, body: Record<string, unknown>) {
    return api()
      .post(`/api/queries/${queryId}/cargo/${cargoId}/packages`)
      .set("Cookie", cookie())
      .send(body);
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

  // supertest's default parsers assume text/json bodies; the export response is a binary xlsx,
  // so `.then(r => r.body)` would hand back a mis-decoded string, not a Buffer, and
  // `ExcelJS.Workbook().xlsx.load(...)` needs a real Buffer. Force binary buffering by
  // collecting the raw response bytes ourselves instead of letting supertest's default parser
  // touch them.
  function exportXlsx(queryId: string) {
    return api()
      .post(`/api/queries/${queryId}/cargo/export`)
      .set("Cookie", cookie())
      .buffer(true)
      // No explicit param types: superagent's `.parse()` overload only exposes a `Response`-typed
      // callback shape (real runtime value is the raw Node response stream — a long-standing
      // @types/superagent inaccuracy for this exact binary-buffering idiom), so let contextual
      // typing from the overload drive the callback's parameter types instead of hand-annotating
      // them (hand-annotating `res`/`cb` here is what trips `tsc`, even though ts-jest's isolated
      // transpile never checks it).
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
  }

  // Robust column lookup by header text (rather than a hardcoded column letter) so assertions
  // don't silently mis-point if the §8.3 column order ever shifts.
  function headerIndex(ws: ExcelJS.Worksheet): Record<string, number> {
    const map: Record<string, number> = {};
    ws.getRow(1).eachCell((cell, colNumber) => {
      map[String(cell.value)] = colNumber;
    });
    return map;
  }

  async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook();
    // `buf`'s `Buffer` and exceljs's own declared `.load()` parameter resolve to two
    // structurally-identical but nominally distinct `@types/node` Buffer declarations in this
    // workspace's dependency graph — a pre-existing dependency-version-skew, not a cargo-model or
    // logic issue (the runtime value is a real Buffer either way). Derive the cast target
    // directly from the callee's own declared parameter type so it can't drift from whichever
    // Buffer identity exceljs itself resolves.
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    return wb;
  }

  // The plan's Task-9 test, verbatim per the brief: one row per item + headers.
  it("exports one row per item under the 'Packing List' worksheet, with §8.3 headers", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const pkg = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "PALLET",
      dimL: 120,
      dimW: 100,
      dimH: 140,
      grossWt: 420,
    }).expect(201);
    await addItem(queryId, cargo.body.id, pkg.body.id, {
      product: "Paint",
      qty: 8,
      uom: "PC",
      hsCode: "32081090",
    }).expect(201);

    const res = await exportXlsx(queryId).expect(201);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const wb = await loadWorkbook(res.body);
    const ws = wb.getWorksheet("Packing List");
    expect(ws).toBeDefined();

    const headerRow = Array.from(ws!.getRow(1).values as ExcelJS.CellValue[]);
    expect(headerRow).toEqual(
      expect.arrayContaining(["Package No", "HSN", "Volume (CBM)", "DG (Yes/No)"]),
    );

    const cols = headerIndex(ws!);
    const dataRow = ws!.getRow(2);
    expect(dataRow.getCell(cols["Product"]).value).toBe("Paint");
    expect(dataRow.getCell(cols["HSN"]).value).toBe("32081090");
  });

  it("emits one blank-item row for a package with no items (cargo/package columns still filled)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, { poReference: "PO-99" }).expect(201);
    await addPackage(queryId, cargo.body.id, {
      packageNo: "P-EMPTY",
      packageType: "BOX",
      dimL: 10,
      dimW: 10,
      dimH: 10,
      grossWt: 5,
    }).expect(201);

    const res = await exportXlsx(queryId).expect(201);
    const wb = await loadWorkbook(res.body);
    const ws = wb.getWorksheet("Packing List")!;
    const cols = headerIndex(ws);

    const dataRow = ws.getRow(2);
    expect(dataRow.getCell(cols["Package No"]).value).toBe("P-EMPTY");
    expect(dataRow.getCell(cols["PO / Reference"]).value).toBe("PO-99");
    // Item-only columns are blank ("") for a package with no items — accept any falsy
    // representation ("" survives xlsx round-tripping as either "" or null depending on
    // exceljs's empty-string handling).
    expect(dataRow.getCell(cols["SN"]).value).toBeFalsy();
    expect(dataRow.getCell(cols["Product"]).value).toBeFalsy();
    expect(dataRow.getCell(cols["Qty"]).value).toBeFalsy();
    expect(dataRow.getCell(cols["UoM"]).value).toBeFalsy();
    expect(dataRow.getCell(cols["HSN"]).value).toBeFalsy();
    expect(dataRow.getCell(cols["Item Tags"]).value).toBeFalsy();
  });

  it("marks DG (Yes/No) = Yes on every row of a DG-tagged package (package-level, not item-level)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, {}).expect(201);
    const dgPkg = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-DG",
      packageType: "DRUM",
      dimL: 50,
      dimW: 50,
      dimH: 50,
      grossWt: 100,
      tags: ["DG"],
    }).expect(201);
    await addItem(queryId, cargo.body.id, dgPkg.body.id, {
      product: "Solvent",
      qty: 4,
      uom: "PC",
    }).expect(201);
    const safePkg = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-SAFE",
      packageType: "BOX",
      dimL: 10,
      dimW: 10,
      dimH: 10,
      grossWt: 5,
    }).expect(201);
    await addItem(queryId, cargo.body.id, safePkg.body.id, {
      product: "Cloth",
      qty: 1,
      uom: "PC",
    }).expect(201);

    const res = await exportXlsx(queryId).expect(201);
    const wb = await loadWorkbook(res.body);
    const ws = wb.getWorksheet("Packing List")!;
    const cols = headerIndex(ws);

    // Row 2 = P-DG's one item row (packages/items come back in creation order from getTree).
    expect(ws.getRow(2).getCell(cols["Package No"]).value).toBe("P-DG");
    expect(ws.getRow(2).getCell(cols["DG (Yes/No)"]).value).toBe("Yes");
    // Row 3 = P-SAFE's one item row — no DG tag anywhere on it.
    expect(ws.getRow(3).getCell(cols["Package No"]).value).toBe("P-SAFE");
    expect(ws.getRow(3).getCell(cols["DG (Yes/No)"]).value).toBe("No");
  });

  it("closes the sheet with a TOTAL row: distinct package count, Σ gross, Σ volume (not per-item)", async () => {
    const { queryId } = await freshQuery();
    const cargo = await addCargo(queryId, { dimUnit: "CM", weightUnit: "KG" }).expect(201);
    const p1 = await addPackage(queryId, cargo.body.id, {
      packageNo: "P-1",
      packageType: "PALLET",
      dimL: 120,
      dimW: 100,
      dimH: 140,
      grossWt: 420,
    }).expect(201);
    // Two items on the SAME package — gross/volume must be summed ONCE for this package, not
    // once per item (that would double-count to 840/3.36 instead of 420/1.68).
    await addItem(queryId, cargo.body.id, p1.body.id, { product: "A", qty: 1, uom: "PC" }).expect(
      201,
    );
    await addItem(queryId, cargo.body.id, p1.body.id, { product: "B", qty: 2, uom: "PC" }).expect(
      201,
    );
    // A second package with no items — contributes to the package count / gross / volume sums
    // via its single blank-item row, same as any other package.
    await addPackage(queryId, cargo.body.id, {
      packageNo: "P-2",
      packageType: "BOX",
      dimL: 100,
      dimW: 50,
      dimH: 40,
      grossWt: 30,
    }).expect(201);

    const res = await exportXlsx(queryId).expect(201);
    const wb = await loadWorkbook(res.body);
    const ws = wb.getWorksheet("Packing List")!;
    const cols = headerIndex(ws);

    // 1 header + 2 item-rows (P-1) + 1 blank-item row (P-2) + 1 totals row.
    expect(ws.rowCount).toBe(5);
    const totalsRow = ws.getRow(ws.rowCount);
    expect(totalsRow.getCell(cols["Package No"]).value).toBe("TOTAL");
    expect(totalsRow.getCell(cols["Package Type"]).value).toBe(2); // distinct package count
    expect(Number(totalsRow.getCell(cols["Gross Wt (kg)"]).value)).toBeCloseTo(450, 3); // 420+30
    expect(Number(totalsRow.getCell(cols["Volume (CBM)"]).value)).toBeCloseTo(1.88, 4); // 1.68+0.20
  });
});
