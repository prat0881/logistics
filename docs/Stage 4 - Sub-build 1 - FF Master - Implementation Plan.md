# Stage 4 · Sub-build 1 — Freight Forwarder Master — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the admin-governed **Freight Forwarder (FF) Master** — data model, REST API, and list + editor UI — the lookup/eligibility source the rest of Stage 4 selects from.

**Architecture:** A new `freight-forwarders` NestJS module + shared Zod schemas + a static reference-data module (countries/currencies) + a `masters/freight-forwarders` web feature, all mirroring the existing **Vessel/Client masters**. The FF is a flat single entity with two multi-selects (`availableCountries`, `modes`), a `handleDg` flag, and an `FF-####` code.

**Tech Stack:** NestJS · Prisma/PostgreSQL · Zod (`packages/shared`) · React + shadcn/ui + TanStack Query + React Hook Form · Vitest (shared/web) · Jest + supertest (api e2e).

## Global Constraints

- All types/schemas live in `packages/shared` and are imported by both apps (`@svyft/shared`).
- **Reuse the existing `FreightMode` enum** (`packages/shared/src/config.ts` + `prisma/schema.prisma`) and `MasterStatus` (`packages/shared/src/masters.ts`). Do **not** create new mode/status enums.
- RBAC: **reads** (`GET`) = any authenticated role (no `@Roles`); **writes** (`POST`/`PATCH`) = `@Roles(Role.ADMINISTRATOR, Role.MANAGER)`.
- `freightForwarderCode` minted `FF-####` via `CodeSequence` (key `"FREIGHT_FORWARDER"`), mirroring `VS-`/`CL-`.
- New table carries nullable `tenantId String? @db.Uuid` + `@@index([tenantId])`.
- API prefix `/api`; `ZodValidationPipe` → `400 { message, issues }` (the masters convention).
- **Field mandatoriness per Functional Spec §6:** `companyName`, `pic`, `contactNumber` (E.164), `email`, `availableCountries` (≥1), `modes` (≥1) are **required**; `companyAddress`, `handleDg`, `vatTrnEori`, `whLocation`, `defaultCurrency`, `paymentTerms`, `typicalLeadTime`, `status` are optional.
- `companyName` is **unique** (dedupe, mirrors Client); P2002 → `409 ConflictException`.
- Static countries + currencies reference lists now; admin-managed screen deferred (Technical Design **O-S4-2**).
- Commit after each task. Test commands: `pnpm --filter @svyft/shared test` · `pnpm --filter @svyft/api test` · `pnpm --filter @svyft/web test`.
- **Monorepo build order (verified):** `@svyft/web` imports the **built** `@svyft/shared` (its `dist/`, per `packages/shared/package.json` `main`/`exports`). After any change to `packages/shared/src`, run **`pnpm --filter @svyft/shared build`** or web test/typecheck fails with *"Failed to resolve entry for package @svyft/shared"*. (`@svyft/api` maps `@svyft/shared` → `src` directly via `jest-e2e.json`, so it needs no rebuild.) A fresh worktree also requires this build once before any web suite runs.

> **Note — one addition beyond Technical Design §4.2:** this plan adds `freightForwarderCode` (`FF-####`) for consistency with the `VS-`/`CL-` masters. Reflect it in the design doc's FreightForwarder entity when convenient.

---

### Task 1: Shared reference data — countries & currencies

**Files:**
- Create: `packages/shared/src/reference.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/reference.test.ts`

**Interfaces:**
- Produces: `COUNTRIES: readonly {code,name}[]`, `COUNTRY_CODES: [string, ...string[]]`, `CountryCode`, `CURRENCIES: readonly {code,name}[]`, `CURRENCY_CODES: [string, ...string[]]`, `CurrencyCode`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/reference.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { COUNTRIES, COUNTRY_CODES, CURRENCIES, CURRENCY_CODES } from "./reference";

describe("reference data", () => {
  it("exposes country codes with unique 2-letter ISO codes", () => {
    expect(COUNTRIES.length).toBeGreaterThan(40);
    expect(COUNTRY_CODES).toContain("US");
    expect(COUNTRY_CODES).toContain("SG");
    expect(COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });
  it("exposes currency codes with unique 3-letter ISO codes", () => {
    expect(CURRENCY_CODES).toContain("USD");
    expect(CURRENCY_CODES).toContain("AED");
    expect(CURRENCY_CODES.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
  });
  it("keeps CODES arrays in sync with the object lists", () => {
    expect(COUNTRY_CODES).toEqual(COUNTRIES.map((c) => c.code));
    expect(CURRENCY_CODES).toEqual(CURRENCIES.map((c) => c.code));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/shared test reference`
Expected: FAIL — `Cannot find module './reference'`.

- [ ] **Step 3: Create the reference data**

Create `packages/shared/src/reference.ts`:
```typescript
// Static reference lists for the FF Master (Technical Design O-S4-2).
// An admin-managed screen is deferred; this is the MVP static set, easily extended.

export const COUNTRIES = [
  { code: "US", name: "United States" }, { code: "CA", name: "Canada" },
  { code: "MX", name: "Mexico" }, { code: "BR", name: "Brazil" },
  { code: "AR", name: "Argentina" }, { code: "CL", name: "Chile" },
  { code: "GB", name: "United Kingdom" }, { code: "IE", name: "Ireland" },
  { code: "FR", name: "France" }, { code: "DE", name: "Germany" },
  { code: "NL", name: "Netherlands" }, { code: "BE", name: "Belgium" },
  { code: "ES", name: "Spain" }, { code: "PT", name: "Portugal" },
  { code: "IT", name: "Italy" }, { code: "CH", name: "Switzerland" },
  { code: "AT", name: "Austria" }, { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" }, { code: "DK", name: "Denmark" },
  { code: "FI", name: "Finland" }, { code: "PL", name: "Poland" },
  { code: "CZ", name: "Czechia" }, { code: "HU", name: "Hungary" },
  { code: "RO", name: "Romania" }, { code: "GR", name: "Greece" },
  { code: "TR", name: "Turkey" }, { code: "RU", name: "Russia" },
  { code: "AE", name: "United Arab Emirates" }, { code: "SA", name: "Saudi Arabia" },
  { code: "QA", name: "Qatar" }, { code: "KW", name: "Kuwait" },
  { code: "BH", name: "Bahrain" }, { code: "OM", name: "Oman" },
  { code: "IL", name: "Israel" }, { code: "EG", name: "Egypt" },
  { code: "ZA", name: "South Africa" }, { code: "NG", name: "Nigeria" },
  { code: "KE", name: "Kenya" }, { code: "MA", name: "Morocco" },
  { code: "IN", name: "India" }, { code: "PK", name: "Pakistan" },
  { code: "BD", name: "Bangladesh" }, { code: "LK", name: "Sri Lanka" },
  { code: "CN", name: "China" }, { code: "HK", name: "Hong Kong" },
  { code: "TW", name: "Taiwan" }, { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" }, { code: "SG", name: "Singapore" },
  { code: "MY", name: "Malaysia" }, { code: "TH", name: "Thailand" },
  { code: "VN", name: "Vietnam" }, { code: "ID", name: "Indonesia" },
  { code: "PH", name: "Philippines" }, { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
] as const;

export type CountryCode = (typeof COUNTRIES)[number]["code"];
export const COUNTRY_CODES = COUNTRIES.map((c) => c.code) as [CountryCode, ...CountryCode[]];

export const CURRENCIES = [
  { code: "USD", name: "US Dollar" }, { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" }, { code: "JPY", name: "Japanese Yen" },
  { code: "CNY", name: "Chinese Yuan" }, { code: "HKD", name: "Hong Kong Dollar" },
  { code: "INR", name: "Indian Rupee" }, { code: "AED", name: "UAE Dirham" },
  { code: "SAR", name: "Saudi Riyal" }, { code: "QAR", name: "Qatari Riyal" },
  { code: "KWD", name: "Kuwaiti Dinar" }, { code: "SGD", name: "Singapore Dollar" },
  { code: "MYR", name: "Malaysian Ringgit" }, { code: "THB", name: "Thai Baht" },
  { code: "IDR", name: "Indonesian Rupiah" }, { code: "PHP", name: "Philippine Peso" },
  { code: "KRW", name: "South Korean Won" }, { code: "TWD", name: "Taiwan Dollar" },
  { code: "AUD", name: "Australian Dollar" }, { code: "NZD", name: "New Zealand Dollar" },
  { code: "CAD", name: "Canadian Dollar" }, { code: "CHF", name: "Swiss Franc" },
  { code: "SEK", name: "Swedish Krona" }, { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" }, { code: "ZAR", name: "South African Rand" },
  { code: "BRL", name: "Brazilian Real" }, { code: "TRY", name: "Turkish Lira" },
  { code: "PLN", name: "Polish Zloty" }, { code: "EGP", name: "Egyptian Pound" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
export const CURRENCY_CODES = CURRENCIES.map((c) => c.code) as [CurrencyCode, ...CurrencyCode[]];
```

Then add to `packages/shared/src/index.ts` (after the `export * from "./config";` line):
```typescript
export * from "./reference";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @svyft/shared test reference`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/reference.ts packages/shared/src/reference.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add static country + currency reference lists for FF Master"
```

---

### Task 2: Shared FF schema + DTO

**Files:**
- Modify: `packages/shared/src/masters.ts`
- Test: `packages/shared/src/masters.test.ts`

**Interfaces:**
- Consumes: `statusField` (module-private in `masters.ts`), `FREIGHT_MODES` (from `./config`), `COUNTRY_CODES`/`CURRENCY_CODES` (from `./reference`).
- Produces: `freightForwarderCreateSchema`, `freightForwarderUpdateSchema`, `FreightForwarderCreateInput`, `FreightForwarderUpdateInput`, `FreightForwarderDto`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/masters.test.ts`:
```typescript
import { freightForwarderCreateSchema } from "./masters";

const validFf = {
  companyName: "Acme Freight",
  pic: "Jane Doe",
  contactNumber: "+15551234567",
  email: "ops@acme.example",
  availableCountries: ["US", "SG"],
  modes: ["AIR", "SEA"],
};

describe("freightForwarderCreateSchema", () => {
  it("accepts a valid FF with the required fields", () => {
    expect(freightForwarderCreateSchema.safeParse(validFf).success).toBe(true);
  });
  it("rejects a missing companyName", () => {
    const { companyName, ...rest } = validFf;
    expect(freightForwarderCreateSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects an empty modes array", () => {
    expect(freightForwarderCreateSchema.safeParse({ ...validFf, modes: [] }).success).toBe(false);
  });
  it("rejects a non-E.164 phone", () => {
    expect(
      freightForwarderCreateSchema.safeParse({ ...validFf, contactNumber: "5551234567" }).success,
    ).toBe(false);
  });
  it("rejects an unknown mode", () => {
    expect(freightForwarderCreateSchema.safeParse({ ...validFf, modes: ["PLANE"] }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/shared test masters`
Expected: FAIL — `freightForwarderCreateSchema` is not exported.

- [ ] **Step 3: Add the schema + DTO to `masters.ts`**

At the top of `packages/shared/src/masters.ts`, extend the imports (the file already imports `z`; add the two lines):
```typescript
import { FREIGHT_MODES, type FreightMode } from "./config";
import { COUNTRY_CODES, CURRENCY_CODES } from "./reference";
```

At the end of `packages/shared/src/masters.ts`, append:
```typescript
export const freightForwarderCreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  companyAddress: z.string().max(500).optional(),
  pic: z.string().min(1).max(160),
  contactNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164"),
  email: z.string().email(),
  availableCountries: z.array(z.enum(COUNTRY_CODES)).min(1, "Select at least one country"),
  modes: z.array(z.enum(FREIGHT_MODES)).min(1, "Select at least one mode"),
  handleDg: z.boolean().optional(),
  vatTrnEori: z.string().max(100).optional(),
  whLocation: z.string().max(200).optional(),
  defaultCurrency: z.enum(CURRENCY_CODES).optional(),
  paymentTerms: z.string().max(200).optional(),
  typicalLeadTime: z.string().max(60).optional(),
  status: statusField,
});
export const freightForwarderUpdateSchema = freightForwarderCreateSchema.partial();
export type FreightForwarderCreateInput = z.infer<typeof freightForwarderCreateSchema>;
export type FreightForwarderUpdateInput = z.infer<typeof freightForwarderUpdateSchema>;

export interface FreightForwarderDto {
  id: string;
  freightForwarderCode: string;
  companyName: string;
  companyAddress: string | null;
  pic: string;
  contactNumber: string;
  email: string;
  availableCountries: string[];
  modes: FreightMode[];
  handleDg: boolean;
  vatTrnEori: string | null;
  whLocation: string | null;
  defaultCurrency: string | null;
  paymentTerms: string | null;
  typicalLeadTime: string | null;
  status: MasterStatus;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @svyft/shared test masters`
Expected: PASS (existing master tests + 5 new FF tests).

- [ ] **Step 5: Rebuild `@svyft/shared` so dependent apps resolve the new exports**

Run: `pnpm --filter @svyft/shared build`
Expected: `packages/shared/dist/index.js` regenerated with the FF schema + reference exports. Required before the web tasks (5–7) can import `freightForwarderCreateSchema`, `FreightForwarderDto`, `COUNTRIES`, `CURRENCIES`. `dist/` is gitignored — do not commit it.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/masters.ts packages/shared/src/masters.test.ts
git commit -m "feat(shared): add FreightForwarder create/update schemas + DTO"
```

---

### Task 3: Prisma model + migration + seed sequence

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `apps/api/src/seed/seed.ts`

**Interfaces:**
- Produces: the `FreightForwarder` table + `CodeSequence` key `"FREIGHT_FORWARDER"`; Prisma client type `FreightForwarder`.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

Reusing the existing `FreightMode` and `MasterStatus` enums, add near the other master models (after `model Vessel`):
```prisma
model FreightForwarder {
  id                   String        @id @default(uuid()) @db.Uuid
  tenantId             String?       @db.Uuid
  freightForwarderCode String        @unique
  companyName          String        @unique
  companyAddress       String?
  pic                  String
  contactNumber        String
  email                String
  availableCountries   String[]
  modes                FreightMode[]
  handleDg             Boolean       @default(false)
  vatTrnEori           String?
  whLocation           String?
  defaultCurrency      String?
  paymentTerms         String?
  typicalLeadTime      String?
  status               MasterStatus  @default(ACTIVE)
  createdAt            DateTime      @default(now())
  updatedAt            DateTime      @updatedAt

  @@index([tenantId])
}
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
set -a; . apps/api/.env; set +a
pnpm exec prisma migrate dev --name add_freight_forwarders --schema prisma/schema.prisma
```
Expected: creates `prisma/migrations/<ts>_add_freight_forwarders/migration.sql` containing `CREATE TABLE "FreightForwarder"` with a `"FreightMode"[]` column, and runs `prisma generate`.

- [ ] **Step 3: Verify the generated SQL**

Run:
```bash
grep -E 'CREATE TABLE "FreightForwarder"|"modes" "FreightMode"\[\]|"availableCountries" TEXT\[\]|freightForwarderCode' prisma/migrations/*_add_freight_forwarders/migration.sql
```
Expected: matches for the table, the enum array, the text array, and the unique code column.

- [ ] **Step 4: Pre-seed the code sequence**

In `apps/api/src/seed/seed.ts`, next to the existing `CodeSequence` upserts (for `"VESSEL"`/`"CLIENT"`), add:
```typescript
await prisma.codeSequence.upsert({
  where: { key: "FREIGHT_FORWARDER" },
  create: { key: "FREIGHT_FORWARDER", lastNumber: 0 },
  update: {},
});
```

- [ ] **Step 5: Run the seed + typecheck**

Run:
```bash
pnpm exec prisma db seed
pnpm --filter @svyft/api exec tsc --noEmit
```
Expected: seed completes; typecheck passes (the `FreightForwarder` delegate now exists on the Prisma client).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/src/seed/seed.ts
git commit -m "feat(db): add FreightForwarder model, migration, and code sequence seed"
```

---

### Task 4: Backend `freight-forwarders` module + e2e tests

**Files:**
- Create: `apps/api/src/modules/freight-forwarders/freight-forwarders.service.ts`
- Create: `apps/api/src/modules/freight-forwarders/freight-forwarders.controller.ts`
- Create: `apps/api/src/modules/freight-forwarders/freight-forwarders.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/freight-forwarders.e2e-spec.ts`

**Interfaces:**
- Consumes: `freightForwarderCreateSchema`, `freightForwarderUpdateSchema`, `FreightForwarderCreateInput`, `FreightForwarderUpdateInput`, `Role`, `ACCESS_TOKEN_COOKIE` (from `@svyft/shared`); `ZodValidationPipe`, `Roles`, `PrismaService`.
- Produces: `GET /api/freight-forwarders`, `GET /api/freight-forwarders/:id`, `POST /api/freight-forwarders`, `PATCH /api/freight-forwarders/:id`; `FreightForwardersService` (`list`, `get`, `create`, `update`).

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/freight-forwarders.e2e-spec.ts`:
```typescript
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

const CO = "FF E2E Forwarder";
const valid = {
  companyName: CO,
  pic: "Jane Doe",
  contactNumber: "+15551234567",
  email: "ops@ff-e2e.example",
  availableCountries: ["US", "SG"],
  modes: ["AIR", "SEA"],
  handleDg: true,
};

describe("FreightForwarders (e2e)", () => {
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
    await prisma.codeSequence.upsert({
      where: { key: "FREIGHT_FORWARDER" },
      create: { key: "FREIGHT_FORWARDER", lastNumber: 0 },
      update: {},
    });
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: CO } } });
  });

  afterAll(async () => {
    await prisma.freightForwarder.deleteMany({ where: { companyName: { startsWith: CO } } });
    await app.close();
  });

  it("401s unauthenticated read; 403s an Executive create", async () => {
    await request(app.getHttpServer()).get("/api/freight-forwarders").expect(401);
    await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send(valid)
      .expect(403);
  });

  it("Admin creates (mints FF- code, round-trips arrays); any role reads it", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send(valid)
      .expect(201);
    expect(created.body.freightForwarderCode).toMatch(/^FF-\d{4}$/);
    expect(created.body.modes).toEqual(["AIR", "SEA"]);
    expect(created.body.availableCountries).toEqual(["US", "SG"]);
    const read = await request(app.getHttpServer())
      .get(`/api/freight-forwarders/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(read.body.companyName).toBe(CO);
  });

  it("409s a duplicate companyName", async () => {
    await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ ...valid, email: "dup@ff-e2e.example" })
      .expect(409);
  });

  it("400s an invalid body (bad phone) and searches/paginates", async () => {
    await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ ...valid, companyName: `${CO} 2`, contactNumber: "5551234567" })
      .expect(400);
    const res = await request(app.getHttpServer())
      .get("/api/freight-forwarders?q=FF%20E2E&page=1&pageSize=10")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/api test freight-forwarders`
Expected: FAIL — routes 404 (module not registered).

- [ ] **Step 3: Write the service**

Create `apps/api/src/modules/freight-forwarders/freight-forwarders.service.ts`:
```typescript
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { FreightForwarderCreateInput, FreightForwarderUpdateInput, Paginated } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class FreightForwardersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { q?: string; status?: string; page: number; pageSize: number }): Promise<Paginated<unknown>> {
    const where: Prisma.FreightForwarderWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.q
        ? {
            OR: [
              { companyName: { contains: params.q, mode: "insensitive" } },
              { freightForwarderCode: { contains: params.q, mode: "insensitive" } },
              { pic: { contains: params.q, mode: "insensitive" } },
              { email: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.freightForwarder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.freightForwarder.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }

  async get(id: string) {
    const ff = await this.prisma.freightForwarder.findUnique({ where: { id } });
    if (!ff) throw new NotFoundException("Freight forwarder not found");
    return ff;
  }

  async create(input: FreightForwarderCreateInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.upsert({
          where: { key: "FREIGHT_FORWARDER" },
          create: { key: "FREIGHT_FORWARDER", lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const freightForwarderCode = `FF-${String(row.lastNumber).padStart(4, "0")}`;
        return tx.freightForwarder.create({ data: { freightForwarderCode, ...input } });
      });
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  async update(id: string, input: FreightForwarderUpdateInput) {
    await this.get(id);
    try {
      return await this.prisma.freightForwarder.update({ where: { id }, data: input });
    } catch (e) {
      throw this.mapUnique(e);
    }
  }

  private mapUnique(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return new ConflictException("A freight forwarder with that company name already exists");
    }
    return e;
  }
}
```

- [ ] **Step 4: Write the controller**

Create `apps/api/src/modules/freight-forwarders/freight-forwarders.controller.ts`:
```typescript
import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Role, freightForwarderCreateSchema, freightForwarderUpdateSchema } from "@svyft/shared";
import type { FreightForwarderCreateInput, FreightForwarderUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { FreightForwardersService } from "./freight-forwarders.service";

@Controller("freight-forwarders")
export class FreightForwardersController {
  constructor(private readonly ffs: FreightForwardersService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("status") status?: string,
    @Query("page") page = "1",
    @Query("pageSize") pageSize = "20",
  ) {
    return this.ffs.list({
      q,
      status,
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(Math.max(1, Number(pageSize) || 20), 100),
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.ffs.get(id);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(@Body(new ZodValidationPipe(freightForwarderCreateSchema)) body: FreightForwarderCreateInput) {
    return this.ffs.create(body);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(freightForwarderUpdateSchema)) body: FreightForwarderUpdateInput,
  ) {
    return this.ffs.update(id, body);
  }
}
```

- [ ] **Step 5: Write the module + register it**

Create `apps/api/src/modules/freight-forwarders/freight-forwarders.module.ts`:
```typescript
import { Module } from "@nestjs/common";
import { FreightForwardersService } from "./freight-forwarders.service";
import { FreightForwardersController } from "./freight-forwarders.controller";

@Module({
  controllers: [FreightForwardersController],
  providers: [FreightForwardersService],
  exports: [FreightForwardersService],
})
export class FreightForwardersModule {}
```

In `apps/api/src/app.module.ts`, add the import and the entry in the `imports` array (next to `VesselsModule`):
```typescript
import { FreightForwardersModule } from "./modules/freight-forwarders/freight-forwarders.module";
// ...
  imports: [
    // ...existing...
    FreightForwardersModule,
  ],
```

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `pnpm --filter @svyft/api test freight-forwarders`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/freight-forwarders apps/api/src/app.module.ts apps/api/test/freight-forwarders.e2e-spec.ts
git commit -m "feat(api): add freight-forwarders CRUD module with RBAC + e2e tests"
```

---

### Task 5: Web reusable `MultiSelectCombobox`

**Files:**
- Create: `apps/web/src/components/MultiSelectCombobox.tsx`
- Test: `apps/web/src/components/MultiSelectCombobox.test.tsx`

**Interfaces:**
- Produces: `MultiSelectCombobox({ value: string[]; options: {code:string;name:string}[]; onChange: (v: string[]) => void; ariaLabel: string; placeholder?: string })`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/MultiSelectCombobox.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiSelectCombobox } from "./MultiSelectCombobox";

const OPTS = [
  { code: "US", name: "United States" },
  { code: "SG", name: "Singapore" },
];

describe("MultiSelectCombobox", () => {
  it("adds an option on select and renders it as a removable badge", async () => {
    const onChange = vi.fn();
    render(<MultiSelectCombobox value={[]} options={OPTS} onChange={onChange} ariaLabel="Countries" />);
    await userEvent.click(screen.getByRole("button", { name: /countries/i }));
    await userEvent.click(await screen.findByText("Singapore"));
    expect(onChange).toHaveBeenCalledWith(["SG"]);
  });

  it("shows selected values as badges and removes on X", async () => {
    const onChange = vi.fn();
    render(<MultiSelectCombobox value={["US"]} options={OPTS} onChange={onChange} ariaLabel="Countries" />);
    expect(screen.getByText("United States")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove united states/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/web test MultiSelectCombobox`
Expected: FAIL — `Cannot find module './MultiSelectCombobox'`.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/MultiSelectCombobox.tsx`:
```tsx
import { useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface Option {
  code: string;
  name: string;
}
interface Props {
  value: string[];
  options: readonly Option[];
  onChange: (v: string[]) => void;
  ariaLabel: string;
  placeholder?: string;
}

export function MultiSelectCombobox({ value, options, onChange, ariaLabel, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const nameOf = (code: string) => options.find((o) => o.code === code)?.name ?? code;
  const toggle = (code: string) =>
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" aria-label={ariaLabel} className="w-full justify-between font-normal">
            {value.length > 0 ? `${value.length} selected` : (placeholder ?? `Select…`)}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command>
            <CommandInput placeholder={`Search ${ariaLabel.toLowerCase()}…`} />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.code} value={o.name} onSelect={() => toggle(o.code)}>
                    <input type="checkbox" checked={value.includes(o.code)} readOnly className="mr-2" />
                    {o.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((code) => (
            <Badge key={code} variant="secondary" className="gap-1">
              {nameOf(code)}
              <button
                type="button"
                aria-label={`Remove ${nameOf(code)}`}
                onClick={() => toggle(code)}
                className="ml-1 focus:outline-none"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
```

> If `@/components/ui/badge` does not yet exist, add it via the project's shadcn pattern (copy the standard shadcn `badge.tsx`) before this step — check with `ls apps/web/src/components/ui/badge.tsx`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @svyft/web test MultiSelectCombobox`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/MultiSelectCombobox.tsx apps/web/src/components/MultiSelectCombobox.test.tsx
git commit -m "feat(web): add reusable MultiSelectCombobox (countries/modes)"
```

---

### Task 6: Web FF query hooks + List page + route + nav

**Files:**
- Modify: `apps/web/src/features/masters/useMasters.ts`
- Create: `apps/web/src/features/masters/freight-forwarders/FreightForwardersListPage.tsx`
- Test: `apps/web/src/features/masters/freight-forwarders/FreightForwardersListPage.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AppLayout.tsx`

**Interfaces:**
- Consumes: `FreightForwarderDto`, `Paginated`, `Role`, `fetchJson`, `useFreightForwarders`.
- Produces: `useFreightForwarders`, `useFreightForwarder`; route `/masters/freight-forwarders`.

- [ ] **Step 1: Add the query hooks**

Append to `apps/web/src/features/masters/useMasters.ts` (it already imports `useQuery`, `fetchJson`, `Paginated`; add the DTO import):
```typescript
import type { FreightForwarderDto } from "@svyft/shared";

export function useFreightForwarders(params: { q: string; page: number; pageSize: number }) {
  const { q, page, pageSize } = params;
  return useQuery({
    queryKey: ["freight-forwarders", q, page, pageSize],
    queryFn: () =>
      fetchJson<Paginated<FreightForwarderDto>>(
        `/api/freight-forwarders?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
      ),
  });
}

export function useFreightForwarder(id: string | undefined) {
  return useQuery({
    queryKey: ["freight-forwarder", id],
    queryFn: () => fetchJson<FreightForwarderDto>(`/api/freight-forwarders/${id}`),
    enabled: !!id,
  });
}
```

- [ ] **Step 2: Write the failing list test**

Create `apps/web/src/features/masters/freight-forwarders/FreightForwardersListPage.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { FreightForwardersListPage } from "./FreightForwardersListPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderList(role: string) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role } } };
      if (url.includes("/api/freight-forwarders"))
        return {
          status: 200,
          body: {
            items: [
              {
                id: "f1",
                freightForwarderCode: "FF-0001",
                companyName: "Acme Freight",
                pic: "Jane",
                contactNumber: "+15551234567",
                email: "ops@acme.example",
                availableCountries: ["US", "SG"],
                modes: ["AIR", "SEA"],
                handleDg: true,
                status: "ACTIVE",
              },
            ],
            total: 1,
            page: 1,
            pageSize: 10,
          },
        };
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter>
          <FreightForwardersListPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("FreightForwardersListPage", () => {
  it("lists FFs and shows New for a Manager", async () => {
    renderList("MANAGER");
    await waitFor(() => expect(screen.getByText("Acme Freight")).toBeInTheDocument());
    expect(screen.getByText("FF-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new freight forwarder/i })).toBeInTheDocument();
  });

  it("hides New for an Executive", async () => {
    renderList("EXECUTIVE");
    await waitFor(() => expect(screen.getByText("Acme Freight")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /new freight forwarder/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @svyft/web test FreightForwardersListPage`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the list page**

Create `apps/web/src/features/masters/freight-forwarders/FreightForwardersListPage.tsx`:
```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { useFreightForwarders } from "../useMasters";
import { Input } from "@/components/ui/input";
import { PaginationBar } from "@/components/PaginationBar";

export function FreightForwardersListPage() {
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const canWrite = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;
  const { data, isLoading } = useFreightForwarders({ q, page, pageSize });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">Freight Forwarders</h1>
        {canWrite && (
          <Link
            to="/masters/freight-forwarders/new"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            New freight forwarder
          </Link>
        )}
      </div>
      <Input
        placeholder="Search company, code, PIC, email…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setPage(1); }}
      />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">PIC</th>
                <th className="px-4 py-2 font-medium">Modes</th>
                <th className="px-4 py-2 font-medium">DG</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.length ? (
                data.items.map((f) => (
                  <tr key={f.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2 font-mono tabular-nums text-muted-foreground">{f.freightForwarderCode}</td>
                    <td className="px-4 py-2">
                      <Link to={`/masters/freight-forwarders/${f.id}`} className="font-medium text-primary hover:underline">
                        {f.companyName}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{f.pic}</td>
                    <td className="px-4 py-2">{f.modes.join(", ")}</td>
                    <td className="px-4 py-2 text-muted-foreground">{f.handleDg ? "Yes" : "No"}</td>
                    <td className="px-4 py-2 text-muted-foreground">{f.status}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {q ? "No freight forwarders match your search." : "No freight forwarders yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      />
    </div>
  );
}
```

- [ ] **Step 5: Wire the route + nav**

In `apps/web/src/App.tsx`, import the page and add the list route (next to the vessels routes):
```tsx
import { FreightForwardersListPage } from "@/features/masters/freight-forwarders/FreightForwardersListPage";
// ...
<Route
  path="/masters/freight-forwarders"
  element={
    <Protected>
      <FreightForwardersListPage />
    </Protected>
  }
/>
```

In `apps/web/src/components/AppLayout.tsx`, add the nav link after the Vessels link (after line 29):
```tsx
<Link to="/masters/freight-forwarders" className="text-muted-foreground hover:text-foreground">
  Forwarders
</Link>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @svyft/web test FreightForwardersListPage`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/masters/useMasters.ts apps/web/src/features/masters/freight-forwarders/FreightForwardersListPage.tsx apps/web/src/features/masters/freight-forwarders/FreightForwardersListPage.test.tsx apps/web/src/App.tsx apps/web/src/components/AppLayout.tsx
git commit -m "feat(web): add FF Master list page, hooks, route, and nav link"
```

---

### Task 7: Web FF editor form + routes

**Files:**
- Create: `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx`
- Test: `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `freightForwarderCreateSchema`, `FreightForwarderCreateInput`, `FREIGHT_MODES`, `COUNTRIES`, `CURRENCIES` (`@svyft/shared`); `useFreightForwarder`, `postJson`, `patchJson`, `MultiSelectCombobox`.
- Produces: routes `/masters/freight-forwarders/new` and `/masters/freight-forwarders/:id`.

- [ ] **Step 1: Write the failing form test**

Create `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { FreightForwarderFormPage } from "./FreightForwarderFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/masters/freight-forwarders/new"]}>
          <Routes>
            <Route path="/masters/freight-forwarders/new" element={<FreightForwarderFormPage />} />
            <Route path="/masters/freight-forwarders" element={<p>ff list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("FreightForwarderFormPage (create)", () => {
  it("blocks submit and shows an error when required fields are missing", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        return { status: 404 };
      }),
    );
    renderForm();
    await userEvent.click(await screen.findByRole("button", { name: /save/i }));
    expect(await screen.findByText(/select at least one mode/i)).toBeInTheDocument();
  });

  it("submits a valid FF and navigates to the list", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST") {
          calls.push("create");
          return { status: 201, body: { id: "f9", freightForwarderCode: "FF-0009" } };
        }
        return { status: 404 };
      }),
    );
    renderForm();
    await userEvent.type(await screen.findByLabelText(/company name/i), "Acme Freight");
    await userEvent.type(screen.getByLabelText(/person in charge/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+15551234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ops@acme.example");
    // countries
    await userEvent.click(screen.getByRole("button", { name: /countries/i }));
    await userEvent.click(await screen.findByText("Singapore"));
    // modes
    await userEvent.click(screen.getByRole("button", { name: /^modes$/i }));
    await userEvent.click(await screen.findByText("AIR"));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("ff list")).toBeInTheDocument());
    expect(calls).toContain("create");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/web test FreightForwarderFormPage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the form page**

Create `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx`:
```tsx
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import {
  freightForwarderCreateSchema,
  FREIGHT_MODES,
  COUNTRIES,
  CURRENCIES,
  type FreightForwarderCreateInput,
} from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useFreightForwarder } from "../useMasters";
import { MultiSelectCombobox } from "@/components/MultiSelectCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MODE_OPTS = FREIGHT_MODES.map((m) => ({ code: m, name: m }));
const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function FreightForwarderFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useFreightForwarder(id);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FreightForwarderCreateInput>({
    resolver: zodResolver(freightForwarderCreateSchema),
    defaultValues: { availableCountries: [], modes: [], handleDg: false },
  });

  useEffect(() => {
    if (existing.data) {
      reset({
        companyName: existing.data.companyName,
        companyAddress: existing.data.companyAddress ?? undefined,
        pic: existing.data.pic,
        contactNumber: existing.data.contactNumber,
        email: existing.data.email,
        availableCountries: existing.data.availableCountries,
        modes: existing.data.modes,
        handleDg: existing.data.handleDg,
        vatTrnEori: existing.data.vatTrnEori ?? undefined,
        whLocation: existing.data.whLocation ?? undefined,
        defaultCurrency: existing.data.defaultCurrency ?? undefined,
        paymentTerms: existing.data.paymentTerms ?? undefined,
        typicalLeadTime: existing.data.typicalLeadTime ?? undefined,
        status: existing.data.status,
      });
    }
  }, [existing.data, reset]);

  async function onSubmit(values: FreightForwarderCreateInput) {
    if (id) await patchJson(`/api/freight-forwarders/${id}`, values);
    else await postJson("/api/freight-forwarders", values);
    navigate("/masters/freight-forwarders");
  }

  const err = (name: keyof FreightForwarderCreateInput) =>
    errors[name] ? (
      <p role="alert" className="text-sm text-destructive">
        {errors[name]?.message as string}
      </p>
    ) : null;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg space-y-4" aria-label="Freight forwarder form">
      <h1 className="font-display text-xl font-semibold tracking-tight">
        {id ? "Edit freight forwarder" : "New freight forwarder"}
      </h1>

      <div className="space-y-1">
        <Label htmlFor="companyName">Company name</Label>
        <Input id="companyName" {...register("companyName")} />
        {err("companyName")}
      </div>
      <div className="space-y-1">
        <Label htmlFor="companyAddress">Company address</Label>
        <Input id="companyAddress" {...register("companyAddress")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pic">Person in charge</Label>
        <Input id="pic" {...register("pic")} />
        {err("pic")}
      </div>
      <div className="space-y-1">
        <Label htmlFor="contactNumber">Contact number</Label>
        <Input id="contactNumber" placeholder="+15551234567" {...register("contactNumber")} />
        {err("contactNumber")}
      </div>
      <div className="space-y-1">
        <Label htmlFor="email">Email</Label>
        <Input id="email" {...register("email")} />
        {err("email")}
      </div>

      <div className="space-y-1">
        <Label>Available countries</Label>
        <Controller
          control={control}
          name="availableCountries"
          render={({ field }) => (
            <MultiSelectCombobox value={field.value ?? []} options={COUNTRIES} onChange={field.onChange} ariaLabel="Countries" />
          )}
        />
        {err("availableCountries")}
      </div>
      <div className="space-y-1">
        <Label>Modes</Label>
        <Controller
          control={control}
          name="modes"
          render={({ field }) => (
            <MultiSelectCombobox value={field.value ?? []} options={MODE_OPTS} onChange={field.onChange} ariaLabel="Modes" />
          )}
        />
        {err("modes")}
      </div>

      <label className="flex items-center gap-2">
        <input type="checkbox" {...register("handleDg")} />
        <span className="text-sm">Handles Dangerous Goods (DG)</span>
      </label>

      <div className="space-y-1">
        <Label htmlFor="defaultCurrency">Default currency</Label>
        <select id="defaultCurrency" {...register("defaultCurrency")} className={selectClass}>
          <option value="">—</option>
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="vatTrnEori">VAT / TRN / EORI</Label>
        <Input id="vatTrnEori" {...register("vatTrnEori")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="whLocation">Warehouse location</Label>
        <Input id="whLocation" {...register("whLocation")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="paymentTerms">Payment terms</Label>
        <Input id="paymentTerms" placeholder="NET 30" {...register("paymentTerms")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="typicalLeadTime">Typical lead time</Label>
        <Input id="typicalLeadTime" placeholder="2d" {...register("typicalLeadTime")} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="status">Status</Label>
        <select id="status" {...register("status")} className={selectClass}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 4: Wire the new/edit routes**

In `apps/web/src/App.tsx`, import the form and add the two routes (next to the list route from Task 6):
```tsx
import { FreightForwarderFormPage } from "@/features/masters/freight-forwarders/FreightForwarderFormPage";
// ...
<Route
  path="/masters/freight-forwarders/new"
  element={
    <Protected>
      <FreightForwarderFormPage />
    </Protected>
  }
/>
<Route
  path="/masters/freight-forwarders/:id"
  element={
    <Protected>
      <FreightForwarderFormPage />
    </Protected>
  }
/>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @svyft/web test FreightForwarderFormPage`
Expected: PASS (2 tests).

- [ ] **Step 6: Full check — typecheck + all suites**

Run:
```bash
pnpm --filter @svyft/shared test && pnpm --filter @svyft/web test && pnpm --filter @svyft/api test
pnpm --filter @svyft/web exec tsc --noEmit
```
Expected: all suites PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.test.tsx apps/web/src/App.tsx
git commit -m "feat(web): add FF Master editor form (multi-selects, DG, currency)"
```

---

## Self-Review

**Spec coverage (Functional Spec §6 + Technical Design sub-build 1):**
- FF Master fields (companyName, address, PIC, contact, email, countries, modes, handleDg, VAT/EORI, W/H, currency, payment terms, lead time, status) → Task 2 (schema) + Task 3 (model) + Task 7 (form). ✓
- Eligibility source fields (`availableCountries`, `modes`, `handleDg`) present + queryable → Task 3. ✓ *(the eligibility filter itself is sub-build 3.)*
- Admin/Manager-governed writes, all-role reads → Task 4 RBAC + Task 6 role-gated "New". ✓
- Active/Inactive; inactive excluded from future eligible lists → `status` field (Task 2/3); the exclusion filter lands in sub-build 3. ✓
- `FF-####` code (house consistency) → Task 3/4. ✓
- Static currency + country lists (O-S4-2) → Task 1. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; the country/currency lists are the real MVP static set. One conditional note (badge.tsx existence check) is an explicit guarded instruction, not a placeholder. ✓

**Type consistency:** `freightForwarderCreateSchema`/`FreightForwarderCreateInput`/`FreightForwarderDto` names identical across Tasks 2, 4, 6, 7. `useFreightForwarders`/`useFreightForwarder` identical across Tasks 6, 7. `MultiSelectCombobox` prop shape (`value/options/onChange/ariaLabel`) identical in Tasks 5 and 7. Route path `/masters/freight-forwarders` identical across Tasks 6, 7 and the nav. ✓

**Out-of-scope (correctly deferred to later sub-builds):** eligibility filtering, RFQ generation, portal — none appear here. ✓

---

## Execution Handoff

Plan complete and saved to `docs/Stage 4 - Sub-build 1 - FF Master - Implementation Plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
