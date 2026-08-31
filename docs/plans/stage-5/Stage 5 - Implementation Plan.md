# Stage 5 — Compare Quotes & Award — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Design of record: [`docs/Stage 5 - Compare Quotes - Design.md`](../../Stage%205%20-%20Compare%20Quotes%20-%20Design.md). This plan realises that design. **S5.1 below is fully detailed and ready to execute; S5.2–S5.6 are scoped task outlines — each gets its own detailed, bite-sized plan (in this folder) when reached, mirroring Stage 4.**

**Goal:** Build the internal Compare-Quotes → recommend → maker-checker approve → award workflow that turns Stage-4's per-leg quotes into an approved selection and moves the query to `Quoting Client`.

**Architecture:** Pure domain logic (FX conversion, recommendation, USD totals) lives in `@svyft/shared`; one NestJS module per concern wires it to Prisma/HTTP; all status changes flow through the existing `StatusService.fire` one-door; the React screen reuses the Stage-4 workspace shell. Six independently-mergeable sub-builds (S5.1…S5.6), sequenced by dependency.

**Tech Stack:** pnpm monorepo · NestJS + Prisma/Postgres (`apps/api`) · React/Vite + TanStack Query + shadcn (`apps/web`) · pure-TS + Zod (`packages/shared`). Node `>=20 <21`, pnpm `9.12.0`.

---

## Global Constraints

_Every task's requirements implicitly include this section._

- **The gate:** `pnpm run ci` (lint + typecheck + test + build) must be green before any PR. Run `pnpm run lint` before every commit (CI's `build-test` runs it; a lint miss red'd a PR before).
- **Base branch:** `main` **after PR #51 is merged** (the go-live cutover). S5.1 is `#51`-independent and may start on `main` first; S5.2+ consume the v3 `draftJson`/`computeQuoteTotals` model that #51 brings. Each sub-build = a fresh worktree off the base, created at execution time via `superpowers:using-git-worktrees`. **Fresh-worktree setup:** `pnpm -C <worktree> install`; copy `apps/api/.env` from the main checkout; `pnpm exec prisma generate --schema prisma/schema.prisma`; **`pnpm --filter @svyft/shared build`**.
- **Prisma:** schema lives at the **repo root** `prisma/schema.prisma` — always pass `--schema prisma/schema.prisma`. **Author migrations by hand + `prisma migrate deploy`** — `prisma migrate dev` drifts on the generated `volumeCbm` column (PG 42601). Migrations are **additive** (no destructive changes in Stage 5).
- **Rebuild `@svyft/shared` after editing it** (`pnpm --filter @svyft/shared build`) — api/web resolve its compiled `dist`.
- **Shared enums:** `const` object + union type + `Object.values(...) as [X, ...X[]]`, pinned by a `toEqual` test. **Never a TS `enum`.**
- **vitest/jest transpile but do NOT type-check** — run `pnpm run typecheck` (or per-workspace `tsc`) as a separate step.
- **API e2e:** need a real Postgres (local `:5433`). Each spec: boots `AppModule`; sets `process.env.JWT_ACCESS_SECRET` at the top of the file; mints cookies via `JwtService` (`{ sub, role, tenantId }`); **namespaces its rows with a per-file prefix and deletes them in `afterAll`**; calls `seedReferenceData(prisma)` in `beforeAll` if it needs reference data; **MUST `await app.close()` in `afterAll`** (the `@nestjs/schedule` cron keeps the process alive → jest hangs forever otherwise).
- **RBAC (Design §4):** maker actions (compare/shortlist/negotiate/send) = **Executive+**, auth-only (no `@Roles`). Checker actions (approve/reject/generate) = **`@Roles(Role.ADMINISTRATOR, Role.MANAGER)`** + a **four-eyes** guard (actor ≠ `sentByUserId`). FX-rate writes = `@Roles(ADMINISTRATOR, MANAGER)`.
- **Money = `Decimal`**; FX rate = `Decimal(18,8)`, money `Decimal(14,2)`, weights `Decimal(12,3)`.
- **Errors:** validation → `ZodValidationPipe` (`400 {message, issues}`); Prisma codes → `PrismaExceptionFilter` (P2025→404, P2002→409; **P2003 is NOT mapped** — guard FKs in services). Don't hand-roll these.
- **Extensibility Core:** never edit a Stage-3 status file; add machine edges via `StatusRegistry.contribute(key, [...])` in a module `onModuleInit`; every status change goes through `StatusService.fire` (it owns its own tx — call it **after** the create/update `$transaction`).

---

## File-Structure Map

| Area | Files (by sub-build) |
| :-- | :-- |
| **Shared** | `packages/shared/src/fx.ts` (S5.1) · `recommend.ts` (S5.2) · `award.ts` — decision/offer/snapshot DTOs (S5.2/S5.3) · additions to `status.ts` (S5.3) · re-exports in `index.ts` |
| **Prisma** | `FxRate` (S5.1) · `LegAwardDecision`/`AwardDecisionEvent`/`AwardDecisionStatus` enum + `Query.awardSnapshot` + `StatusTransition.reason` + enum values `QueryStatus.QUOTING_CLIENT`/`LegStatus.APPROVED` (S5.3); migrations `add_fx_rate`, `add_award_decision` |
| **API** | `modules/fx-rates/*` (S5.1) · `modules/comparison/*` — read model (S5.2) · `modules/award/*` — decisions, endpoints, machine contributes, four-eyes guard (S5.3/S5.4) · `modules/award/negotiation.*` + a change-order reversal listener (S5.5) · `FireContext.reason` plumbing in `modules/status/*` (S5.3) |
| **Web** | `features/masters/fx-rates/*` (S5.1) · `features/compare/*` — the screen (S5.6) · `RouteDiagram` `selectedLegId` prop + `StageRail` "Quotes" wiring (S5.6) |

---

## Sub-build sequencing & gates

`S5.1 → S5.2 → S5.3 → S5.4 → (S5.5 ∥ S5.6)`. Each ends green on `pnpm run ci` + an **opus whole-branch review**, then PR → base. Acceptance gate per SB is its final "run ci" step.

---

## S5.1 — FX Master  *(detailed, ready to execute)*

**Goal:** An append-only, admin-managed currency→USD rate table, a pure `toUsd` helper, and a `masters/fx-rates` admin screen. Foundation for the USD-normalised comparison (S5.2). **Independent of PR #51.**

**Files:**
- Modify: `prisma/schema.prisma` (add `FxRate`)
- Create: `prisma/migrations/20260814000000_add_fx_rate/migration.sql`
- Create: `packages/shared/src/fx.ts`, `packages/shared/src/fx.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export)
- Create: `apps/api/src/modules/fx-rates/{fx-rates.service.ts,fx-rates.controller.ts,fx-rates.module.ts}`
- Modify: `apps/api/src/app.module.ts` (register `FxRatesModule`)
- Create: `apps/api/test/fx-rates.e2e-spec.ts`
- Create: `apps/web/src/features/masters/fx-rates/{FxRatesPage.tsx,useFxRates.ts,FxRatesPage.test.tsx}`
- Modify: `apps/web/src/App.tsx` (route) + the masters nav entry

### Task 1 — `FxRate` model + migration

**Interfaces — Produces:** Prisma model `FxRate { id, tenantId?, currency, unitsPerUsd, effectiveFrom, note?, createdById?, createdAt }`.

- [ ] **Step 1: Add the model** to `prisma/schema.prisma`:
```prisma
model FxRate {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String?  @db.Uuid
  currency     String                          // ISO-4217, non-USD (USD ≡ 1, never stored)
  unitsPerUsd  Decimal  @db.Decimal(18, 8)     // 83.20000000 → 1 USD = 83.2 <currency>
  effectiveFrom DateTime @default(now())
  note         String?
  createdById  String?  @db.Uuid
  createdAt    DateTime @default(now())

  @@index([currency, effectiveFrom])
}
```
- [ ] **Step 2: Hand-author** `prisma/migrations/20260814000000_add_fx_rate/migration.sql`:
```sql
CREATE TABLE "FxRate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "currency" TEXT NOT NULL,
  "unitsPerUsd" DECIMAL(18,8) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FxRate_currency_effectiveFrom_idx" ON "FxRate"("currency", "effectiveFrom");
```
- [ ] **Step 3: Apply + generate.** Run:
```bash
pnpm exec prisma migrate deploy --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma
```
Expected: migration applied; `prisma.fxRate` exists on the client.
- [ ] **Step 4: Verify it typechecks.** Run `pnpm --filter @svyft/api build`. Expected: PASS (nest build typechecks the new model usage-free schema).
- [ ] **Step 5: Commit** — `git add prisma/ && git commit -m "feat(stage5): add FxRate model + migration"`

### Task 2 — shared `fx.ts` (schema + `toUsd` + `latestRateByCurrency`)

**Interfaces — Produces:**
- `fxRateCreateSchema: ZodSchema` → `FxRateCreateInput = { currency: CurrencyCode; unitsPerUsd: number; effectiveFrom?: string; note?: string }`
- `type FxRateDto = { id; currency; unitsPerUsd: number; effectiveFrom: string; note: string|null; createdById: string|null; createdAt: string }`
- `toUsd(amount: number, currency: string, rate: Pick<FxRateDto,"unitsPerUsd"> | null): number | null`
- `latestRateByCurrency(rates: FxRateDto[]): Map<string, FxRateDto>`

- [ ] **Step 1: Write the failing test** `packages/shared/src/fx.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toUsd, latestRateByCurrency, fxRateCreateSchema, type FxRateDto } from "./fx";

const rate = (currency: string, unitsPerUsd: number, effectiveFrom: string): FxRateDto => ({
  id: `${currency}-${effectiveFrom}`, currency, unitsPerUsd, effectiveFrom,
  note: null, createdById: null, createdAt: effectiveFrom,
});

describe("toUsd", () => {
  it("passes USD through unchanged, ignoring any rate", () => {
    expect(toUsd(1500, "USD", null)).toBe(1500);
  });
  it("divides by unitsPerUsd for a foreign currency", () => {
    expect(toUsd(83200, "INR", { unitsPerUsd: 83.2 })).toBe(1000);
  });
  it("rounds to cents", () => {
    expect(toUsd(100, "INR", { unitsPerUsd: 83.2 })).toBe(1.2); // 1.2019… → 1.20
  });
  it("returns null when a foreign currency has no rate", () => {
    expect(toUsd(1000, "INR", null)).toBeNull();
  });
});

describe("latestRateByCurrency", () => {
  it("keeps the newest effectiveFrom per currency", () => {
    const m = latestRateByCurrency([
      rate("INR", 82, "2026-08-01T00:00:00.000Z"),
      rate("INR", 83.2, "2026-08-10T00:00:00.000Z"),
      rate("EUR", 0.92, "2026-08-05T00:00:00.000Z"),
    ]);
    expect(m.get("INR")?.unitsPerUsd).toBe(83.2);
    expect(m.get("EUR")?.unitsPerUsd).toBe(0.92);
  });
});

describe("fxRateCreateSchema", () => {
  it("rejects USD (base currency, never stored)", () => {
    expect(fxRateCreateSchema.safeParse({ currency: "USD", unitsPerUsd: 1 }).success).toBe(false);
  });
  it("rejects a non-positive rate", () => {
    expect(fxRateCreateSchema.safeParse({ currency: "INR", unitsPerUsd: 0 }).success).toBe(false);
  });
  it("accepts a valid foreign rate", () => {
    expect(fxRateCreateSchema.safeParse({ currency: "INR", unitsPerUsd: 83.2 }).success).toBe(true);
  });
});
```
- [ ] **Step 2: Run it to verify it fails.** `pnpm --filter @svyft/shared test -- src/fx.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `packages/shared/src/fx.ts`:
```ts
import { z } from "zod";
import { CURRENCY_CODES } from "./reference";

export const fxRateCreateSchema = z.object({
  currency: z.enum(CURRENCY_CODES).refine((c) => c !== "USD", { message: "USD is the base currency (rate ≡ 1) and is never stored" }),
  unitsPerUsd: z.number().positive(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).optional(),
});
export type FxRateCreateInput = z.infer<typeof fxRateCreateSchema>;

export type FxRateDto = {
  id: string;
  currency: string;
  unitsPerUsd: number;
  effectiveFrom: string;
  note: string | null;
  createdById: string | null;
  createdAt: string;
};

/** Normalise a native amount to USD. USD passes through; a foreign currency needs a rate. */
export function toUsd(amount: number, currency: string, rate: Pick<FxRateDto, "unitsPerUsd"> | null): number | null {
  if (currency === "USD") return amount;
  if (!rate) return null;
  return Math.round((amount / rate.unitsPerUsd) * 100) / 100;
}

/** Latest (max effectiveFrom) rate per currency. */
export function latestRateByCurrency(rates: FxRateDto[]): Map<string, FxRateDto> {
  const m = new Map<string, FxRateDto>();
  for (const r of rates) {
    const cur = m.get(r.currency);
    if (!cur || r.effectiveFrom > cur.effectiveFrom) m.set(r.currency, r);
  }
  return m;
}
```
- [ ] **Step 4: Re-export** — add `export * from "./fx";` to `packages/shared/src/index.ts`.
- [ ] **Step 5: Run tests to verify they pass + build shared.** `pnpm --filter @svyft/shared test -- src/fx.test.ts` → PASS; then `pnpm --filter @svyft/shared build`.
- [ ] **Step 6: Commit** — `git commit -am "feat(stage5): shared FX schema + toUsd + latestRateByCurrency"`

### Task 3 — `fx-rates` API module (list + create, RBAC) + e2e

**Interfaces — Consumes:** `fxRateCreateSchema`, `FxRateDto` (Task 2); `FxRate` model (Task 1). **Produces:** `GET /api/fx-rates` → `FxRateDto[]` (newest first); `POST /api/fx-rates` (Manager+) → `FxRateDto`.

- [ ] **Step 1: Write the failing e2e** `apps/api/test/fx-rates.e2e-spec.ts` (mirror `vessels.e2e-spec.ts`'s harness — boot AppModule, cookieParser, `PrismaExceptionFilter`, `setGlobalPrefix("api")`, `afterAll` deletes the `NOTE`-prefixed rows **and `await app.close()`**):
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
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

const NOTE = "FX E2E";

describe("FxRates (e2e)", () => {
  let app: INestApplication; let prisma: PrismaService; let jwt: JwtService;
  const cookie = (role: Role) => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService); jwt = moduleRef.get(JwtService);
    await prisma.fxRate.deleteMany({ where: { note: { startsWith: NOTE } } });
  });
  afterAll(async () => {
    await prisma.fxRate.deleteMany({ where: { note: { startsWith: NOTE } } });
    await app.close();
  });

  it("Manager can create a rate (201) and it appears in the list", async () => {
    const create = await request(app.getHttpServer())
      .post("/api/fx-rates").set("Cookie", cookie(Role.MANAGER))
      .send({ currency: "INR", unitsPerUsd: 83.2, note: `${NOTE} inr` });
    expect(create.status).toBe(201);
    expect(create.body.currency).toBe("INR");
    const list = await request(app.getHttpServer()).get("/api/fx-rates").set("Cookie", cookie(Role.EXECUTIVE));
    expect(list.status).toBe(200);
    expect(list.body.some((r: { note: string }) => r.note === `${NOTE} inr`)).toBe(true);
  });

  it("Executive cannot create a rate (403)", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/fx-rates").set("Cookie", cookie(Role.EXECUTIVE))
      .send({ currency: "EUR", unitsPerUsd: 0.92, note: `${NOTE} eur` });
    expect(res.status).toBe(403);
  });

  it("rejects USD and non-positive rates (400)", async () => {
    for (const body of [{ currency: "USD", unitsPerUsd: 1 }, { currency: "INR", unitsPerUsd: -1 }]) {
      const res = await request(app.getHttpServer())
        .post("/api/fx-rates").set("Cookie", cookie(Role.MANAGER)).send(body);
      expect(res.status).toBe(400);
    }
  });
});
```
- [ ] **Step 2: Run it to verify it fails.** `pnpm --filter @svyft/api test -- fx-rates.e2e-spec.ts` → FAIL (404/route missing).
- [ ] **Step 3: Implement the service** `apps/api/src/modules/fx-rates/fx-rates.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import type { FxRateCreateInput, FxRateDto } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class FxRatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<FxRateDto[]> {
    const rows = await this.prisma.fxRate.findMany({ orderBy: { effectiveFrom: "desc" } });
    return rows.map((r) => ({
      id: r.id, currency: r.currency, unitsPerUsd: Number(r.unitsPerUsd),
      effectiveFrom: r.effectiveFrom.toISOString(), note: r.note,
      createdById: r.createdById, createdAt: r.createdAt.toISOString(),
    }));
  }

  async create(input: FxRateCreateInput, createdById: string): Promise<FxRateDto> {
    const r = await this.prisma.fxRate.create({
      data: {
        currency: input.currency, unitsPerUsd: input.unitsPerUsd,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
        note: input.note ?? null, createdById,
      },
    });
    return {
      id: r.id, currency: r.currency, unitsPerUsd: Number(r.unitsPerUsd),
      effectiveFrom: r.effectiveFrom.toISOString(), note: r.note,
      createdById: r.createdById, createdAt: r.createdAt.toISOString(),
    };
  }
}
```
- [ ] **Step 4: Implement the controller** `fx-rates.controller.ts` (mirror `freight-forwarders.controller.ts`):
```ts
import { Body, Controller, Get, Post } from "@nestjs/common";
import { Role, fxRateCreateSchema } from "@svyft/shared";
import type { FxRateCreateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { FxRatesService } from "./fx-rates.service";

@Controller("fx-rates")
export class FxRatesController {
  constructor(private readonly fx: FxRatesService) {}

  @Get()
  list() { return this.fx.list(); }              // auth-only (Executive+)

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(
    @Body(new ZodValidationPipe(fxRateCreateSchema)) body: FxRateCreateInput,
    @CurrentUser() user: RequestUser,
  ) { return this.fx.create(body, user.sub); }
}
```
- [ ] **Step 5: Module + register.** Create `fx-rates.module.ts` (`@Module({ controllers: [FxRatesController], providers: [FxRatesService] })`, importing `PrismaModule` the same way `FreightForwardersModule` does) and add `FxRatesModule` to `app.module.ts`'s `imports`.
- [ ] **Step 6: Run e2e + lint.** `pnpm --filter @svyft/api test -- fx-rates.e2e-spec.ts` → PASS; `pnpm run lint`.
- [ ] **Step 7: Commit** — `git commit -am "feat(stage5): fx-rates module (list Executive+, create Manager+) + e2e"`

### Task 4 — `masters/fx-rates` web screen

**Interfaces — Consumes:** `GET/POST /api/fx-rates`, `fxRateCreateSchema`, `FxRateDto`, `CURRENCY_CODES`.

- [ ] **Step 1: Write the failing test** `FxRatesPage.test.tsx` (mirror an existing masters test + `renderWithProviders`/`mockFetch`): asserts the list renders a seeded INR row, and submitting the add-form calls `POST /api/fx-rates` with `{currency:"INR", unitsPerUsd:83.2}`.
- [ ] **Step 2: Run it → FAIL.** `pnpm --filter @svyft/web test -- FxRatesPage.test.tsx`.
- [ ] **Step 3: Implement `useFxRates.ts`** — `useFxRatesList()` (`useQuery(["fx-rates"], () => fetchJson<FxRateDto[]>("/fx-rates"))`) and `useCreateFxRate()` (`useMutation((b: FxRateCreateInput) => postJson("/fx-rates", b))`, invalidates `["fx-rates"]`).
- [ ] **Step 4: Implement `FxRatesPage.tsx`** — a masters-style table (Currency · Units/USD · Effective from · Note) + an **Add rate** form (RHF + `zodResolver(fxRateCreateSchema)`; currency `Select` over `CURRENCY_CODES.filter(c => c !== "USD")`; `unitsPerUsd` number; optional `effectiveFrom` via `ZonedDateTimeField`; note). Render the add-form only when the current user is Manager+ (role from the existing auth/`useCurrentUser` hook); the table is visible to all.
- [ ] **Step 5: Route + nav** — add `/masters/fx-rates` in `App.tsx` (inside `AppLayout`/`ProtectedRoute`, same as other masters) and a masters-nav link.
- [ ] **Step 6: Run test + typecheck + lint.** `pnpm --filter @svyft/web test -- FxRatesPage.test.tsx` → PASS; `pnpm --filter @svyft/web exec tsc --noEmit`; `pnpm run lint`.
- [ ] **Step 7: Commit** — `git commit -am "feat(stage5): masters/fx-rates admin screen"`

### S5.1 acceptance
- [ ] **Run the full gate:** `pnpm run ci` → green. Then opus whole-branch review → PR.

---

## S5.2 — Comparison engine (shared) + read model  *(scoped; needs #51 base)*

**Goal:** The USD-normalised, per-`(FF×variant)` comparison read model + the recommendation, with no writes.

**Files:** `packages/shared/src/recommend.ts` (+ test); `packages/shared/src/award.ts` (DTOs: `OfferDto`, `LegComparisonDto`, `RecommendationDto`); `apps/api/src/modules/comparison/{comparison.service.ts,comparison.controller.ts,comparison.module.ts}` (+ e2e).

**Key interfaces (Produces):**
- `recommendOffer(input: { priority: Priority; offers: { quoteId: string; variant: ChargeRateVariant|null; usdTotal: number|null; transitDays: number; submittedAt: string }[] }): { quoteId: string; variant: ChargeRateVariant|null } | null` — High/Urgent → min transit, tie→min USD, tie→earliest; Medium/Low → min USD, tie→min transit, tie→earliest; unpriced (usdTotal null) excluded.
- `GET /api/queries/:id/comparison` → `{ legs: LegComparisonDto[] }` where each leg carries its offers (native + USD totals via `computeQuoteTotals`+`toUsd` off each quote's `draftJson`, `transitDays`, `chargeableWeight`, `validUntil`, `quoteStatus`, per-currency `{unitsPerUsd, rateAsOf}`), the live `recommendation`, and (once S5.3 lands) the `LegAwardDecision` + timeline. Executive+.

**Tasks (bite-sized plan authored at execution):** (1) `recommend.ts` + full test matrix (each priority branch, transit-tie→price, price-tie→transit, single-variant, one-variant-priced, unpriced-excluded, Urgent≡High). (2) `award.ts` DTOs. (3) `comparison.service` — load quotes for the query, per quote run `computeQuoteTotals(draftJson)` → per-variant offers, attach latest FX (via `FxRatesService`/`latestRateByCurrency`) → `toUsd`, compute `recommendOffer`. (4) `comparison.controller` `GET …/comparison` + e2e (a 2-FF Road leg, INR+EUR quotes, asserts USD normalisation + the recommended offer under a High-priority query).

**Acceptance:** `pnpm run ci` green; e2e proves USD ranking + recommendation.

---

## S5.3 — Status & decision foundations  *(scoped; migration)*

**Goal:** The headless state layer for the maker-checker: enum + machine additions, the decision/event tables, reason-on-transition, and the award snapshot.

**Files:** `prisma/schema.prisma` (+ `add_award_decision` migration): `QueryStatus += QUOTING_CLIENT`, `LegStatus += APPROVED`, `LegAwardDecision`, `AwardDecisionEvent`, `AwardDecisionStatus` enum, `Query.awardSnapshot Json?`, `StatusTransition.reason String?`. Shared `status.ts` (mirror enum values + new `QuoteEvent`/`LegEvent` + labels/variants; pinned `toEqual` tests) + `deriveQueryStatus` `quotingClient` milestone + `APPROVED` in `LEG_RANK`. `apps/api/src/modules/status/*`: `FireContext.reason?` → persisted onto `StatusTransition`. `apps/api/src/modules/award/award.machine.ts` — the contributed quote edges (`QUOTED→APPROVED`, `APPROVED→QUOTED`, `QUOTED/APPROVED→REQUOTED`, `REQUOTED→RFQ_SENT`, `APPROVED→INVALID`) + leg edges (`FULLY_QUOTED→APPROVED`, `APPROVED→FULLY_QUOTED`, `APPROVED→READY_FOR_RFQ`) registered in `onModuleInit`.

**Key interfaces (Produces):** enum values + events; `AwardDecisionDto`/`AwardDecisionEventDto`/`QueryAwardSnapshotDto`; `StatusService.fire(..., { reason })` persists the reason.

**Tasks:** (1) shared enum/event/label additions + pinned tests. (2) migration + Prisma. (3) `FireContext.reason` plumb + a unit test asserting the reason lands on the row. (4) register the contributed edges + a fire-through test per new edge (a pure e2e in the api `test/` dir, no HTTP). **⚠ every full-AppModule e2e MUST `await app.close()`.**

**Acceptance:** `pnpm run ci` green; each new edge fires legally through `StatusService.fire`.

---

## S5.4 — Approval workflow endpoints  *(scoped; four-eyes)*

**Goal:** shortlist / send-for-approval / approve / reject / generate / reopen, firing through the S5.3 machines, with the four-eyes guard and validation A1–A8 (Design §13).

**Files:** `apps/api/src/modules/award/{award.service.ts,award.controller.ts}` (+ e2e); a `FourEyesGuard`/in-service check on `sentByUserId`. Shared `award.ts` request schemas (`shortlistSchema`, `rejectSchema`, …).

**Key interfaces (endpoints, Design §11):** `PUT …/legs/:legId/shortlist` · `POST …/legs/:legId/send-for-approval` · `POST …/legs/:legId/approve` (Manager+, ≠sender) · `POST …/legs/:legId/reject` (Manager+, ≠sender) · `POST …/generate-client-quote` (Manager+) · `POST …/reopen-comparison`. Each writes `LegAwardDecision` + an `AwardDecisionEvent`, fires the relevant quote/leg events with `{ reason }`, and (generate) writes `Query.awardSnapshot` + fires the `quotingClient` milestone.

**Tasks:** per endpoint — failing e2e (happy path + each guard: A2 override-reason, A3 gating, **A4 four-eyes → 403 `SELF_APPROVAL`**, A5 reject-reason, A6 all-approved, A8 stale-409) → implement → green. Recommendation snapshot written at shortlist. **e2e `await app.close()`.**

**Acceptance:** `pnpm run ci` green; the full maker-checker loop (shortlist→send→reject→re-send→approve×N→generate→`QUOTING_CLIENT`→reopen→`QUOTED`) proven end-to-end, four-eyes enforced.

---

## S5.5 — Negotiation / re-quote + change-order reversal  *(scoped)*

**Goal:** the dedicated per-FF re-quote path and the automatic approval-reversal on a change-order.

**Files:** `apps/api/src/modules/award/negotiation.service.ts` + controller route `POST …/legs/:legId/quotes/:quoteId/request-requote` (Executive+); a listener (`@OnEvent("changeorder.leg.reopened")` and/or quote `INVALIDATE`) that resets `LegAwardDecision`→`DRAFT`, fires `REOPEN_AWARD`/`REOPEN`, and clears the `quotingClient` milestone + `awardSnapshot` if the query was `QUOTING_CLIENT`.

**Tasks:** (1) request-requote e2e — fires `REQUEST_REQUOTE` (`QUOTED|APPROVED→REQUOTED`), re-issues the FF token (reuse `RfqTokenService` + reissue path), resets the deadline + re-arms SB5 `ScheduledEvent`s, dispatches `rfq.updated`, fires `SEND`→`RFQ_SENT`; asserts other FFs untouched and an approved leg's approval reversed. (2) change-order reversal e2e — a post-RFQ field edit on an approved leg reverses the approval and drops the query out of `QUOTING_CLIENT`. **e2e `await app.close()`.**

**Acceptance:** `pnpm run ci` green; negotiation is per-FF and change-order reversal holds.

---

## S5.6 — Compare Quotes frontend  *(scoped; the mockup is the visual spec)*

**Goal:** the `/queries/:id/compare` screen (maker + checker modes) per the approved mockup, plus wiring.

**Files:** `apps/web/src/features/compare/*` — `CompareQuotesPage`, `ComparisonGrid` (FF×variant columns, common charges repeated, `NotApplicableCell` greying, click-FF detail), `RecommendationBanner`, `LegAccordion` (single-open, reuse the `LegPanel`/`jumpToLeg` pattern), `DecisionTimeline`, the maker controls (shortlist radios, override-reason, negotiate, send) and the **Manager+-only** checker controls (approve/reject, four-eyes-disabled when viewer==sender), the `QuotingClient` end-state panel. Hooks `useComparison`/`useAwardDecision` + mutations. Modify `RouteDiagram` (`selectedLegId`/`onSelectLeg`) + `StageRail` (wire the "Quotes" step, widen `active`, `isQuotesStageEnabled`) + `App.tsx` route.

**Tasks:** built with `superpowers:frontend-design` against the mockup; component-by-component with vitest + `renderWithProviders`. Checker controls gated on the Manager+ role from `useCurrentUser`; all money shown USD with a native-currency sub-line + the FX rate; live client-side recompute is display-only (server is authoritative).

**Acceptance:** `pnpm run ci` green; a live authed click-through (light+dark, ≥2 legs, both roles) matches the mockup, including the four-eyes-disabled state.

---

## Self-review (against the design)

- **Spec coverage:** FX (D2/§6) → S5.1; recommendation (D3/D4/§7) + read model (§11) → S5.2; enums/decision/reason/snapshot (§5/§8) → S5.3; maker-checker + four-eyes + A1–A8 (§4/§9/§13) → S5.4; negotiation + change-order reversal (§10) → S5.5; the screen (§12) + mockup → S5.6. All §-anchors covered.
- **Placeholder scan:** S5.1 carries real code in every step; S5.2–S5.6 are explicitly scoped outlines whose bite-sized code is authored per-SB at execution time (noted), not silent placeholders.
- **Type consistency:** `toUsd`/`latestRateByCurrency`/`FxRateDto` (S5.1) are consumed unchanged by S5.2's `comparison.service`; `recommendOffer` input matches the offer shape S5.2 builds; RBAC constants (`Role.ADMINISTRATOR/MANAGER`) match the codebase.
