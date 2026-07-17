# Stage 3 — Plan 2: Masters & Reference Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Client Master (+ contacts), Vessel Master, and admin-maintained reference data (freight-density factors + checklist definition) — the lookup sources the Create-Query wizard will consume — with a minimal Masters UI, all governed by the Plan 1 roles guard. Per Technical Design §4.2 (data model), §5.2 (APIs), and Functional Spec §7.1/§7.5/§8.6.

**Architecture:** Three new NestJS domain modules — `clients`, `vessels`, `config` — each exposing a service + REST controller, built on the Plan 1 foundation (global `JwtAuthGuard`+`RolesGuard`, `@Roles()`/`@Public()`/`@CurrentUser()`, `ZodValidationPipe`, `PrismaService`). Read routes are authenticated-any-role (Executives look these up when building queries); create/update require `@Roles(ADMINISTRATOR, MANAGER)`; config edits require `@Roles(ADMINISTRATOR)`. `clientCode`/`vesselCode` are server-minted (`CL-0001`/`VS-0001`) via an atomic `CodeSequence` row. Validation schemas + enums live in the isomorphic `@svyft/shared` and are reused by the web forms (React Hook Form + Zod) — the first plan to wire the web app to `@svyft/shared`. Reference data (3 density factors, 9 checklist items) is seeded idempotently alongside the Plan 1 user seed.

**Tech Stack:** NestJS 10 · Prisma 5 / PostgreSQL · `zod` (shared) · React 18 + `react-router-dom` 6 · `react-hook-form` + `@hookform/resolvers` · TanStack Query · Vitest / Jest + supertest.

## Global Constraints

- Node `>=20 <21`; pnpm `9.x`; TypeScript `^5.6`, `strict`. Prettier: double quotes, semicolons, `trailingComma: all`, `printWidth: 100`. All api tests use the `*.e2e-spec.ts` suffix (the jest `testRegex`) and boot against the local dev Postgres (port **5433** on this machine; `apps/api/.env` already points there and holds `JWT_ACCESS_SECRET`).
- **New dependencies:** web — `react-hook-form@^7.53.0`, `@hookform/resolvers@^3.9.0`, `@svyft/shared` (`workspace:*`). No new api deps (reuses Plan 1's `zod`, guards, pipe).
- **Reuse, do not reinvent (from Plan 1):** guards + decorators at `apps/api/src/modules/auth/` (`@Roles(...Role[])`, `@Public()`, `@CurrentUser()`), `ZodValidationPipe` at `apps/api/src/common/zod-validation.pipe.ts`, `PrismaService` (global), `Role`/cookie contracts + the `AuthProvider`/`useAuth`/`ProtectedRoute` web auth. Enums in `@svyft/shared` follow the Plan 1 `Role` pattern (`const` object + string-union type).
- **RBAC (locked):** GET/list/read = authenticated, no `@Roles()`. `POST`/`PATCH`/`DELETE` on clients + vessels = `@Roles(Role.ADMINISTRATOR, Role.MANAGER)`. All `config` writes = `@Roles(Role.ADMINISTRATOR)`. The web hides write controls by `useAuth().user.role`, but the **server guard is the real gate** (verified by e2e 403 tests).
- **Codes (O-T1 resolved):** `clientCode` = `CL-` + 4-digit zero-padded; `vesselCode` = `VS-` + 4-digit. Minted server-side inside the create transaction from a `CodeSequence` row (seeded to 0). Immutable. Never client-supplied.
- **Data rules (from spec):** `Client.companyName` unique + `clientCode` unique; `Vessel.vesselCode` unique + `imoNumber` unique (nullable — optional field; 7 digits when present) with duplicate cross-check; `status` ACTIVE/INACTIVE defaults ACTIVE (INACTIVE hides from wizard lookup later — no hard delete of clients/vessels); one primary contact per client (setting a contact primary clears the others). Duplicate unique-key writes → `409 Conflict`; invalid body → `400` (ZodValidationPipe); missing resource → `404`.
- **Density seeds (spec §8.6):** ROAD 333, AIR 167, SEA 1000 kg/CBM. **Checklist seeds (spec §7.5):** the 9 items in order; item 5 (MSDS received) is `dgConditional: true`.
- **Migrations:** second migration (`masters_config`). CI applies via `prisma migrate deploy`; prod applies on deploy (now `--force-recreate`, from the CD fix). Run `prisma migrate dev` against **local** Postgres only.
- Commit messages: Conventional Commits. Branch `feat/plan-2-masters` (off `main`); plan doc + implementation ship as one PR.

---

### Task 1: Prisma schema — masters + config models, enums, `CodeSequence`, migration #2

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_masters_config/migration.sql` (generated)
- Test: `apps/api/test/masters-model.e2e-spec.ts`

**Interfaces:**
- Produces enums `MasterStatus { ACTIVE, INACTIVE }`, `VesselType { CONTAINER, BULK_CARRIER, TANKER, RORO, GENERAL_CARGO, REEFER, OTHER }`, `FreightMode { ROAD, AIR, SEA }`; models `Client`, `ClientContact`, `Vessel`, `FreightDensityFactor`, `ChecklistDefinition`, `CodeSequence` (all with nullable `tenantId` except `CodeSequence`). Consumed by Tasks 3–8 via the generated client.

- [ ] **Step 1: Write the failing test**

`apps/api/test/masters-model.e2e-spec.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const CODE = "CL-TEST-1";
const CO = "Masters Model Test Co";

describe("Masters models (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.client.deleteMany({ where: { companyName: CO } });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { companyName: CO } });
    await app.close();
  });

  it("creates a client with a cascade-deleting contact and status default ACTIVE", async () => {
    const client = await prisma.client.create({
      data: {
        clientCode: CODE,
        companyName: CO,
        country: "IN",
        contacts: { create: { name: "Primary POC", isPrimary: true } },
      },
      include: { contacts: true },
    });
    expect(client.status).toBe("ACTIVE");
    expect(client.contacts).toHaveLength(1);

    await prisma.client.delete({ where: { id: client.id } });
    const orphans = await prisma.clientContact.findMany({ where: { clientId: client.id } });
    expect(orphans).toHaveLength(0); // onDelete: Cascade
  });

  it("enforces unique companyName", async () => {
    await prisma.client.create({ data: { clientCode: "CL-TEST-2", companyName: CO, country: "IN" } });
    await expect(
      prisma.client.create({ data: { clientCode: "CL-TEST-3", companyName: CO, country: "IN" } }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test -- test/masters-model.e2e-spec.ts`
Expected: FAIL — `prisma.client` model does not exist yet.

- [ ] **Step 3: Add models + enums to `prisma/schema.prisma`**

Append (leave existing `generator`/`datasource`/`Role`/`User`/`RefreshToken` untouched):
```prisma
enum MasterStatus {
  ACTIVE
  INACTIVE
}

enum VesselType {
  CONTAINER
  BULK_CARRIER
  TANKER
  RORO
  GENERAL_CARGO
  REEFER
  OTHER
}

enum FreightMode {
  ROAD
  AIR
  SEA
}

model Client {
  id          String          @id @default(uuid()) @db.Uuid
  tenantId    String?         @db.Uuid
  clientCode  String          @unique
  companyName String          @unique
  industry    String?
  country     String
  status      MasterStatus    @default(ACTIVE)
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt
  contacts    ClientContact[]

  @@index([tenantId])
}

model ClientContact {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String?  @db.Uuid
  clientId    String   @db.Uuid
  client      Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  name        String
  designation String?
  contactNo   String?
  email       String?
  isPrimary   Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([clientId])
}

model Vessel {
  id           String       @id @default(uuid()) @db.Uuid
  tenantId     String?      @db.Uuid
  vesselCode   String       @unique
  name         String
  imoNumber    String?      @unique
  shippingLine String?
  vesselType   VesselType
  status       MasterStatus @default(ACTIVE)
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt

  @@index([tenantId])
}

model FreightDensityFactor {
  id        String      @id @default(uuid()) @db.Uuid
  tenantId  String?     @db.Uuid
  mode      FreightMode @unique
  kgPerCbm  Int
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
}

model ChecklistDefinition {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String?  @db.Uuid
  itemKey       String   @unique
  label         String
  order         Int
  dgConditional Boolean  @default(false)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

model CodeSequence {
  key        String @id
  lastNumber Int    @default(0)
}
```

- [ ] **Step 4: Create + apply the migration (local Postgres only)**

Run (env exported: `set -a; . apps/api/.env; set +a`):
```
pnpm exec prisma migrate dev --schema prisma/schema.prisma --name masters_config
```
Expected: creates `prisma/migrations/<timestamp>_masters_config/migration.sql`, applies it, regenerates the client with the new models.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @svyft/api test -- test/masters-model.e2e-spec.ts`
Expected: PASS (2 tests). Then `pnpm --filter @svyft/api test` (full suite — Plan 1 specs must still pass) and `typecheck` + `lint` → exit 0.

- [ ] **Step 6: Verify the migration applies from scratch**

Run: `pnpm exec prisma migrate reset --schema prisma/schema.prisma --force --skip-seed` then `pnpm exec prisma migrate deploy --schema prisma/schema.prisma`
Expected: both migrations (`init_auth`, `masters_config`) apply cleanly, exit 0. Re-run Step 5 → PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma apps/api/test/masters-model.e2e-spec.ts
git commit -m "feat(db): add Client/Vessel/config masters models and migration (masters_config)"
```

---

### Task 2: `@svyft/shared` — masters + config contracts (enums, Zod schemas, DTO types)

**Files:**
- Create: `packages/shared/src/masters.ts`, `packages/shared/src/config.ts`
- Modify: `packages/shared/src/index.ts` (re-export)
- Test: `packages/shared/src/masters.test.ts`

**Interfaces:**
- Produces (values match the Prisma enums exactly): `MasterStatus`, `MASTER_STATUSES`; `VesselType`, `VESSEL_TYPES`; `FreightMode`, `FREIGHT_MODES` (const-object + string-union, like Plan 1's `Role`). Zod: `clientCreateSchema`, `clientUpdateSchema` (`.partial()`), `contactCreateSchema`, `contactUpdateSchema`, `vesselCreateSchema`, `vesselUpdateSchema`, `densityFactorUpdateSchema`, `checklistItemUpdateSchema` + their `z.infer` input types. DTO types `ClientDto`, `ContactDto`, `VesselDto`, `DensityFactorDto`, `ChecklistItemDto`, and a generic `Paginated<T> = { items: T[]; total: number; page: number; pageSize: number }`. Consumed by the api (pipe validation + response typing) and the web forms.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/masters.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { clientCreateSchema, vesselCreateSchema, VESSEL_TYPES, MASTER_STATUSES } from "./masters";

describe("masters schemas", () => {
  it("accepts a valid client (no code — server-minted)", () => {
    expect(clientCreateSchema.safeParse({ companyName: "Acme", country: "IN" }).success).toBe(true);
  });
  it("rejects a client with no companyName", () => {
    expect(clientCreateSchema.safeParse({ country: "IN" }).success).toBe(false);
  });
  it("accepts a vessel with a 7-digit IMO", () => {
    expect(
      vesselCreateSchema.safeParse({ name: "MV Test", vesselType: "CONTAINER", imoNumber: "1234567" }).success,
    ).toBe(true);
  });
  it("rejects a non-7-digit IMO", () => {
    expect(
      vesselCreateSchema.safeParse({ name: "MV Test", vesselType: "CONTAINER", imoNumber: "12" }).success,
    ).toBe(false);
  });
  it("rejects an unknown vessel type", () => {
    expect(vesselCreateSchema.safeParse({ name: "X", vesselType: "SUBMARINE" }).success).toBe(false);
  });
  it("exposes the enum value lists", () => {
    expect(VESSEL_TYPES).toContain("CONTAINER");
    expect(MASTER_STATUSES).toEqual(["ACTIVE", "INACTIVE"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared test` → FAIL (cannot resolve `./masters`).

- [ ] **Step 3: Implement `masters.ts`**

`packages/shared/src/masters.ts`:
```ts
import { z } from "zod";

export const MasterStatus = { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" } as const;
export type MasterStatus = (typeof MasterStatus)[keyof typeof MasterStatus];
export const MASTER_STATUSES: MasterStatus[] = [MasterStatus.ACTIVE, MasterStatus.INACTIVE];

export const VesselType = {
  CONTAINER: "CONTAINER",
  BULK_CARRIER: "BULK_CARRIER",
  TANKER: "TANKER",
  RORO: "RORO",
  GENERAL_CARGO: "GENERAL_CARGO",
  REEFER: "REEFER",
  OTHER: "OTHER",
} as const;
export type VesselType = (typeof VesselType)[keyof typeof VesselType];
export const VESSEL_TYPES = Object.values(VesselType) as [VesselType, ...VesselType[]];

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

export const clientCreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  industry: z.string().max(120).optional(),
  country: z.string().min(1).max(120),
  status: statusField,
});
export const clientUpdateSchema = clientCreateSchema.partial();
export type ClientCreateInput = z.infer<typeof clientCreateSchema>;
export type ClientUpdateInput = z.infer<typeof clientUpdateSchema>;

export const contactCreateSchema = z.object({
  name: z.string().min(1).max(160),
  designation: z.string().max(120).optional(),
  contactNo: z.string().max(40).optional(),
  email: z.string().email().optional(),
  isPrimary: z.boolean().optional(),
});
export const contactUpdateSchema = contactCreateSchema.partial();
export type ContactCreateInput = z.infer<typeof contactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

export const vesselCreateSchema = z.object({
  name: z.string().min(1).max(200),
  imoNumber: z
    .string()
    .regex(/^\d{7}$/, "IMO must be 7 digits")
    .optional(),
  shippingLine: z.string().max(160).optional(),
  vesselType: z.enum(VESSEL_TYPES),
  status: statusField,
});
export const vesselUpdateSchema = vesselCreateSchema.partial();
export type VesselCreateInput = z.infer<typeof vesselCreateSchema>;
export type VesselUpdateInput = z.infer<typeof vesselUpdateSchema>;

export interface ContactDto {
  id: string;
  name: string;
  designation: string | null;
  contactNo: string | null;
  email: string | null;
  isPrimary: boolean;
}
export interface ClientDto {
  id: string;
  clientCode: string;
  companyName: string;
  industry: string | null;
  country: string;
  status: MasterStatus;
  contacts?: ContactDto[];
}
export interface VesselDto {
  id: string;
  vesselCode: string;
  name: string;
  imoNumber: string | null;
  shippingLine: string | null;
  vesselType: VesselType;
  status: MasterStatus;
}
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
```

- [ ] **Step 4: Implement `config.ts`**

`packages/shared/src/config.ts`:
```ts
import { z } from "zod";

export const FreightMode = { ROAD: "ROAD", AIR: "AIR", SEA: "SEA" } as const;
export type FreightMode = (typeof FreightMode)[keyof typeof FreightMode];
export const FREIGHT_MODES = Object.values(FreightMode) as [FreightMode, ...FreightMode[]];

export const densityFactorUpdateSchema = z.object({ kgPerCbm: z.number().int().positive() });
export type DensityFactorUpdateInput = z.infer<typeof densityFactorUpdateSchema>;

export const checklistItemUpdateSchema = z
  .object({
    label: z.string().min(1).max(200),
    order: z.number().int().min(0),
    dgConditional: z.boolean(),
  })
  .partial();
export type ChecklistItemUpdateInput = z.infer<typeof checklistItemUpdateSchema>;

export interface DensityFactorDto {
  mode: FreightMode;
  kgPerCbm: number;
}
export interface ChecklistItemDto {
  itemKey: string;
  label: string;
  order: number;
  dgConditional: boolean;
}
```

- [ ] **Step 5: Re-export + run test**

Add to `packages/shared/src/index.ts`:
```ts
export * from "./masters";
export * from "./config";
```
Run: `pnpm --filter @svyft/shared test` → PASS. Then `pnpm --filter @svyft/shared build` + `lint` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add Client/Vessel/config schemas, enums, and DTO types"
```

---

### Task 3: Code generation — `CodeSequenceService` (`CL-0001` / `VS-0001`)

**Files:**
- Create: `apps/api/src/common/code-sequence.service.ts`, `apps/api/src/common/code-sequence.module.ts`
- Modify: `apps/api/src/app.module.ts` (register the module)
- Test: `apps/api/test/code-sequence.e2e-spec.ts`

**Interfaces:**
- Produces `@Injectable() CodeSequenceService` with `next(key: string, prefix: string): Promise<string>` — atomically increments the `CodeSequence` row for `key` and returns `PREFIX-NNNN` (4-digit zero-padded). Exported by a `@Global() CodeSequenceModule`. Consumed by `ClientsService` (`next("CLIENT", "CL")`) and `VesselsService` (`next("VESSEL", "VS")`). Relies on the `CodeSequence` rows existing (seeded in Task 6) — throws if the key row is absent.

- [ ] **Step 1: Write the failing test**

`apps/api/test/code-sequence.e2e-spec.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { CodeSequenceService } from "../src/common/code-sequence.service";

const KEY = "TEST_SEQ";

describe("CodeSequenceService (integration)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seq: CodeSequenceService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    seq = moduleRef.get(CodeSequenceService);
    await prisma.codeSequence.upsert({ where: { key: KEY }, create: { key: KEY, lastNumber: 0 }, update: { lastNumber: 0 } });
  });

  afterAll(async () => {
    await prisma.codeSequence.deleteMany({ where: { key: KEY } });
    await app.close();
  });

  it("mints sequential zero-padded codes", async () => {
    expect(await seq.next(KEY, "TS")).toBe("TS-0001");
    expect(await seq.next(KEY, "TS")).toBe("TS-0002");
  });

  it("mints unique codes under concurrency (atomic increment)", async () => {
    const codes = await Promise.all(Array.from({ length: 10 }, () => seq.next(KEY, "TS")));
    expect(new Set(codes).size).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test -- test/code-sequence.e2e-spec.ts` → FAIL (cannot resolve `code-sequence.service`).

- [ ] **Step 3: Implement the service + module**

`apps/api/src/common/code-sequence.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CodeSequenceService {
  constructor(private readonly prisma: PrismaService) {}

  async next(key: string, prefix: string): Promise<string> {
    const row = await this.prisma.codeSequence.update({
      where: { key },
      data: { lastNumber: { increment: 1 } },
    });
    return `${prefix}-${String(row.lastNumber).padStart(4, "0")}`;
  }
}
```
`apps/api/src/common/code-sequence.module.ts`:
```ts
import { Global, Module } from "@nestjs/common";
import { CodeSequenceService } from "./code-sequence.service";

@Global()
@Module({ providers: [CodeSequenceService], exports: [CodeSequenceService] })
export class CodeSequenceModule {}
```
Register in `apps/api/src/app.module.ts` — add `CodeSequenceModule` to `imports` after `AuthModule`:
```ts
import { CodeSequenceModule } from "./common/code-sequence.module";
```
```ts
  imports: [ConfigModule.forRoot({ isGlobal: true }), ...staticImports, PrismaModule, AuthModule, CodeSequenceModule, HealthModule],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/api test -- test/code-sequence.e2e-spec.ts` → PASS (2 tests). Then full api suite + typecheck + lint → green.

> The atomic `UPDATE … SET lastNumber = lastNumber + 1 RETURNING` serializes concurrent callers at the row lock, so no two callers get the same number. The row must exist (seeded in Task 6); a missing key raises Prisma `P2025`, surfaced by the caller.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common/code-sequence.service.ts apps/api/src/common/code-sequence.module.ts apps/api/src/app.module.ts apps/api/test/code-sequence.e2e-spec.ts
git commit -m "feat(api): add CodeSequenceService for CL-/VS- master codes"
```

---

### Task 4: Clients module — CRUD + contacts + search/paginate + RBAC

**Files:**
- Create: `apps/api/src/modules/clients/clients.service.ts`, `clients.controller.ts`, `clients.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `ClientsModule`)
- Test: `apps/api/test/clients.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `CodeSequenceService` (Task 3), `ZodValidationPipe` + `@Roles`/`Role`/`@CurrentUser` (Plan 1), `clientCreateSchema`/`clientUpdateSchema`/`contactCreateSchema`/`contactUpdateSchema`/`ClientDto`/`Paginated` (Task 2).
- Produces endpoints: `GET /api/clients` (search `q`, `status`, `page`, `pageSize` → `Paginated<ClientDto>`, authenticated), `POST /api/clients` (Admin/Manager → mints `clientCode`), `GET /api/clients/:id` (with contacts), `PATCH /api/clients/:id` (Admin/Manager), `GET /api/clients/:id/contacts`, `POST /api/clients/:id/contacts` (Admin/Manager), `PATCH /api/clients/:id/contacts/:contactId` (Admin/Manager), `DELETE /api/clients/:id/contacts/:contactId` (Admin/Manager). Duplicate `companyName` → 409; missing → 404; setting a contact `isPrimary` clears the others.

- [ ] **Step 1: Write the failing test** (drives CRUD, RBAC 403, duplicate 409, primary-contact, pagination)

`apps/api/test/clients.e2e-spec.ts`:
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const CO = "Clients E2E Co";

describe("Clients (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    // CodeSequence row for CLIENT must exist (seeded in prod; ensure here for the test DB)
    await prisma.codeSequence.upsert({ where: { key: "CLIENT" }, create: { key: "CLIENT", lastNumber: 0 }, update: {} });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: CO } } });
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { companyName: { startsWith: CO } } });
    await app.close();
  });

  it("401s an unauthenticated read", async () => {
    await request(app.getHttpServer()).get("/api/clients").expect(401);
  });

  it("403s an Executive trying to create", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ companyName: `${CO} X`, country: "IN" })
      .expect(403);
  });

  it("lets a Manager create (mints CL- code), and any role read it", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ companyName: CO, country: "IN", industry: "Logistics" })
      .expect(201);
    expect(created.body.clientCode).toMatch(/^CL-\d{4}$/);
    const id = created.body.id;

    const read = await request(app.getHttpServer())
      .get(`/api/clients/${id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(read.body.companyName).toBe(CO);
  });

  it("409s a duplicate companyName", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ companyName: CO, country: "IN" })
      .expect(409);
  });

  it("adds contacts and keeps a single primary", async () => {
    const c = await prisma.client.findFirst({ where: { companyName: CO } });
    const id = c!.id;
    await request(app.getHttpServer())
      .post(`/api/clients/${id}/contacts`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({ name: "First", isPrimary: true })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/clients/${id}/contacts`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({ name: "Second", isPrimary: true })
      .expect(201);
    const primaries = await prisma.clientContact.findMany({ where: { clientId: id, isPrimary: true } });
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe("Second");
  });

  it("searches + paginates", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/clients?q=Clients%20E2E&page=1&pageSize=10")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items.some((c: { companyName: string }) => c.companyName === CO)).toBe(true);
  });

  it("400s an invalid body", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ country: "IN" })
      .expect(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test -- test/clients.e2e-spec.ts` → FAIL (routes 404 / module missing).

- [ ] **Step 3: Implement `ClientsService`**

`apps/api/src/modules/clients/clients.service.ts`:
```ts
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ClientCreateInput,
  ClientUpdateInput,
  ContactCreateInput,
  ContactUpdateInput,
  Paginated,
} from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { CodeSequenceService } from "../../common/code-sequence.service";

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeSequenceService,
  ) {}

  async list(params: { q?: string; status?: string; page: number; pageSize: number }): Promise<Paginated<unknown>> {
    const where: Prisma.ClientWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { companyName: { contains: params.q, mode: "insensitive" } },
              { clientCode: { contains: params.q, mode: "insensitive" } },
              { country: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.client.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.client.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async get(id: string) {
    const client = await this.prisma.client.findUnique({ where: { id }, include: { contacts: true } });
    if (!client) throw new NotFoundException("Client not found");
    return client;
  }

  async create(input: ClientCreateInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.update({ where: { key: "CLIENT" }, data: { lastNumber: { increment: 1 } } });
        const clientCode = `CL-${String(row.lastNumber).padStart(4, "0")}`;
        return tx.client.create({ data: { clientCode, ...input } });
      });
    } catch (e) {
      throw this.mapUnique(e, "A client with that company name already exists");
    }
  }

  async update(id: string, input: ClientUpdateInput) {
    await this.get(id);
    try {
      return await this.prisma.client.update({ where: { id }, data: input });
    } catch (e) {
      throw this.mapUnique(e, "A client with that company name already exists");
    }
  }

  async listContacts(clientId: string) {
    await this.get(clientId);
    return this.prisma.clientContact.findMany({ where: { clientId }, orderBy: { createdAt: "asc" } });
  }

  async addContact(clientId: string, input: ContactCreateInput) {
    await this.get(clientId);
    return this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.clientContact.updateMany({ where: { clientId, isPrimary: true }, data: { isPrimary: false } });
      }
      return tx.clientContact.create({ data: { clientId, ...input } });
    });
  }

  async updateContact(clientId: string, contactId: string, input: ContactUpdateInput) {
    const existing = await this.prisma.clientContact.findFirst({ where: { id: contactId, clientId } });
    if (!existing) throw new NotFoundException("Contact not found");
    return this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.clientContact.updateMany({
          where: { clientId, isPrimary: true, NOT: { id: contactId } },
          data: { isPrimary: false },
        });
      }
      return tx.clientContact.update({ where: { id: contactId }, data: input });
    });
  }

  async removeContact(clientId: string, contactId: string) {
    const existing = await this.prisma.clientContact.findFirst({ where: { id: contactId, clientId } });
    if (!existing) throw new NotFoundException("Contact not found");
    await this.prisma.clientContact.delete({ where: { id: contactId } });
  }

  private mapUnique(e: unknown, msg: string): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new ConflictException(msg);
    }
    return e;
  }
}
```

- [ ] **Step 4: Implement `ClientsController`**

`apps/api/src/modules/clients/clients.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import {
  clientCreateSchema,
  clientUpdateSchema,
  contactCreateSchema,
  contactUpdateSchema,
} from "@svyft/shared";
import type { ClientCreateInput, ClientUpdateInput, ContactCreateInput, ContactUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { Role } from "@svyft/shared";
import { ClientsService } from "./clients.service";

@Controller("clients")
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
  ) {
    return this.clients.list({ q, status, page: Number(page) || 1, pageSize: Math.min(Number(pageSize) || 20, 100) });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.clients.get(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  @UsePipes(new ZodValidationPipe(clientCreateSchema))
  create(@Body() body: ClientCreateInput) {
    return this.clients.create(body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  @UsePipes(new ZodValidationPipe(clientUpdateSchema))
  update(@Param("id") id: string, @Body() body: ClientUpdateInput) {
    return this.clients.update(id, body);
  }

  @Get(":id/contacts")
  listContacts(@Param("id") id: string) {
    return this.clients.listContacts(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post(":id/contacts")
  @UsePipes(new ZodValidationPipe(contactCreateSchema))
  addContact(@Param("id") id: string, @Body() body: ContactCreateInput) {
    return this.clients.addContact(id, body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id/contacts/:contactId")
  @UsePipes(new ZodValidationPipe(contactUpdateSchema))
  updateContact(
    @Param("id") id: string,
    @Param("contactId") contactId: string,
    @Body() body: ContactUpdateInput,
  ) {
    return this.clients.updateContact(id, contactId, body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Delete(":id/contacts/:contactId")
  @HttpCode(204)
  async removeContact(@Param("id") id: string, @Param("contactId") contactId: string) {
    await this.clients.removeContact(id, contactId);
  }
}
```
> `@UsePipes(new ZodValidationPipe(schema))` validates the body; `@Roles(...)` is enforced by the global `RolesGuard` from Plan 1. The `@Get` routes carry no `@Roles`, so they're authenticated-any-role. `POST` returns 201 (Nest default); the create-contact `POST` too.

- [ ] **Step 5: Wire `ClientsModule`**

`apps/api/src/modules/clients/clients.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { ClientsService } from "./clients.service";
import { ClientsController } from "./clients.controller";

@Module({ controllers: [ClientsController], providers: [ClientsService] })
export class ClientsModule {}
```
Add `ClientsModule` to `apps/api/src/app.module.ts` imports (after `CodeSequenceModule`). `PrismaService` + `CodeSequenceService` are global, so no extra imports needed.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @svyft/api test -- test/clients.e2e-spec.ts` → PASS (all cases incl. 401/403/409/400 + primary-contact + pagination). Then full api suite + typecheck + lint → green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/clients apps/api/src/app.module.ts apps/api/test/clients.e2e-spec.ts
git commit -m "feat(api): add Clients master (CRUD + contacts + search) with Admin/Manager RBAC"
```

---

### Task 5: Vessels module — CRUD + IMO duplicate check + search + RBAC

**Files:**
- Create: `apps/api/src/modules/vessels/vessels.service.ts`, `vessels.controller.ts`, `vessels.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `VesselsModule`)
- Test: `apps/api/test/vessels.e2e-spec.ts`

**Interfaces:**
- Mirrors Clients (Task 4) without contacts. `GET /api/vessels` (search `q`, `status`, page/pageSize → `Paginated<VesselDto>`, authenticated), `POST` (Admin/Manager → mints `VS-` code), `GET /:id`, `PATCH /:id` (Admin/Manager). Duplicate `imoNumber` → 409; missing → 404. Uses `vesselCreateSchema`/`vesselUpdateSchema` (Task 2) + `CodeSequenceService.next("VESSEL", "VS")`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/vessels.e2e-spec.ts` (same harness shape as `clients.e2e-spec.ts` — copy the `beforeAll`/`afterAll`/`cookie()` setup, seed the `VESSEL` CodeSequence row, use a `MV Vessels E2E` name prefix):
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const NAME = "MV Vessels E2E";
const IMO = "9999001";

describe("Vessels (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const cookie = (role: Role) => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await prisma.codeSequence.upsert({ where: { key: "VESSEL" }, create: { key: "VESSEL", lastNumber: 0 }, update: {} });
    await prisma.vessel.deleteMany({ where: { OR: [{ name: { startsWith: NAME } }, { imoNumber: IMO }] } });
  });

  afterAll(async () => {
    await prisma.vessel.deleteMany({ where: { OR: [{ name: { startsWith: NAME } }, { imoNumber: IMO }] } });
    await app.close();
  });

  it("401s unauthenticated read; 403s Executive create", async () => {
    await request(app.getHttpServer()).get("/api/vessels").expect(401);
    await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ name: NAME, vesselType: "CONTAINER" })
      .expect(403);
  });

  it("Admin creates (mints VS- code); duplicate IMO → 409", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: NAME, vesselType: "CONTAINER", imoNumber: IMO, shippingLine: "Maersk" })
      .expect(201);
    expect(res.body.vesselCode).toMatch(/^VS-\d{4}$/);

    await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: `${NAME} 2`, vesselType: "TANKER", imoNumber: IMO })
      .expect(409);
  });

  it("rejects a bad IMO (400) and searches (200)", async () => {
    await request(app.getHttpServer())
      .post("/api/vessels")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ name: NAME, vesselType: "CONTAINER", imoNumber: "12" })
      .expect(400);
    const res = await request(app.getHttpServer())
      .get("/api/vessels?q=Vessels%20E2E")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @svyft/api test -- test/vessels.e2e-spec.ts` → FAIL (404 / module missing).

- [ ] **Step 3: Implement `VesselsService`**

`apps/api/src/modules/vessels/vessels.service.ts`:
```ts
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Paginated, VesselCreateInput, VesselUpdateInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class VesselsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { q?: string; status?: string; page: number; pageSize: number }): Promise<Paginated<unknown>> {
    const where: Prisma.VesselWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: "insensitive" } },
              { vesselCode: { contains: params.q, mode: "insensitive" } },
              { imoNumber: { contains: params.q, mode: "insensitive" } },
              { shippingLine: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.vessel.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.vessel.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async get(id: string) {
    const vessel = await this.prisma.vessel.findUnique({ where: { id } });
    if (!vessel) throw new NotFoundException("Vessel not found");
    return vessel;
  }

  async create(input: VesselCreateInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.update({ where: { key: "VESSEL" }, data: { lastNumber: { increment: 1 } } });
        const vesselCode = `VS-${String(row.lastNumber).padStart(4, "0")}`;
        return tx.vessel.create({ data: { vesselCode, ...input } });
      });
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  async update(id: string, input: VesselUpdateInput) {
    await this.get(id);
    try {
      return await this.prisma.vessel.update({ where: { id }, data: input });
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  private mapUnique(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new ConflictException("A vessel with that IMO number already exists");
    }
    return e;
  }
}
```

- [ ] **Step 4: Implement `VesselsController` + module**

`apps/api/src/modules/vessels/vessels.controller.ts`:
```ts
import { Body, Controller, Get, Param, Patch, Post, Query, UsePipes } from "@nestjs/common";
import { Role, vesselCreateSchema, vesselUpdateSchema } from "@svyft/shared";
import type { VesselCreateInput, VesselUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { VesselsService } from "./vessels.service";

@Controller("vessels")
export class VesselsController {
  constructor(private readonly vessels: VesselsService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
  ) {
    return this.vessels.list({ q, status, page: Number(page) || 1, pageSize: Math.min(Number(pageSize) || 20, 100) });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.vessels.get(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  @UsePipes(new ZodValidationPipe(vesselCreateSchema))
  create(@Body() body: VesselCreateInput) {
    return this.vessels.create(body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  @UsePipes(new ZodValidationPipe(vesselUpdateSchema))
  update(@Param("id") id: string, @Body() body: VesselUpdateInput) {
    return this.vessels.update(id, body);
  }
}
```
`apps/api/src/modules/vessels/vessels.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { VesselsService } from "./vessels.service";
import { VesselsController } from "./vessels.controller";

@Module({ controllers: [VesselsController], providers: [VesselsService] })
export class VesselsModule {}
```
Add `VesselsModule` to `apps/api/src/app.module.ts` imports.

- [ ] **Step 5: Run test → PASS**, then full api suite + typecheck + lint → green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/vessels apps/api/src/app.module.ts apps/api/test/vessels.e2e-spec.ts
git commit -m "feat(api): add Vessels master (CRUD + IMO check + search) with Admin/Manager RBAC"
```

---

### Task 6: Config module + reference-data seed

**Files:**
- Create: `apps/api/src/modules/config/config-data.service.ts`, `config-data.controller.ts`, `config-data.module.ts`, `apps/api/src/seed/reference-seed.ts`
- Modify: `apps/api/src/app.module.ts` (import module), `apps/api/src/seed/seed.ts` (call reference seed), `apps/api/src/seed/seed-core.ts` (export the reference seed for the entry) — **or** keep reference seed self-contained and call it from `seed.ts`
- Test: `apps/api/test/config-data.e2e-spec.ts`, `apps/api/test/reference-seed.e2e-spec.ts`

> Naming: the module class is `ConfigDataModule` (not `ConfigModule`) to avoid confusion with `@nestjs/config`'s `ConfigModule` already imported in `AppModule`.

**Interfaces:**
- Produces: `GET /api/config/density-factors` (authenticated → `DensityFactorDto[]`), `PATCH /api/config/density-factors/:mode` (`@Roles(ADMINISTRATOR)`, `densityFactorUpdateSchema`), `GET /api/config/checklist-definition` (authenticated → `ChecklistItemDto[]` ordered), `PATCH /api/config/checklist-definition/:itemKey` (`@Roles(ADMINISTRATOR)`, `checklistItemUpdateSchema`). Produces `seedReferenceData(prisma)`: idempotent upsert of the 3 density factors, 9 checklist items, and the `CodeSequence` rows (`CLIENT`, `VESSEL`).

- [ ] **Step 1: Write the failing tests**

`apps/api/test/config-data.e2e-spec.ts` (harness like clients; seed reference data in `beforeAll`):
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";

describe("Config data (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  const cookie = (role: Role) => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    await app.init();
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(moduleRef.get(PrismaService));
  });

  afterAll(async () => {
    await app.close();
  });

  it("any role reads density factors (seeded ROAD/AIR/SEA)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/config/density-factors")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    const sea = res.body.find((d: { mode: string }) => d.mode === "SEA");
    expect(sea.kgPerCbm).toBe(1000);
  });

  it("only Admin may edit a density factor (Manager → 403, Admin → 200)", async () => {
    await request(app.getHttpServer())
      .patch("/api/config/density-factors/AIR")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ kgPerCbm: 200 })
      .expect(403);
    await request(app.getHttpServer())
      .patch("/api/config/density-factors/AIR")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ kgPerCbm: 200 })
      .expect(200);
  });

  it("reads the 9 checklist items in order", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/config/checklist-definition")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body).toHaveLength(9);
    expect(res.body[0].order).toBeLessThanOrEqual(res.body[8].order);
    expect(res.body.find((i: { itemKey: string }) => i.itemKey === "msds-received").dgConditional).toBe(true);
  });
});
```
`apps/api/test/reference-seed.e2e-spec.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
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
    expect((await prisma.freightDensityFactor.findUnique({ where: { mode: "AIR" } }))!.kgPerCbm).toBe(999); // not overwritten
    expect(await prisma.codeSequence.findUnique({ where: { key: "CLIENT" } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — both FAIL (missing module / `reference-seed`).

- [ ] **Step 3: Implement `seedReferenceData`**

`apps/api/src/seed/reference-seed.ts`:
```ts
import { PrismaClient } from "@prisma/client";

const DENSITY: { mode: "ROAD" | "AIR" | "SEA"; kgPerCbm: number }[] = [
  { mode: "ROAD", kgPerCbm: 333 },
  { mode: "AIR", kgPerCbm: 167 },
  { mode: "SEA", kgPerCbm: 1000 },
];

const CHECKLIST: { itemKey: string; label: string; order: number; dgConditional?: boolean }[] = [
  { itemKey: "weight-confirmed", label: "Weight confirmed", order: 1 },
  { itemKey: "dimensions-confirmed", label: "Dimensions confirmed", order: 2 },
  { itemKey: "hs-code-received", label: "HS / HSN code received", order: 3 },
  { itemKey: "dg-confirmed", label: "DG / Non-DG confirmed", order: 4 },
  { itemKey: "msds-received", label: "MSDS received", order: 5, dgConditional: true },
  { itemKey: "commercial-invoice", label: "Commercial invoice received", order: 6 },
  { itemKey: "packing-list", label: "Packing list received", order: 7 },
  { itemKey: "pickup-address", label: "Pickup address confirmed", order: 8 },
  { itemKey: "delivery-address", label: "Delivery address confirmed", order: 9 },
];

export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const key of ["CLIENT", "VESSEL"]) {
    await prisma.codeSequence.upsert({ where: { key }, create: { key, lastNumber: 0 }, update: {} });
  }
  for (const d of DENSITY) {
    // create-only: never overwrite an admin's edited kg/CBM
    await prisma.freightDensityFactor.upsert({ where: { mode: d.mode }, create: d, update: {} });
  }
  for (const c of CHECKLIST) {
    await prisma.checklistDefinition.upsert({
      where: { itemKey: c.itemKey },
      create: { ...c, dgConditional: c.dgConditional ?? false },
      update: {},
    });
  }
}
```
Wire it into the seed entry — `apps/api/src/seed/seed.ts` (Plan 1) calls `runSeed`; add a `seedReferenceData(prisma)` call alongside:
```ts
import { PrismaClient } from "@prisma/client";
import { runSeed, seedUsersFromEnv } from "./seed-core";
import { seedReferenceData } from "./reference-seed";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runSeed(prisma, seedUsersFromEnv());
    await seedReferenceData(prisma);
    // eslint-disable-next-line no-console
    console.log("Seed complete: users + reference data ensured.");
  } finally {
    await prisma.$disconnect();
  }
}

void main();
```

- [ ] **Step 4: Implement `ConfigDataService` + controller + module**

`apps/api/src/modules/config/config-data.service.ts`:
```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { ChecklistItemUpdateInput, DensityFactorUpdateInput } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class ConfigDataService {
  constructor(private readonly prisma: PrismaService) {}

  densityFactors() {
    return this.prisma.freightDensityFactor.findMany({ orderBy: { mode: "asc" } });
  }

  async updateDensityFactor(mode: string, input: DensityFactorUpdateInput) {
    try {
      return await this.prisma.freightDensityFactor.update({
        where: { mode: mode as never },
        data: input,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new NotFoundException("Unknown freight mode");
      }
      throw e;
    }
  }

  checklist() {
    return this.prisma.checklistDefinition.findMany({ orderBy: { order: "asc" } });
  }

  async updateChecklistItem(itemKey: string, input: ChecklistItemUpdateInput) {
    try {
      return await this.prisma.checklistDefinition.update({ where: { itemKey }, data: input });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new NotFoundException("Unknown checklist item");
      }
      throw e;
    }
  }
}
```
`apps/api/src/modules/config/config-data.controller.ts`:
```ts
import { Body, Controller, Get, Param, Patch, UsePipes } from "@nestjs/common";
import { Role, checklistItemUpdateSchema, densityFactorUpdateSchema } from "@svyft/shared";
import type { ChecklistItemUpdateInput, DensityFactorUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { ConfigDataService } from "./config-data.service";

@Controller("config")
export class ConfigDataController {
  constructor(private readonly config: ConfigDataService) {}

  @Get("density-factors")
  densityFactors() {
    return this.config.densityFactors();
  }

  @Roles(Role.ADMINISTRATOR)
  @Patch("density-factors/:mode")
  @UsePipes(new ZodValidationPipe(densityFactorUpdateSchema))
  updateDensity(@Param("mode") mode: string, @Body() body: DensityFactorUpdateInput) {
    return this.config.updateDensityFactor(mode, body);
  }

  @Get("checklist-definition")
  checklist() {
    return this.config.checklist();
  }

  @Roles(Role.ADMINISTRATOR)
  @Patch("checklist-definition/:itemKey")
  @UsePipes(new ZodValidationPipe(checklistItemUpdateSchema))
  updateChecklist(@Param("itemKey") itemKey: string, @Body() body: ChecklistItemUpdateInput) {
    return this.config.updateChecklistItem(itemKey, body);
  }
}
```
`apps/api/src/modules/config/config-data.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { ConfigDataService } from "./config-data.service";
import { ConfigDataController } from "./config-data.controller";

@Module({ controllers: [ConfigDataController], providers: [ConfigDataService] })
export class ConfigDataModule {}
```
Add `ConfigDataModule` to `apps/api/src/app.module.ts` imports.

- [ ] **Step 5: Run tests → PASS** (config-data + reference-seed), then full api suite + typecheck + lint → green. Run the seed end-to-end (`set -a; . apps/api/.env; set +a; pnpm exec prisma db seed`) → "Seed complete: users + reference data ensured.", re-run → idempotent.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/config apps/api/src/seed apps/api/src/app.module.ts apps/api/test/config-data.e2e-spec.ts apps/api/test/reference-seed.e2e-spec.ts
git commit -m "feat(api): add config module (density/checklist, Admin-only) + reference-data seed"
```

---

### Task 7: Web — app shell/nav, api helpers, and Clients Masters UI (React Hook Form + shared schemas)

**Files:**
- Modify: `apps/web/package.json` (add `react-hook-form`, `@hookform/resolvers`, `@svyft/shared`), `apps/web/src/lib/api.ts` (add `patchJson`, `del`), `apps/web/src/App.tsx` (nested master routes), `apps/web/src/features/home/HomePage.tsx` (link into masters)
- Create: `apps/web/src/components/AppLayout.tsx` (nav shell), `apps/web/src/features/masters/clients/ClientsListPage.tsx`, `ClientFormPage.tsx`, `apps/web/src/features/masters/useMasters.ts` (TanStack Query hooks)
- Test: `apps/web/src/features/masters/clients/ClientsListPage.test.tsx`, `ClientFormPage.test.tsx`

**Interfaces:**
- Consumes the Plan 1 web foundation verbatim (`AuthProvider`/`useAuth`, `ProtectedRoute`, `Button`/`Input`/`Label`, `queryClient`, `src/test/mock-fetch.ts`) and `@svyft/shared` (`clientCreateSchema`, `ClientDto`, `Paginated`, `MASTER_STATUSES`).
- Produces: `AppLayout` (nav: Home · Clients · Vessels · [Config if Admin] · Log out) wrapping protected pages; `/masters/clients` (searchable list, "New" shown to Admin/Manager), `/masters/clients/new` + `/masters/clients/:id` (RHF form → `POST`/`PATCH`). Write controls hidden for Executives (server guard is the real gate).

- [ ] **Step 1: Add deps + api helpers**

Edit `apps/web/package.json` — add to `dependencies`: `"@hookform/resolvers": "^3.9.0"`, `"react-hook-form": "^7.53.0"`, `"@svyft/shared": "workspace:*"`. Run: `pnpm install`, then `pnpm --filter @svyft/shared build` (web resolves `@svyft/shared` from its built `dist`).

Add to `apps/web/src/lib/api.ts`:
```ts
export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function del(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
}
```

- [ ] **Step 2: Write the failing tests**

`apps/web/src/features/masters/clients/ClientsListPage.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ClientsListPage } from "./ClientsListPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderList(role: string) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
      if (url.includes("/api/clients"))
        return {
          status: 200,
          body: { items: [{ id: "c1", clientCode: "CL-0001", companyName: "Acme", country: "IN", status: "ACTIVE" }], total: 1, page: 1, pageSize: 20 },
        };
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter>
          <ClientsListPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("ClientsListPage", () => {
  it("lists clients and shows New for a Manager", async () => {
    renderList("MANAGER");
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    expect(screen.getByText("CL-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new client/i })).toBeInTheDocument();
  });

  it("hides New for an Executive", async () => {
    renderList("EXECUTIVE");
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /new client/i })).not.toBeInTheDocument();
  });
});
```
`apps/web/src/features/masters/clients/ClientFormPage.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ClientFormPage } from "./ClientFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("ClientFormPage (create)", () => {
  it("submits a new client and navigates to the list", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.endsWith("/api/clients") && init?.method === "POST") {
          calls.push("create");
          return { status: 201, body: { id: "c9", clientCode: "CL-0009", companyName: "NewCo", country: "IN", status: "ACTIVE" } };
        }
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/masters/clients/new"]}>
            <Routes>
              <Route path="/masters/clients/new" element={<ClientFormPage />} />
              <Route path="/masters/clients" element={<p>clients list</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/company name/i), "NewCo");
    await userEvent.type(screen.getByLabelText(/country/i), "IN");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("clients list")).toBeInTheDocument());
    expect(calls).toContain("create");
  });
});
```

- [ ] **Step 3: Run tests → FAIL** (components missing).

- [ ] **Step 4: Implement the TanStack Query hooks**

`apps/web/src/features/masters/useMasters.ts`:
```ts
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ClientDto, Paginated, VesselDto } from "@svyft/shared";

export function useClients(q: string) {
  return useQuery({
    queryKey: ["clients", q],
    queryFn: () => fetchJson<Paginated<ClientDto>>(`/api/clients?q=${encodeURIComponent(q)}`),
  });
}
export function useClient(id: string | undefined) {
  return useQuery({
    queryKey: ["client", id],
    queryFn: () => fetchJson<ClientDto>(`/api/clients/${id}`),
    enabled: !!id,
  });
}
export function useVessels(q: string) {
  return useQuery({
    queryKey: ["vessels", q],
    queryFn: () => fetchJson<Paginated<VesselDto>>(`/api/vessels?q=${encodeURIComponent(q)}`),
  });
}
export function useVessel(id: string | undefined) {
  return useQuery({
    queryKey: ["vessel", id],
    queryFn: () => fetchJson<VesselDto>(`/api/vessels/${id}`),
    enabled: !!id,
  });
}
```

- [ ] **Step 5: Implement `AppLayout` + `ClientsListPage` + `ClientFormPage`**

`apps/web/src/components/AppLayout.tsx`:
```tsx
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button } from "@/components/ui/button";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === "ADMINISTRATOR";
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/" className="font-semibold">Svyft Logistics</Link>
          <Link to="/masters/clients">Clients</Link>
          <Link to="/masters/vessels">Vessels</Link>
          {isAdmin && <Link to="/admin/config">Config</Link>}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-600">{user?.name} ({user?.role})</span>
          <Button variant="outline" onClick={() => void logout()}>Log out</Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl p-6">{children}</main>
    </div>
  );
}
```
`apps/web/src/features/masters/clients/ClientsListPage.tsx`:
```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthProvider";
import { useClients } from "../useMasters";
import { Input } from "@/components/ui/input";

export function ClientsListPage() {
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const canWrite = user?.role === "ADMINISTRATOR" || user?.role === "MANAGER";
  const { data, isLoading } = useClients(q);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Clients</h1>
        {canWrite && (
          <Link to="/masters/clients/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm text-slate-50">
            New client
          </Link>
        )}
      </div>
      <Input placeholder="Search company, code, country…" value={q} onChange={(e) => setQ(e.target.value)} />
      {isLoading ? (
        <p>Loading…</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-slate-500">
              <th className="py-2">Code</th><th>Company</th><th>Country</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="py-2">{c.clientCode}</td>
                <td><Link to={`/masters/clients/${c.id}`} className="underline">{c.companyName}</Link></td>
                <td>{c.country}</td>
                <td>{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```
`apps/web/src/features/masters/clients/ClientFormPage.tsx`:
```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect } from "react";
import { clientCreateSchema, type ClientCreateInput } from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useClient } from "../useMasters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ClientFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useClient(id);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<ClientCreateInput>({
    resolver: zodResolver(clientCreateSchema),
  });

  useEffect(() => {
    if (existing.data) {
      reset({
        companyName: existing.data.companyName,
        country: existing.data.country,
        industry: existing.data.industry ?? undefined,
      });
    }
  }, [existing.data, reset]);

  async function onSubmit(values: ClientCreateInput) {
    if (id) await patchJson(`/api/clients/${id}`, values);
    else await postJson("/api/clients", values);
    navigate("/masters/clients");
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-md space-y-4" aria-label="Client form">
      <h1 className="text-xl font-semibold">{id ? "Edit client" : "New client"}</h1>
      <div className="space-y-1">
        <Label htmlFor="companyName">Company name</Label>
        <Input id="companyName" {...register("companyName")} />
        {errors.companyName && <p role="alert" className="text-sm text-red-600">{errors.companyName.message}</p>}
      </div>
      <div className="space-y-1">
        <Label htmlFor="country">Country</Label>
        <Input id="country" {...register("country")} />
        {errors.country && <p role="alert" className="text-sm text-red-600">{errors.country.message}</p>}
      </div>
      <div className="space-y-1">
        <Label htmlFor="industry">Industry</Label>
        <Input id="industry" {...register("industry")} />
      </div>
      <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Saving…" : "Save"}</Button>
    </form>
  );
}
```

- [ ] **Step 6: Wire routes**

Edit `apps/web/src/App.tsx` — wrap protected pages in `AppLayout` and add the client routes:
```tsx
import { Routes, Route } from "react-router-dom";
import { LoginPage } from "@/features/auth/LoginPage";
import { HomePage } from "@/features/home/HomePage";
import { ProtectedRoute } from "@/features/auth/ProtectedRoute";
import { AppLayout } from "@/components/AppLayout";
import { ClientsListPage } from "@/features/masters/clients/ClientsListPage";
import { ClientFormPage } from "@/features/masters/clients/ClientFormPage";

function Protected({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <AppLayout>{children}</AppLayout>
    </ProtectedRoute>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Protected><HomePage /></Protected>} />
      <Route path="/masters/clients" element={<Protected><ClientsListPage /></Protected>} />
      <Route path="/masters/clients/new" element={<Protected><ClientFormPage /></Protected>} />
      <Route path="/masters/clients/:id" element={<Protected><ClientFormPage /></Protected>} />
    </Routes>
  );
}
```
(Vessels + config routes are added in Task 8. `import React` is not needed for the `React.ReactNode` type in a `.tsx` with the automatic JSX runtime — use `import type { ReactNode } from "react"` and type `Protected`'s prop as `ReactNode`.)

- [ ] **Step 7: Run tests → PASS**, then `pnpm --filter @svyft/web typecheck` + `build` → exit 0. (Requires `@svyft/shared` built.)

- [ ] **Step 8: Commit**

```bash
git add apps/web packages/shared pnpm-lock.yaml
git commit -m "feat(web): add app shell, Clients master list + form (React Hook Form + shared schemas)"
```

---

### Task 8: Web — Vessels Masters UI + admin Config UI

**Files:**
- Create: `apps/web/src/features/masters/vessels/VesselsListPage.tsx`, `VesselFormPage.tsx`, `apps/web/src/features/admin/ConfigPage.tsx`
- Modify: `apps/web/src/App.tsx` (add vessel + config routes)
- Test: `apps/web/src/features/masters/vessels/VesselsListPage.test.tsx`, `apps/web/src/features/admin/ConfigPage.test.tsx`

**Interfaces:**
- `VesselsListPage`/`VesselFormPage` mirror the Clients pages (use `useVessels`/`useVessel`, `vesselCreateSchema`, a `vesselType` `<select>` from `VESSEL_TYPES`, `imoNumber` field). `ConfigPage` (`/admin/config`, Admin-only route) reads `/api/config/density-factors` + `/api/config/checklist-definition` and lets an Admin `PATCH` a density `kgPerCbm`.

- [ ] **Step 1: Write the failing tests** — `VesselsListPage.test.tsx` (lists a vessel, shows/hides "New vessel" by role — same shape as `ClientsListPage.test.tsx`) and `ConfigPage.test.tsx` (renders seeded density factors from a mocked `/api/config/density-factors`, shows the SEA=1000 row). Follow the `ClientsListPage.test.tsx` harness.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `VesselsListPage`** — copy `ClientsListPage`, swap `useVessels`, columns (Code · Name · IMO · Type · Status), link `/masters/vessels/:id`, "New vessel" → `/masters/vessels/new`, gated by `canWrite`.

- [ ] **Step 4: Implement `VesselFormPage`** — copy `ClientFormPage`, use `vesselCreateSchema`, fields: `name` (Input), `imoNumber` (Input, optional), `shippingLine` (Input, optional), `vesselType` (`<select>` over `VESSEL_TYPES` from `@svyft/shared`), submit → `POST`/`PATCH /api/vessels`.
```tsx
// vesselType select fragment:
import { VESSEL_TYPES } from "@svyft/shared";
// ...
<Label htmlFor="vesselType">Vessel type</Label>
<select id="vesselType" {...register("vesselType")} className="h-10 w-full rounded-md border border-slate-300 px-3">
  {VESSEL_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
</select>
```

- [ ] **Step 5: Implement `ConfigPage`** (Admin-only screen; the route is guarded in `App.tsx` by checking role and redirecting non-admins):
```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchJson, patchJson } from "@/lib/api";
import type { ChecklistItemDto, DensityFactorDto } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ConfigPage() {
  const qc = useQueryClient();
  const factors = useQuery({ queryKey: ["density-factors"], queryFn: () => fetchJson<DensityFactorDto[]>("/api/config/density-factors") });
  const checklist = useQuery({ queryKey: ["checklist"], queryFn: () => fetchJson<ChecklistItemDto[]>("/api/config/checklist-definition") });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (v: { mode: string; kgPerCbm: number }) => patchJson(`/api/config/density-factors/${v.mode}`, { kgPerCbm: v.kgPerCbm }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["density-factors"] }),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Reference data</h1>
      <section>
        <h2 className="mb-2 font-medium">Freight density factors (kg/CBM)</h2>
        {factors.data?.map((f) => (
          <div key={f.mode} className="flex items-center gap-3 py-1">
            <span className="w-16">{f.mode}</span>
            <Input
              className="w-32"
              defaultValue={String(f.kgPerCbm)}
              onChange={(e) => setEdits((s) => ({ ...s, [f.mode]: e.target.value }))}
            />
            <Button onClick={() => save.mutate({ mode: f.mode, kgPerCbm: Number(edits[f.mode] ?? f.kgPerCbm) })}>
              Save
            </Button>
          </div>
        ))}
      </section>
      <section>
        <h2 className="mb-2 font-medium">Missing-details checklist</h2>
        <ol className="list-decimal space-y-1 pl-6 text-sm">
          {checklist.data?.map((c) => (
            <li key={c.itemKey}>{c.label}{c.dgConditional ? " (DG only)" : ""}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Wire routes** — in `App.tsx` add `/masters/vessels`, `/masters/vessels/new`, `/masters/vessels/:id` (like clients), and `/admin/config`. Guard the config route so non-admins are redirected:
```tsx
import { Navigate } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthProvider";
import { VesselsListPage } from "@/features/masters/vessels/VesselsListPage";
import { VesselFormPage } from "@/features/masters/vessels/VesselFormPage";
import { ConfigPage } from "@/features/admin/ConfigPage";

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.role === "ADMINISTRATOR" ? <>{children}</> : <Navigate to="/" replace />;
}
// routes:
// <Route path="/masters/vessels" element={<Protected><VesselsListPage /></Protected>} />
// <Route path="/masters/vessels/new" element={<Protected><VesselFormPage /></Protected>} />
// <Route path="/masters/vessels/:id" element={<Protected><VesselFormPage /></Protected>} />
// <Route path="/admin/config" element={<Protected><AdminOnly><ConfigPage /></AdminOnly></Protected>} />
```

- [ ] **Step 7: Run tests → PASS**, then `pnpm --filter @svyft/web typecheck` + `build` + `pnpm --filter @svyft/web test` (full) → green.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): add Vessels master UI and admin Config screen"
```

---

### Task 9: Docs + full end-to-end verification

**Files:**
- Modify: `README.md` (masters + config in the app; the seed now also seeds reference data)
- No new tests — proves the branch composes.

- [ ] **Step 1: Update README** — add a short "Masters" note under the app description: Clients & Vessels masters at `/masters/*` (Admin/Manager write, all read), admin reference data at `/admin/config`; `pnpm exec prisma db seed` now seeds users **and** reference data (density factors + checklist + code sequences).

- [ ] **Step 2: CI mirror** — `pnpm --filter @svyft/shared build && pnpm exec prisma generate --schema prisma/schema.prisma && pnpm run ci` → lint · typecheck · test · build green across all three packages (api e2e need the migrated DB + `JWT_ACCESS_SECRET`; seed the reference data first if a fresh DB).

- [ ] **Step 3: Real round-trip** — with `pnpm dev` running + DB seeded, sign in as the seeded admin, create a client (see the `CL-0001` code), add a contact, create a vessel (with a 7-digit IMO), and open `/admin/config` to see the seeded density factors. Confirm an Executive login sees the lists but not the "New" buttons, and that `curl -X POST .../api/clients` with an Executive cookie returns 403.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document masters, config, and reference-data seed"
```

---

## Self-Review (completed by plan author)

**Spec coverage (Technical Design §4.2, §5.2; Functional Spec §7.1, §7.5, §8.6):**
- Client (clientCode ᵁ, companyName ᵁ, industry, country, status) + ClientContact (name, designation, contactNo, email, isPrimary) → Tasks 1, 4. ✓
- Vessel (vesselCode ᵁ, name, imoNumber ᵁ 7-digit + cross-check, shippingLine, vesselType, status) → Tasks 1, 5. ✓
- FreightDensityFactor (mode, kgPerCbm; seeded ROAD 333/AIR 167/SEA 1000) + ChecklistDefinition (9 items, MSDS dgConditional) → Tasks 1, 6. ✓
- Endpoints per §5.2 (clients search/paginate + contacts; vessels; config density/checklist) → Tasks 4–6. ✓
- RBAC: read-all, write Admin/Manager, config Admin-only — first real use of the Plan 1 guard, verified by 401/403 e2e → Tasks 4–6. ✓
- `clientCode`/`vesselCode` = `CL-`/`VS-` + 4-digit (O-T1) via atomic sequence → Tasks 1, 3. ✓
- Minimal Masters UI + admin config (scope decision) → Tasks 7, 8. ✓
- Reference data seeded idempotently with the user seed → Task 6. ✓
- Nullable `tenantId` on every new table (tenant-readiness §4.6) → Task 1. ✓
- **Deferred (noted):** inline client creation is out of scope (spec §3 — no inline create in v2); the contact **snapshot** onto a Query is a Plan 4 concern (Query aggregate); the `422 { findings }` envelope stays with the route engine (Plan 5) — Masters use `400`/`409`.

**Placeholder scan:** none — every step has complete content; `<timestamp>` is Prisma-generated. Tasks 5/8 explicitly say "copy the Clients pattern" and give the distinct code (schemas, columns, fields) rather than a vague reference.

**Type consistency:** `MasterStatus`/`VesselType`/`FreightMode` const-objects match the Prisma enums; `ClientDto`/`VesselDto`/`Paginated<T>`/`ContactDto`/`DensityFactorDto`/`ChecklistItemDto` are shared between api responses and web consumers; `clientCreateSchema`/`vesselCreateSchema` (+ `.partial()` updates) are used identically in the pipe (api) and `zodResolver` (web); `CodeSequenceService.next(key, prefix)` and the inline `codeSequence.update` in the create transactions agree on the `CL-`/`VS-` + 4-digit format and the seeded `CLIENT`/`VESSEL` keys.

**Sequencing / DAG:** 1 (schema) → 2 (shared) → 3 (code-seq) → 4 (clients) → 5 (vessels) → 6 (config + seed) → 7 (web clients) → 8 (web vessels/config) → 9 (docs+verify). Each ends green + committed; the `CodeSequence` rows are seeded in Task 6 but the client/vessel e2e (Tasks 4/5) upsert their own key row in `beforeAll` so they don't depend on Task 6.

---

*End of Plan 2.*
