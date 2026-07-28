# Stage 4 · Sub-build 4b — FF Portal Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Work in the **fresh git worktree** already set up on branch `feat/stage-4-sb4b` (off `main`@`b8b852b`).

**Goal:** Build the **headless** FF Portal backend — the token-guarded `/api/ff/rfq/:token/*` boundary + the three portal endpoints (resolve-scope / draft-save / submit) + the submit orchestration (validate → materialize pricing → fire `SUBMIT`) + e2e. **No UI** (SB4c), no live email/TLS/rate-limiting (SB5).

**Architecture:** A new `ff-portal` NestJS module, marked `@Public()` and gated ONLY by a new `RfqTokenGuard` (resolves the raw `:token` → sha256 → `Rfq`, injects a leg-scoped context). It **consumes** SB4a (the pure `@svyft/shared` quote engine + `QuoteDraft`) and the SB2a/2b RFQ/Quote/manifest foundation — no new pricing logic. Drafts are held as a **blob** (`Quote.draftJson`) and **materialized** into the 5 pricing child tables + `Quote` totals only on a validated submit; the quote status fires via the one `StatusService.fire` door **after** the persistence transaction.

**Tech Stack:** NestJS 10 · Prisma 5 (PostgreSQL) · Zod · `@svyft/shared` (pure engine, SB4a) · Jest e2e (api) · Vitest (shared) · pnpm monorepo.

## Global Constraints

Every task implicitly includes this. Values copied verbatim from the design doc (`docs/plans/stage-4/Stage 4 - Sub-build 4b - FF Portal Backend - Design.md`) + Technical Design §5.2/§6/§8.1 + spec §7.4/§10.4/§13.2.

- **Token boundary (NOT JWT/RBAC):** the portal controller is `@Public()` (the SB decorator `apps/api/src/modules/auth/decorators/public.decorator.ts` = `SetMetadata("isPublic", true)` → the global `JwtAuthGuard` skips it; the global `RolesGuard` passes because there is no `@Roles`). `RfqTokenGuard` (`@UseGuards`) is the ONLY real gate. The internal JWT cookie is **never** honored on `/ff/*`.
- **Path:** `@Controller("ff/rfq/:token")` → served at `/api/ff/rfq/:token/*` (under the existing global `/api` prefix; no `main.ts` change).
- **Status via the ONE door:** `StatusService.fire("quote", quoteId, QuoteEvent.SUBMIT, { queryId })` — call it **AFTER** the persistence `$transaction` (fire owns its own tx). **Never edit a Stage-3 status file.** The `LegQuoteProjector` (`@OnEvent("quote.status.changed")`) + `QueryStatusProjector` roll leg/query up **for free**.
- **Engine = SB4a `@svyft/shared`:** `validateQuote(draft, deadlineIso, nowIso)` / `computeQuoteTotals(draft)` / `computeChargeableWeight(grossWtT, cbm, densityKgPerCbm)` / `classifyWarehousePositions(legs, warehousePointIds)`. Pure — pass `nowIso` (no `Date.now()` inside). **Build `@svyft/shared` after any shared edit** (`pnpm --filter @svyft/shared build`; api/web/Vitest read the built dist). Add every new export to `packages/shared/src/index.ts`.
- **Server re-derives IMMUTABLE fields; never trust client immutables.** At submit, the authoritative `QuoteDraft` is assembled with: **mode + cargo `grossWtT`/`cbm`/`isDangerous`** from the frozen `Quote.manifestSnapshot`; **warehouse `position`** from `classifyWarehousePositions` (across the FF's whole leg set); only the **editable** fields (`freightDensity`, charge/trucking/warehouse `amount`+`note`/`remarks`, `transit` dates/carrier, `dgSurchargeNote`, `termsConditions`, `currency`, `quoteValidityUntil`) come from the draft.
- **Decimals:** money (`amount`/`grandTotal`/`carrierSurcharge`) `@db.Decimal(14, 2)`; density + weights `@db.Decimal(12, 3)`. Serialize Decimal → string in any DTO. The engine works in `number` — parse manifest strings at the boundary: `grossWtT = Number(cargo.grossWt) / 1000` (manifest `grossWt` is kg), `cbm = Number(cargo.volumeCbm)`.
- **Findings envelope:** an invalid submit returns **`422 { findings: Finding[] }`** (`{ rule, severity, scope, message }` from `@svyft/shared` `findings.ts`); no writes, no status change.
- **P2003 is unmapped** (`PrismaExceptionFilter` does NOT map it) → guard the `Point` Restrict-FK in the submit service and map to a domain finding / `422`.
- **e2e teardown:** any api e2e booting `AppModule` MUST `await app.close()` in `afterAll` (cron-hang; no `forceExit`) and be self-contained (create+delete its own fixtures). **Mirror the bootstrap + cleanup of `apps/api/test/rfq-state.e2e-spec.ts`.** Portal requests carry the **raw token in the URL** — NO JWT cookie.
- **DB safety:** local Postgres on **`:5433`**. Migrations additive. `prisma migrate dev` needs a TTY in this env → **hand-author `migration.sql` + apply via `pnpm exec prisma migrate deploy`** (project convention; CI runs `migrate deploy`). **If Prisma proposes a RESET/DROP you did not author, STOP.**
- **LINT is verification:** run `pnpm --filter @svyft/shared lint` + `pnpm --filter @svyft/api lint` before commits (no `@typescript-eslint/no-unused-vars`).
- **Commits:** conventional (`feat(ff-portal):`, `chore(prisma):`, `test(quote):`) + trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Fresh-worktree setup — run first

The worktree `feat/stage-4-sb4b` exists (off `main`@`b8b852b`, has SB4a). Before Task 1: `pnpm install`; **copy `apps/api/.env` from the main checkout** (gitignored → `DATABASE_URL`/`DIRECT_URL` for `:5433`); `pnpm exec prisma generate`; `pnpm --filter @svyft/shared build`. Verify baseline green: `pnpm --filter @svyft/shared test` + `pnpm --filter @svyft/api typecheck` + `pnpm --filter @svyft/api test -- ff` (no ff tests yet → passes trivially) + `pnpm run lint`.

---

## File Structure

**New:**
- `packages/shared/src/ff-portal.ts` (+ `ff-portal.test.ts`) — `FfPortalRfqDto`/`FfPortalLegDto` + `quoteDraftSchema` (Zod, shape-only).
- `apps/api/src/modules/ff-portal/ff-portal.module.ts` · `rfq-token.guard.ts` · `ff-scope.decorator.ts` · `ff-portal.controller.ts` · `ff-portal.service.ts`.
- `apps/api/test/ff-portal.e2e-spec.ts`.
**Modified:**
- `prisma/schema.prisma` (`Quote.draftJson Json?`) + one migration.
- `apps/api/src/modules/rfq/rfq-token.service.ts` (`resolveByToken`).
- `apps/api/src/app.module.ts` (register `FfPortalModule`).
- `packages/shared/src/index.ts` (export `./ff-portal`).
- `packages/shared/src/quote-engine.test.ts` (carried 4a Q3/Q4–Q7 coverage).

**Dependency order:** T1 → (T2, T3) → T4 → T5 → T6; T7 independent; T8 last.

---

## Task 1: Shared FF-portal DTOs + `quoteDraftSchema` (Zod shape-check)

**Goal:** the shared response DTO the portal returns and the Zod schema that shape-checks the `PATCH` body.

**Files:** Create `packages/shared/src/ff-portal.ts`, `packages/shared/src/ff-portal.test.ts`; Modify `packages/shared/src/index.ts`.

**Interfaces:**
- Consumes: `QuoteDraft`, `ChargeZone`/`CHARGE_ZONES`, `TruckingType`/`TRUCKING_TYPES`, `TruckingBasis`/`TRUCKING_BASES`, `WarehousePosition`/`WAREHOUSE_POSITIONS` (SB4a `./quote`); `ManifestSnapshot` (`./rfq`); `QuoteStatus` (`./status`); `FreightMode` (`./config`).
- Produces: types `FfPortalRfqDto`, `FfPortalLegDto`, `FfPortalEndpoint`, `FfPortalSeededCharge`, `FfPortalSeededDensity`; const `quoteDraftSchema` (`z.ZodType<QuoteDraft>`).

- [ ] **Step 1: Write the failing test** `packages/shared/src/ff-portal.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { quoteDraftSchema } from "./ff-portal";
import type { QuoteDraft } from "./quote";

const valid: QuoteDraft = {
  legId: "l1", mode: "AIR", currency: "USD", quoteValidityUntil: "2026-08-20T00:00:00.000Z",
  cargo: [{ cargoItemId: "c1", grossWtT: 1, cbm: 2, isDangerous: false, freightDensity: 167 }],
  charges: [{ zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC", amount: 100, note: "x" }],
  trucking: [], warehouse: [],
  transit: { departureDate: "2026-08-12T00:00:00.000Z", arrivalDate: "2026-08-14T00:00:00.000Z" },
  dgSurchargeNote: null, termsConditions: null,
};

describe("quoteDraftSchema", () => {
  it("accepts a well-formed QuoteDraft (nullable amounts allowed)", () => {
    expect(quoteDraftSchema.safeParse(valid).success).toBe(true);
    const partial = { ...valid, charges: [{ zone: "ORIGIN", presetKey: null, label: "x", amount: null }] };
    expect(quoteDraftSchema.safeParse(partial).success).toBe(true); // draft allows blank amount
  });
  it("rejects a malformed body (bad zone / wrong type)", () => {
    expect(quoteDraftSchema.safeParse({ ...valid, charges: [{ zone: "NOPE", label: "x", amount: 1, presetKey: null }] }).success).toBe(false);
    expect(quoteDraftSchema.safeParse({ ...valid, legId: 123 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run — RED.** `pnpm --filter @svyft/shared test -- ff-portal` → fail (module missing).

- [ ] **Step 3: Create `packages/shared/src/ff-portal.ts`:**
```ts
import { z } from "zod";
import type { FreightMode } from "./config";
import type { QuoteStatus } from "./status";
import type { ManifestSnapshot } from "./rfq";
import type { ChargeZone, WarehousePosition, QuoteDraft } from "./quote";
import { CHARGE_ZONES, TRUCKING_TYPES, TRUCKING_BASES, WAREHOUSE_POSITIONS } from "./quote";

// ── GET /ff/rfq/:token response ──
export interface FfPortalEndpoint {
  pointId: string;
  type: string;                 // PointType (PICKUP|DELIVERY|WAREHOUSE|AIRPORT|SEAPORT)
  name: string | null;
  country: string | null;
  warehousePosition: WarehousePosition | null; // set for WAREHOUSE endpoints, else null
}
export interface FfPortalSeededCharge { zone: ChargeZone; presetKey: string; label: string; isPreset: true; amount: null; }
export interface FfPortalSeededDensity { cargoItemId: string; freightDensity: number; }
export interface FfPortalLegDto {
  legId: string;
  quoteId: string;
  status: QuoteStatus;
  mode: FreightMode | null;
  manifest: ManifestSnapshot;
  endpoints: FfPortalEndpoint[];
  seededCharges: FfPortalSeededCharge[];
  seededDensity: FfPortalSeededDensity[];
  draft: QuoteDraft | null;
}
export interface FfPortalRfqDto {
  rfqNumber: string;
  incoterms: string | null;
  submissionDeadline: string;          // ISO
  currency: string | null;             // Rfq.currency ?? FF.defaultCurrency
  quoteValidityUntil: string | null;
  freightForwarder: { companyName: string };
  legs: FfPortalLegDto[];
}

// ── PATCH body shape-check (NOT the Q1–Q8 business rules; those are submit-only) ──
export const quoteDraftSchema: z.ZodType<QuoteDraft> = z.object({
  legId: z.string(),
  mode: z.string().nullable(),         // authoritative mode is re-derived from the manifest at submit
  currency: z.string().nullable(),
  quoteValidityUntil: z.string().nullable(),
  cargo: z.array(z.object({
    cargoItemId: z.string(), grossWtT: z.number(), cbm: z.number(),
    isDangerous: z.boolean(), freightDensity: z.number().nullable(),
  })),
  charges: z.array(z.object({
    zone: z.enum(CHARGE_ZONES), presetKey: z.string().nullable(), label: z.string(),
    amount: z.number().nullable(), note: z.string().optional(),
  })),
  trucking: z.array(z.object({
    legEndpointPointId: z.string(), truckingType: z.enum(TRUCKING_TYPES), basis: z.enum(TRUCKING_BASES),
    amount: z.number().nullable(), remarks: z.string().optional(),
  })),
  warehouse: z.array(z.object({
    warehousePointId: z.string(), position: z.enum(WAREHOUSE_POSITIONS), label: z.string(),
    amount: z.number().nullable(), cargoAcceptanceWindow: z.string().optional(),
  })),
  transit: z.object({
    departureDate: z.string().nullable(), arrivalDate: z.string().nullable(),
    carrier: z.string().nullable().optional(), flightVoyageNo: z.string().nullable().optional(),
    carrierSurcharge: z.number().nullable().optional(), guaranteedTransitDays: z.number().nullable().optional(),
  }).nullable(),
  dgSurchargeNote: z.string().nullable(),
  termsConditions: z.string().nullable(),
}) as z.ZodType<QuoteDraft>;
```
> `mode` is `z.string().nullable()` (shape-lenient) because the authoritative mode is re-derived from the frozen manifest at submit — the client value is never trusted. The four enum tuples (`CHARGE_ZONES` etc.) are SB4a exports.

- [ ] **Step 4: Export** — add `export * from "./ff-portal";` to `packages/shared/src/index.ts`.

- [ ] **Step 5: GREEN + build + lint.**
```bash
pnpm --filter @svyft/shared test -- ff-portal && pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared lint
```

- [ ] **Step 6: Commit.**
```bash
git add packages/shared/src/ff-portal.ts packages/shared/src/ff-portal.test.ts packages/shared/src/index.ts
git commit -m "feat(ff-portal): shared portal DTOs + quoteDraftSchema"
```

---

## Task 2: `Quote.draftJson` migration

**Goal:** the nullable draft-blob column that holds an in-progress `QuoteDraft` until submit.

**Files:** Modify `prisma/schema.prisma`; Create `prisma/migrations/<ts>_add_quote_draft_json/migration.sql`.

**Interfaces:** Produces `Quote.draftJson Json?`.

- [ ] **Step 1: Add the column** to `model Quote` in `prisma/schema.prisma` — after `termsConditions String?` (the last SB4a pricing col), before the back-relations block:
```prisma
  draftJson              Json?
```

- [ ] **Step 2: Hand-author the migration.** Create `prisma/migrations/<ts>_add_quote_draft_json/migration.sql` (`<ts>` via `date -u +%Y%m%d%H%M%S`, must sort after `20260728181025`):
```sql
-- AlterTable
ALTER TABLE "Quote" ADD COLUMN "draftJson" JSONB;
```

- [ ] **Step 3: Apply + generate.** (`migrate dev` needs a TTY → use `migrate deploy`.)
```bash
pnpm exec prisma migrate deploy && pnpm exec prisma generate
```
Expected: `1 migration applied`; client regenerated. **If it proposes a reset, STOP.**

- [ ] **Step 4: Verify.**
```bash
pnpm exec prisma migrate status   # "Database schema is up to date!"
pnpm --filter @svyft/api typecheck
```

- [ ] **Step 5: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "chore(prisma): Quote.draftJson draft-blob column (SB4b)"
```

---

## Task 3: `RfqTokenService.resolveByToken` + `RfqTokenGuard` + `@FfScope`

**Goal:** resolve a raw token to its scoped RFQ and gate the `/ff/*` boundary.

**Files:** Modify `apps/api/src/modules/rfq/rfq-token.service.ts`; Create `apps/api/src/modules/ff-portal/rfq-token.guard.ts`, `apps/api/src/modules/ff-portal/ff-scope.decorator.ts`; Test `apps/api/src/modules/ff-portal/rfq-token.guard.spec.ts`.

**Interfaces:**
- Consumes: `RfqTokenService.hash` (existing); `PrismaService`.
- Produces: `RfqTokenService.resolveByToken(rawToken: string): Promise<FfScope | null>`; type `FfScope = { rfq: RfqRow; quotes: ScopedQuote[] }` where `ScopedQuote = { id, legId, status, rfqId, manifestSnapshot, leg }`; `RfqTokenGuard implements CanActivate`; `@FfScope()` param decorator returning `request.ffScope`.

- [ ] **Step 1: Write the failing test** `apps/api/src/modules/ff-portal/rfq-token.guard.spec.ts` (unit — mock the service + a fake `ExecutionContext`):
```ts
import { UnauthorizedException } from "@nestjs/common";
import { RfqTokenGuard } from "./rfq-token.guard";

function ctx(token: string, req: Record<string, unknown> = {}) {
  const request = { params: { token }, ...req };
  return { switchToHttp: () => ({ getRequest: () => request }), request } as any;
}

describe("RfqTokenGuard", () => {
  it("attaches ffScope and allows when the token resolves", async () => {
    const scope = { rfq: { id: "r1", queryId: "q1" }, quotes: [] };
    const guard = new RfqTokenGuard({ resolveByToken: async () => scope } as any);
    const c = ctx("raw-token");
    await expect(guard.canActivate(c)).resolves.toBe(true);
    expect(c.request.ffScope).toBe(scope);
  });
  it("throws 401 when the token does not resolve", async () => {
    const guard = new RfqTokenGuard({ resolveByToken: async () => null } as any);
    await expect(guard.canActivate(ctx("bad"))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Run — RED.** `pnpm --filter @svyft/api test -- rfq-token.guard` → fail (module missing).

- [ ] **Step 3: Add `resolveByToken` to `RfqTokenService`** (`apps/api/src/modules/rfq/rfq-token.service.ts`) — it already has `hash`/`mint` + a `PrismaService`; if it does not yet inject Prisma, add it to the constructor:
```ts
// types (top of file or a nearby types module)
export interface FfScope {
  rfq: { id: string; queryId: string; rfqNumber: string; incoterms: string | null;
         submissionDeadline: Date; currency: string | null; quoteValidityUntil: Date | null;
         freightForwarderId: string };
  quotes: {
    id: string; legId: string; status: string; rfqId: string | null;
    manifestSnapshot: unknown;
    leg: { id: string; mode: string | null;
           originPoint: PointLite | null; destinationPoint: PointLite | null };
  }[];
}
type PointLite = { id: string; type: string; name: string | null; country: string | null };

async resolveByToken(rawToken: string): Promise<FfScope | null> {
  const accessTokenHash = this.hash(rawToken);
  const rfq = await this.prisma.rfq.findUnique({
    where: { accessTokenHash },
    include: {
      quotes: {
        where: { NOT: { status: "SELECT" } }, // only distributed quotes are in scope
        include: {
          leg: {
            select: {
              id: true, mode: true,
              originPoint: { select: { id: true, type: true, name: true, country: true } },
              destinationPoint: { select: { id: true, type: true, name: true, country: true } },
            },
          },
        },
      },
    },
  });
  if (!rfq) return null;
  return {
    rfq: {
      id: rfq.id, queryId: rfq.queryId, rfqNumber: rfq.rfqNumber, incoterms: rfq.incoterms,
      submissionDeadline: rfq.submissionDeadline, currency: rfq.currency,
      quoteValidityUntil: rfq.quoteValidityUntil, freightForwarderId: rfq.freightForwarderId,
    },
    quotes: rfq.quotes.map((q) => ({
      id: q.id, legId: q.legId, status: q.status, rfqId: q.rfqId,
      manifestSnapshot: q.manifestSnapshot,
      leg: { id: q.leg.id, mode: q.leg.mode, originPoint: q.leg.originPoint, destinationPoint: q.leg.destinationPoint },
    })),
  };
}
```
> Confirm the `Leg` relation names for its endpoints in `schema.prisma` (`originPoint`/`destinationPoint` via the `LegOrigin`/`LegDestination` relations) and adjust the `include` if the field names differ.

- [ ] **Step 4: Create the `@FfScope()` decorator** `apps/api/src/modules/ff-portal/ff-scope.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { FfScope } from "../rfq/rfq-token.service";

export const FfScope = createParamDecorator((_data: unknown, ctx: ExecutionContext): FfScope => {
  return ctx.switchToHttp().getRequest().ffScope;
});
```

- [ ] **Step 5: Create the guard** `apps/api/src/modules/ff-portal/rfq-token.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { RfqTokenService } from "../rfq/rfq-token.service";

@Injectable()
export class RfqTokenGuard implements CanActivate {
  constructor(private readonly token: RfqTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const raw = request.params?.token as string | undefined;
    const scope = raw ? await this.token.resolveByToken(raw) : null;
    if (!scope) throw new UnauthorizedException("This RFQ link is invalid or has expired");
    request.ffScope = scope;
    return true;
  }
}
```

- [ ] **Step 6: GREEN + lint.**
```bash
pnpm --filter @svyft/api test -- rfq-token.guard && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint
```
> If the guard spec cannot construct `RfqTokenService` without Nest DI, the shown spec already stubs it (`{ resolveByToken } as any`) — no real DI needed.

- [ ] **Step 7: Commit.**
```bash
git add apps/api/src/modules/rfq/rfq-token.service.ts apps/api/src/modules/ff-portal/rfq-token.guard.ts apps/api/src/modules/ff-portal/ff-scope.decorator.ts apps/api/src/modules/ff-portal/rfq-token.guard.spec.ts
git commit -m "feat(ff-portal): RfqTokenService.resolveByToken + RfqTokenGuard + @FfScope"
```

---

## Task 4: `FfPortalModule` + `GET /ff/rfq/:token` (resolve scope)

**Goal:** the portal module + controller + the resolve-scope read (RFQ header + per-leg sections from the frozen manifest + seeded presets/density + warehouse positions + saved draft).

**Files:** Create `apps/api/src/modules/ff-portal/ff-portal.module.ts`, `ff-portal.controller.ts`, `ff-portal.service.ts`; Modify `apps/api/src/app.module.ts`; Test `apps/api/test/ff-portal.e2e-spec.ts`.

**Interfaces:**
- Consumes: `FfScope` (T3); `RfqTokenGuard` (T3); `@FfScope` (T3); `FfPortalRfqDto`/`FfPortalLegDto` (T1); `AIR_CHARGE_PRESETS`/`SEA_CHARGE_PRESETS`/`classifyWarehousePositions` (`@svyft/shared`); `ConfigDataService.densityFactors()`; `FreightForwardersService` or `prisma.freightForwarder` (for `companyName`+`defaultCurrency`).
- Produces: `FfPortalService.resolveScope(scope: FfScope): Promise<FfPortalRfqDto>`; `GET /api/ff/rfq/:token`.

- [ ] **Step 1: Write the failing e2e** `apps/api/test/ff-portal.e2e-spec.ts`. Mirror the bootstrap + cleanup of `rfq-state.e2e-spec.ts` (AppModule, cookieParser, `PrismaExceptionFilter`, `setGlobalPrefix("api")`, `await app.close()`), then a helper that **distributes** to mint a real token (create Query→Points→CargoItem→Leg(AIR, READY_FOR_RFQ)→FF, `PUT ff-selection`, `POST distribute` → grab `res.body.rfqs[0].accessToken`). First test:
```ts
it("GET resolves the scoped RFQ with seeded presets + density (no auth cookie)", async () => {
  const { token, legId } = await distributeFixture(); // returns the raw token + the leg id
  const res = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200); // NO cookie
  expect(res.body.rfqNumber).toMatch(/-RFQ/);
  expect(res.body.currency).toBe("USD");                       // Rfq.currency ?? FF.defaultCurrency
  expect(res.body.legs).toHaveLength(1);
  const leg = res.body.legs[0];
  expect(leg.legId).toBe(legId);
  expect(leg.manifest.cargo.length).toBeGreaterThan(0);        // from the frozen snapshot
  expect(leg.seededCharges.map((c: any) => c.presetKey)).toContain("AIR_MAIN_FREIGHT"); // Air presets
  expect(leg.seededDensity[0].freightDensity).toBe(167);       // Air density
  expect(leg.draft).toBeNull();
});
it("rejects a bad token with 401", async () => {
  await request(app.getHttpServer()).get("/api/ff/rfq/deadbeef").expect(401);
});
```

- [ ] **Step 2: Run — RED.** `pnpm --filter @svyft/api test -- ff-portal` → fail (route missing / 404).

- [ ] **Step 3: Create `FfPortalService`** `apps/api/src/modules/ff-portal/ff-portal.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { AIR_CHARGE_PRESETS, SEA_CHARGE_PRESETS, classifyWarehousePositions } from "@svyft/shared";
import type { FfPortalRfqDto, FfPortalLegDto, ManifestSnapshot, QuoteDraft } from "@svyft/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { ConfigDataService } from "../config/config-data.service";
import type { FfScope } from "../rfq/rfq-token.service";

@Injectable()
export class FfPortalService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigDataService) {}

  async resolveScope(scope: FfScope): Promise<FfPortalRfqDto> {
    const ff = await this.prisma.freightForwarder.findUnique({
      where: { id: scope.rfq.freightForwarderId },
      select: { companyName: true, defaultCurrency: true },
    });
    const densities = await this.config.densityFactors(); // [{ mode, kgPerCbm }]
    const densityOf = (mode: string | null) => densities.find((d) => d.mode === mode)?.kgPerCbm ?? null;

    // Warehouse positions across the FF's WHOLE leg set (§6.4)
    const whLegs = scope.quotes.map((q) => ({
      originPointId: q.leg.originPoint?.id ?? null,
      destinationPointId: q.leg.destinationPoint?.id ?? null,
      mode: (q.leg.mode ?? null) as any,
    }));
    const whPointIds = scope.quotes.flatMap((q) =>
      [q.leg.originPoint, q.leg.destinationPoint].filter((p): p is NonNullable<typeof p> => !!p && p.type === "WAREHOUSE").map((p) => p.id));
    const whPos = classifyWarehousePositions(whLegs, whPointIds);

    const legs: FfPortalLegDto[] = scope.quotes.map((q) => {
      const manifest = q.manifestSnapshot as ManifestSnapshot;
      const mode = q.leg.mode;
      const presets = mode === "AIR" ? AIR_CHARGE_PRESETS : mode === "SEA" ? SEA_CHARGE_PRESETS : [];
      const density = densityOf(mode);
      const endpoints = [q.leg.originPoint, q.leg.destinationPoint]
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => ({ pointId: p.id, type: p.type, name: p.name, country: p.country,
                       warehousePosition: p.type === "WAREHOUSE" ? (whPos[p.id] ?? null) : null }));
      return {
        legId: q.legId, quoteId: q.id, status: q.status as any, mode: mode as any, manifest, endpoints,
        seededCharges: presets.map((p) => ({ zone: p.zone, presetKey: p.presetKey, label: p.label, isPreset: true as const, amount: null })),
        seededDensity: density == null ? [] : manifest.cargo.map((c) => ({ cargoItemId: c.cargoItemId, freightDensity: density })),
        draft: (q as any).draftJson ? ((q as any).draftJson as QuoteDraft) : null,
      };
    });

    return {
      rfqNumber: scope.rfq.rfqNumber, incoterms: scope.rfq.incoterms,
      submissionDeadline: scope.rfq.submissionDeadline.toISOString(),
      currency: scope.rfq.currency ?? ff?.defaultCurrency ?? null,
      quoteValidityUntil: scope.rfq.quoteValidityUntil?.toISOString() ?? null,
      freightForwarder: { companyName: ff?.companyName ?? "" },
      legs,
    };
  }
}
```
> **Note:** the scoped quotes need `draftJson` in scope. Extend `resolveByToken`'s quote `select`/map (T3) to include `draftJson: true` and carry it on `ScopedQuote`, OR (simpler) read drafts here: the map above reads `q.draftJson` — add `draftJson` to the T3 `include`/mapping. Pick one and keep the `FfScope` type in sync.

- [ ] **Step 4: Create the controller** `apps/api/src/modules/ff-portal/ff-portal.controller.ts`:
```ts
import { Controller, Get, UseGuards } from "@nestjs/common";
import type { FfPortalRfqDto } from "@svyft/shared";
import { Public } from "../auth/decorators/public.decorator";
import { RfqTokenGuard } from "./rfq-token.guard";
import { FfScope } from "./ff-scope.decorator";
import type { FfScope as FfScopeType } from "../rfq/rfq-token.service";
import { FfPortalService } from "./ff-portal.service";

@Public()
@UseGuards(RfqTokenGuard)
@Controller("ff/rfq/:token")
export class FfPortalController {
  constructor(private readonly portal: FfPortalService) {}

  @Get()
  resolve(@FfScope() scope: FfScopeType): Promise<FfPortalRfqDto> {
    return this.portal.resolveScope(scope);
  }
}
```

- [ ] **Step 5: Create the module** `apps/api/src/modules/ff-portal/ff-portal.module.ts` + register in `AppModule`:
```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ConfigDataModule } from "../config/config-data.module"; // confirm the exact module that provides ConfigDataService
import { RfqModule } from "../rfq/rfq.module";                    // provides RfqTokenService (export it if not already)
import { StatusModule } from "../status/status.module";           // for T6 submit
import { FfPortalController } from "./ff-portal.controller";
import { FfPortalService } from "./ff-portal.service";
import { RfqTokenGuard } from "./rfq-token.guard";

@Module({
  imports: [PrismaModule, ConfigDataModule, RfqModule, StatusModule],
  controllers: [FfPortalController],
  providers: [FfPortalService, RfqTokenGuard],
})
export class FfPortalModule {}
```
Add `FfPortalModule` to `AppModule`'s `imports`. **Ensure `RfqModule` exports `RfqTokenService`** (add it to the module's `exports` if missing).

- [ ] **Step 6: GREEN + verify.**
```bash
pnpm --filter @svyft/shared build   # ff-portal DTOs consumed by api
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint && pnpm --filter @svyft/api test -- ff-portal
```
Expected: the two GET tests pass; jest exits clean.

- [ ] **Step 7: Commit.**
```bash
git add apps/api/src/modules/ff-portal apps/api/src/app.module.ts apps/api/src/modules/rfq/rfq.module.ts apps/api/test/ff-portal.e2e-spec.ts
git commit -m "feat(ff-portal): FfPortalModule + GET resolve-scope (seeded presets/density, warehouse positions)"
```

---

## Task 5: `PATCH /ff/rfq/:token/quotes/:legId` (draft-save)

**Goal:** last-write-wins draft persistence into `Quote.draftJson` (+ RFQ-level currency/validity onto `Rfq`); no business validation; scope-checked.

**Files:** Modify `apps/api/src/modules/ff-portal/ff-portal.service.ts`, `ff-portal.controller.ts`, `apps/api/test/ff-portal.e2e-spec.ts`.

**Interfaces:**
- Consumes: `quoteDraftSchema` (T1); `ZodValidationPipe` (`apps/api/src/common/zod-validation.pipe.ts`); `FfScope` (T3).
- Produces: `FfPortalService.saveDraft(scope, legId, draft): Promise<{ savedAt: string }>`; `PATCH /api/ff/rfq/:token/quotes/:legId`.

- [ ] **Step 1: Write the failing e2e** (append):
```ts
it("PATCH saves a draft and GET resumes it; a foreign leg is 403", async () => {
  const { token, legId } = await distributeFixture();
  const draft = { legId, mode: "AIR", currency: "EUR", quoteValidityUntil: "2026-09-01T00:00:00.000Z",
    cargo: [], charges: [{ zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC", amount: 42 }],
    trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null };
  await request(app.getHttpServer()).patch(`/api/ff/rfq/${token}/quotes/${legId}`).send(draft).expect(200);
  const res = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
  expect(res.body.legs[0].draft.charges[0].amount).toBe(42);
  expect(res.body.currency).toBe("EUR");                         // upserted to Rfq
  await request(app.getHttpServer()).patch(`/api/ff/rfq/${token}/quotes/00000000-0000-0000-0000-000000000000`).send(draft).expect(403);
});
```

- [ ] **Step 2: Run — RED.**

- [ ] **Step 3: Add `saveDraft` to `FfPortalService`:**
```ts
import { ForbiddenException } from "@nestjs/common";
import type { QuoteDraft } from "@svyft/shared";

private quoteForLeg(scope: FfScope, legId: string) {
  const q = scope.quotes.find((x) => x.legId === legId);
  if (!q) throw new ForbiddenException("This leg is not part of your RFQ");
  return q;
}

async saveDraft(scope: FfScope, legId: string, draft: QuoteDraft): Promise<{ savedAt: string }> {
  const q = this.quoteForLeg(scope, legId);
  const now = new Date();
  await this.prisma.$transaction([
    this.prisma.quote.update({ where: { id: q.id }, data: { draftJson: draft as unknown as object } }),
    this.prisma.rfq.update({ where: { id: scope.rfq.id },
      data: { currency: draft.currency ?? undefined,
              quoteValidityUntil: draft.quoteValidityUntil ? new Date(draft.quoteValidityUntil) : undefined } }),
  ]);
  return { savedAt: now.toISOString() };
}
```
> `?? undefined` (not `null`) so a missing field does not wipe an existing `Rfq` value; RFQ-level currency/validity are shared across the FF's legs (last-write-wins).

- [ ] **Step 4: Add the route** to the controller:
```ts
import { Body, Param, Patch } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { quoteDraftSchema } from "@svyft/shared";
import type { QuoteDraft } from "@svyft/shared";

@Patch("quotes/:legId")
saveDraft(
  @FfScope() scope: FfScopeType,
  @Param("legId") legId: string,
  @Body(new ZodValidationPipe(quoteDraftSchema)) draft: QuoteDraft,
) {
  return this.portal.saveDraft(scope, legId, draft);
}
```

- [ ] **Step 5: GREEN + verify + commit.**
```bash
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint && pnpm --filter @svyft/api test -- ff-portal
git add apps/api/src/modules/ff-portal apps/api/test/ff-portal.e2e-spec.ts
git commit -m "feat(ff-portal): PATCH draft-save (Quote.draftJson + RFQ-level currency/validity)"
```

---

## Task 6: `POST /ff/rfq/:token/quotes/:legId/submit`

**Goal:** validate (§10.4) → materialize pricing → fire `SUBMIT`. Server re-derives immutables; findings → `422`; not-`RFQ_SENT` → `409`; P2003 → domain finding.

**Files:** Modify `apps/api/src/modules/ff-portal/ff-portal.service.ts`, `ff-portal.controller.ts`, `apps/api/test/ff-portal.e2e-spec.ts`.

**Interfaces:**
- Consumes: `validateQuote`/`computeQuoteTotals`/`computeChargeableWeight`/`classifyWarehousePositions` (`@svyft/shared`); `StatusService.fire`; `QuoteEvent.SUBMIT` (`@svyft/shared`); `ManifestSnapshot` (`./rfq`).
- Produces: `FfPortalService.submit(scope, legId): Promise<{ quoteId: string; status: "QUOTED" }>`; `POST /api/ff/rfq/:token/quotes/:legId/submit`.

- [ ] **Step 1: Write the failing e2e** (append) — happy, invalid-422, expired-Q7, double-409:
```ts
async function fullValidDraft(legId: string, endpoints: any[]) { /* build a complete Air draft:
  all AIR_CHARGE_PRESETS priced (amount 10), density from GET, transit dep/arr set, currency USD,
  quoteValidityUntil after the deadline, dgSurchargeNote null (no DG cargo). */ }

it("submit: valid Air quote → 201 QUOTED, leg rolls up, child tables populated", async () => {
  const { token, legId } = await distributeFixture();
  const got = await request(app.getHttpServer()).get(`/api/ff/rfq/${token}`).expect(200);
  await request(app.getHttpServer()).patch(`/api/ff/rfq/${token}/quotes/${legId}`)
    .send(fullValidDraft(legId, got.body.legs[0].endpoints)).expect(200);
  const res = await request(app.getHttpServer()).post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(201);
  expect(res.body.status).toBe("QUOTED");
  const q = await prisma.quote.findFirst({ where: { legId }, include: { chargeLines: true, quoteCargoLines: true } });
  expect(q?.status).toBe("QUOTED"); expect(q?.submittedAt).not.toBeNull();
  expect(q?.chargeLines.length).toBeGreaterThan(0); expect(Number(q?.grandTotal)).toBeGreaterThan(0);
  const leg = await prisma.leg.findUnique({ where: { id: legId } });
  expect(leg?.status).toBe("FULLY_QUOTED");   // only FF on the leg
});
it("submit: missing density/currency → 422 findings, Quote stays RFQ_SENT", async () => {
  const { token, legId } = await distributeFixture();
  await request(app.getHttpServer()).patch(`/api/ff/rfq/${token}/quotes/${legId}`)
    .send({ legId, mode: "AIR", currency: null, quoteValidityUntil: null, cargo: [], charges: [],
            trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null }).expect(200);
  const res = await request(app.getHttpServer()).post(`/api/ff/rfq/${token}/quotes/${legId}/submit`).expect(422);
  expect(res.body.findings.map((f: any) => f.rule)).toEqual(expect.arrayContaining(["Q1", "Q4"]));
  const q = await prisma.quote.findFirst({ where: { legId } });
  expect(q?.status).toBe("RFQ_SENT");
});
it("submit: past the deadline → 422 with Q7", async () => { /* distribute with a past submissionDeadline
  (PATCH a full valid draft, then submit) → expect 422 containing rule "Q7". */ });
it("submit: an already-QUOTED quote → 409", async () => { /* submit twice → second is 409. */ });
```

- [ ] **Step 2: Run — RED.**

- [ ] **Step 3: Implement `submit`** in `FfPortalService`:
```ts
import { ConflictException } from "@nestjs/common";
import { validateQuote, computeQuoteTotals, computeChargeableWeight, classifyWarehousePositions,
         QuoteEvent } from "@svyft/shared";
import type { Finding, QuoteDraft, ManifestSnapshot } from "@svyft/shared";
import { StatusService } from "../status/status.service";
import { Prisma } from "@prisma/client";

// add StatusService to the constructor: private readonly status: StatusService

async submit(scope: FfScope, legId: string): Promise<{ quoteId: string; status: "QUOTED" }> {
  const q = this.quoteForLeg(scope, legId);
  if (q.status !== "RFQ_SENT") throw new ConflictException("This quote has already been submitted or is not open");

  const manifest = q.manifestSnapshot as ManifestSnapshot;
  const stored = ((await this.prisma.quote.findUnique({ where: { id: q.id }, select: { draftJson: true } }))?.draftJson ?? {}) as Partial<QuoteDraft>;

  // ── re-derive the AUTHORITATIVE draft: immutables from the manifest/classifier, editable from the stored draft ──
  const whLegs = scope.quotes.map((x) => ({ originPointId: x.leg.originPoint?.id ?? null,
    destinationPointId: x.leg.destinationPoint?.id ?? null, mode: (x.leg.mode ?? null) as any }));
  const whPointIds = scope.quotes.flatMap((x) => [x.leg.originPoint, x.leg.destinationPoint]
    .filter((p): p is NonNullable<typeof p> => !!p && p.type === "WAREHOUSE").map((p) => p.id));
  const whPos = classifyWarehousePositions(whLegs, whPointIds);

  const draft: QuoteDraft = {
    legId, mode: q.leg.mode as any,
    currency: scope.rfq.currency, quoteValidityUntil: scope.rfq.quoteValidityUntil?.toISOString() ?? null,
    cargo: manifest.cargo.map((c) => ({
      cargoItemId: c.cargoItemId, grossWtT: Number(c.grossWt) / 1000, cbm: Number(c.volumeCbm ?? 0),
      isDangerous: c.isDangerous,
      freightDensity: stored.cargo?.find((s) => s.cargoItemId === c.cargoItemId)?.freightDensity ?? null,
    })),
    charges: (stored.charges ?? []).map((c) => ({ ...c })),
    trucking: (stored.trucking ?? []).map((t) => ({ ...t })),
    warehouse: (stored.warehouse ?? []).map((w) => ({ ...w, position: whPos[w.warehousePointId] ?? w.position })),
    transit: stored.transit ?? null,
    dgSurchargeNote: stored.dgSurchargeNote ?? null, termsConditions: stored.termsConditions ?? null,
  };

  // ── validate (§10.4 Q1–Q8) ──
  const findings: Finding[] = validateQuote(draft, scope.rfq.submissionDeadline.toISOString(), new Date().toISOString());
  if (findings.length) throw new UnprocessableEntityException({ findings });

  // ── materialize (one tx) ──
  const totals = computeQuoteTotals(draft);
  try {
    await this.prisma.$transaction(async (tx) => {
      await tx.quoteCargoLine.deleteMany({ where: { quoteId: q.id } });
      await tx.chargeLine.deleteMany({ where: { quoteId: q.id } });
      await tx.truckingCharge.deleteMany({ where: { quoteId: q.id } });
      await tx.warehouseStagingLine.deleteMany({ where: { quoteId: q.id } });
      await tx.transitPlan.deleteMany({ where: { quoteId: q.id } });

      await tx.quoteCargoLine.createMany({ data: draft.cargo.map((c) => ({ quoteId: q.id, cargoItemId: c.cargoItemId,
        freightDensity: c.freightDensity!, chargeableWeightT: computeChargeableWeight(c.grossWtT, c.cbm, c.freightDensity!) })) });
      await tx.chargeLine.createMany({ data: draft.charges.map((c, i) => ({ quoteId: q.id, zone: c.zone,
        label: c.label, isPreset: c.presetKey != null, presetKey: c.presetKey, amount: c.amount!, note: c.note, sortOrder: i })) });
      for (const t of draft.trucking) await tx.truckingCharge.create({ data: { quoteId: q.id,
        legEndpointPointId: t.legEndpointPointId, truckingType: t.truckingType, basis: t.basis, amount: t.amount!, remarks: t.remarks } });
      for (const w of draft.warehouse) await tx.warehouseStagingLine.create({ data: { quoteId: q.id,
        warehousePointId: w.warehousePointId, position: w.position, label: w.label, isPreset: false, amount: w.amount!, cargoAcceptanceWindow: w.cargoAcceptanceWindow } });
      if (draft.transit) await tx.transitPlan.create({ data: { quoteId: q.id, carrier: draft.transit.carrier ?? null,
        flightVoyageNo: draft.transit.flightVoyageNo ?? null, departureDate: new Date(draft.transit.departureDate!),
        arrivalDate: new Date(draft.transit.arrivalDate!), carrierSurcharge: draft.transit.carrierSurcharge ?? null,
        guaranteedTransitDays: draft.transit.guaranteedTransitDays ?? null } });

      await tx.quote.update({ where: { id: q.id }, data: {
        totalChargeableWeightT: totals.totalChargeableWeightT, grandTotal: totals.grandTotal,
        dgSurchargeNote: draft.dgSurchargeNote, termsConditions: draft.termsConditions,
        submittedAt: new Date(), draftJson: Prisma.DbNull } });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
      throw new UnprocessableEntityException({ findings: [{ rule: "FK", severity: "blocking",
        scope: { type: "leg", id: legId }, message: "A priced pickup/warehouse point no longer exists — refresh and re-price." }] });
    throw e;
  }

  // ── fire AFTER the tx (the one door) → RFQ_SENT→QUOTED → leg/query rollups free ──
  await this.status.fire("quote", q.id, QuoteEvent.SUBMIT, { queryId: scope.rfq.queryId });
  return { quoteId: q.id, status: "QUOTED" };
}
```
> Add `UnprocessableEntityException` to the `@nestjs/common` import. `Prisma.DbNull` clears the `Json?` column. The `!` non-null assertions are safe: `validateQuote` already guaranteed every required amount/density/date is present (Q1/Q2/Q6/Q8) before this point.

- [ ] **Step 4: Add the route:**
```ts
import { HttpCode, Post } from "@nestjs/common";

@Post("quotes/:legId/submit")
@HttpCode(201)
submit(@FfScope() scope: FfScopeType, @Param("legId") legId: string) {
  return this.portal.submit(scope, legId);
}
```

- [ ] **Step 5: GREEN + verify.**
```bash
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint && pnpm --filter @svyft/api test -- ff-portal
```
Expected: all submit tests pass; jest exits clean.

- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/modules/ff-portal apps/api/test/ff-portal.e2e-spec.ts
git commit -m "feat(ff-portal): POST submit — validate → materialize pricing → fire SUBMIT (P2003-guarded)"
```

---

## Task 7: Carried 4a engine tests — Q3-absent + isolate Q4–Q7

**Goal:** close the two SB4a review coverage gaps (the code already behaves correctly; these are characterization tests).

**Files:** Modify `packages/shared/src/quote-engine.test.ts`.

- [ ] **Step 1: Append the tests** to the `validateQuote` describe block (reuse the file's existing `validAir()`/`deadline`/`now` helpers):
```ts
it("Q3: flags a missing (absent) validity", () => {
  const d = validAir(); d.quoteValidityUntil = null;
  const f = validateQuote(d, deadline, now).find((x) => x.rule === "Q3");
  expect(f?.scope).toEqual({ type: "field", id: "quoteValidityUntil" });
});
it("Q4: currency absent fires alone", () => {
  const d = validAir(); d.currency = null;
  expect(validateQuote(d, deadline, now).map((f) => f.rule)).toEqual(["Q4"]);
});
it("Q5: DG cargo without a note fires alone", () => {
  const d = validAir(); d.cargo[0].isDangerous = true;
  expect(validateQuote(d, deadline, now).map((f) => f.rule)).toEqual(["Q5"]);
});
it("Q6: a missing arrival date fires alone", () => {
  const d = validAir(); d.transit = { departureDate: "2026-08-12T00:00:00.000Z", arrivalDate: null };
  expect(validateQuote(d, deadline, now).map((f) => f.rule)).toEqual(["Q6"]);
});
it("Q7: past the deadline fires alone", () => {
  expect(validateQuote(validAir(), deadline, "2026-08-11T00:00:00.000Z").map((f) => f.rule)).toEqual(["Q7"]);
});
```
> If any assertion surprises you (an extra rule fires), that is a real finding — do NOT weaken the assertion to `arrayContaining`; report it. The `validAir()` fixture is fully valid, so isolating one broken field should yield exactly one rule.

- [ ] **Step 2: GREEN + build + commit.**
```bash
pnpm --filter @svyft/shared test -- quote-engine && pnpm --filter @svyft/shared build
git add packages/shared/src/quote-engine.test.ts
git commit -m "test(quote): isolate Q4–Q7 + add Q3-absent (SB4a carry-over)"
```

---

## Task 8: Final verification + barrel exports

**Goal:** confirm the whole 4b surface exports + every package green together; api jest exits clean.

- [ ] **Step 1: Confirm exports.** `packages/shared/src/index.ts` has `export * from "./ff-portal";`. After a shared build, grep the dist resolves the new public symbols:
```bash
pnpm --filter @svyft/shared build
node -e "const s=require('./packages/shared/dist/index.js'); ['quoteDraftSchema'].forEach(k=>{ if(!(k in s)) throw new Error('missing '+k) }); console.log('ok')"
```

- [ ] **Step 2: Full matrix.**
```bash
pnpm --filter @svyft/shared test && pnpm --filter @svyft/shared lint
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint && pnpm --filter @svyft/api test -- ff-portal rfq quote-pricing-schema
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web test
```
Expected: all green; api jest exits on its own (no hang). Web is untouched by 4b — it should stay green.

- [ ] **Step 3: Commit any barrel fix** (`chore(ff-portal): barrel exports + final 4b verification`), then this is ready for the **opus whole-branch review** + PR `feat/stage-4-sb4b` → `main` (watch CI `gh pr checks <n> --watch`).

---

## Self-Review

**Spec coverage:** token guard + `/ff/*` boundary (§8.1) → T3/T4; `GET` resolve-scope (§5.2, from the frozen manifest, seeded presets/density, warehouse positions §6.4) → T4; `PATCH` draft-save (§5.2, last-write-wins, no validation, §8.5) → T5; `POST` submit (§5.2, §10.4 Q1–Q8, materialize + fire `SUBMIT` → leg/query rollup §7.1) → T6; the draft blob (design §5) → T2; DTOs + shape-check → T1; the carried 4a coverage → T7. **Deferred (documented in the design):** PDF, scoped route diagram, FF Preview, rate-limiting, live email/TLS, the expiry sweep — none in this plan.

**Placeholder scan:** every code step ships real code. Three steps carry a `/* … */` sketch for a **test-data builder** (`fullValidDraft`) and two variant e2e bodies (past-deadline, double-submit) whose full form is mechanical given the sibling tests shown in full — the implementer completes them from the explicit adjacent examples (distribute → PATCH → submit, asserting the stated status code + rule). No implementation step is a placeholder.

**Type consistency:** `FfScope`/`ScopedQuote` (T3) are consumed unchanged in T4/T5/T6; `resolveScope`/`saveDraft`/`submit` signatures match their controller call sites; `QuoteDraft`/`ManifestSnapshot`/`Finding`/`QuoteEvent.SUBMIT` are the SB4a/SB2a `@svyft/shared` exports; `quoteDraftSchema` (T1) is the `PATCH` pipe in T5; the `Quote`/child-table/`Rfq` field names match `schema.prisma` (`draftJson` from T2; `submittedAt`/`grandTotal`/`totalChargeableWeightT` from SB4a; `Rfq.currency`/`quoteValidityUntil`). The one open confirm-in-code item is flagged inline: the `Leg` endpoint relation names (`originPoint`/`destinationPoint`) — verify against `schema.prisma` in T3 and keep the `include` in sync.
