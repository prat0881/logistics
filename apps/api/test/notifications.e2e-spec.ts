import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
const PFX = "p7-notif-";

const U1 = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

describe("Notifications (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let u1Ids: string[];
  let u1NotifId: string;
  let u2NotifId: string;

  const cookie = (sub: string) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub, role: Role.EXECUTIVE, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);

    // Clean up any leftover rows from previous runs
    await prisma.notification.deleteMany({
      where: { recipientUserId: { in: [U1, U2] } },
    });

    // Seed: 2 unread for U1, 1 unread for U2
    const [n1a, n1b] = await Promise.all([
      prisma.notification.create({
        data: {
          recipientUserId: U1,
          type: "ESCALATION",
          message: `${PFX}u1-a`,
        },
      }),
      prisma.notification.create({
        data: {
          recipientUserId: U1,
          type: "ESCALATION",
          message: `${PFX}u1-b`,
        },
      }),
    ]);
    const n2 = await prisma.notification.create({
      data: {
        recipientUserId: U2,
        type: "ESCALATION",
        message: `${PFX}u2-a`,
      },
    });

    u1Ids = [n1a.id, n1b.id];
    u1NotifId = n1a.id;
    u2NotifId = n2.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientUserId: { in: [U1, U2] } },
    });
    await app.close();
  });

  it("lists + counts only the caller's unread notifications", async () => {
    // U1 should see count=2
    const count = await request(app.getHttpServer())
      .get("/api/notifications/unread-count")
      .set("Cookie", cookie(U1))
      .expect(200);
    expect(count.body.count).toBe(2);

    // U1's list should only contain U1's notification IDs
    const list = await request(app.getHttpServer())
      .get("/api/notifications")
      .set("Cookie", cookie(U1))
      .expect(200);
    expect(list.body.length).toBe(2);
    expect(list.body.every((n: { id: string }) => u1Ids.includes(n.id))).toBe(true);
  });

  it("marks a notification read (self-scoped) and 404s another user's", async () => {
    // U1 can mark their own notification read
    await request(app.getHttpServer())
      .patch(`/api/notifications/${u1NotifId}/read`)
      .set("Cookie", cookie(U1))
      .expect(200);

    // U1 cannot mark U2's notification read → 404
    await request(app.getHttpServer())
      .patch(`/api/notifications/${u2NotifId}/read`)
      .set("Cookie", cookie(U1))
      .expect(404);
  });
});
