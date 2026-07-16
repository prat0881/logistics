import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Health DB (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it("GET /api/health/db → 200 { db: 'ok' } when Postgres reachable", async () => {
    const res = await request(app.getHttpServer()).get("/api/health/db");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("ok");
  });
});
