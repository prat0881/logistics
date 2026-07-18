process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.UPLOADS_DIR = mkdtempSync(join(tmpdir(), "svyft-uploads-"));

import { BadRequestException, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { FilesService } from "../src/modules/files/files.service";

const PFX = "p4-files-";

describe("FilesService (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let files: FilesService;
  let queryId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    files = moduleRef.get(FilesService);
    const q = await prisma.query.create({ data: { queryCode: `Z${Date.now()}`.slice(0, 12), shipmentDescription: `${PFX}q` } });
    queryId = q.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("stores a PDF on disk and records a FileAsset", async () => {
    const buffer = Buffer.from("%PDF-1.4\n%mock pdf\n");
    const asset = await files.storeMsds(queryId, { originalname: "msds.pdf", mimetype: "application/pdf", size: buffer.length, buffer }, null);
    expect(asset.kind).toBe("MSDS");
    expect(asset.mime).toBe("application/pdf");
    expect(existsSync(join(process.env.UPLOADS_DIR!, asset.storageKey))).toBe(true);
    expect(readFileSync(join(process.env.UPLOADS_DIR!, asset.storageKey)).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("rejects a non-PDF (mime or magic bytes)", async () => {
    await expect(
      files.storeMsds(queryId, { originalname: "x.png", mimetype: "image/png", size: 3, buffer: Buffer.from("PNG") }, null),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      files.storeMsds(queryId, { originalname: "fake.pdf", mimetype: "application/pdf", size: 3, buffer: Buffer.from("JPG") }, null),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
