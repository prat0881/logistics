# Stage 5 · S5.2 — Comparison Engine & Read Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> Design of record: [`docs/Stage 5 - Compare Quotes - Design.md`](../../Stage%205%20-%20Compare%20Quotes%20-%20Design.md) §7 (recommendation) + §11 (read model/APIs). Master plan: [`Stage 5 - Implementation Plan.md`](Stage%205%20-%20Implementation%20Plan.md). Predecessor: **S5.1 (FX Master, PR #52)** — this consumes its `toUsd` / `latestRateByCurrency`.

**Goal:** The USD-normalised, per-`(FF × rate-variant)` comparison **read model** for a query, plus the live priority-driven **recommendation** — all read-only (no writes, no migration).

**Architecture:** A pure recommendation function + a small transit-key helper in `@svyft/shared`; a shared DTO module; one read-only NestJS `comparison` module that assembles the per-leg comparison from each submitted quote's `draftJson` (via `computeQuoteTotals` + `toUsd`) and the latest FX rates, then attaches the recommendation. No status changes, no persistence.

**Tech Stack:** NestJS + Prisma (`apps/api`), pure-TS + Zod (`packages/shared`). No React in this sub-build (the screen is S5.6).

## Global Constraints

_Inherits the master plan's Global Constraints (the `pnpm run ci` gate; shared-enum pattern; Prisma `--schema` + hand-authored migrations; e2e `await app.close()` + `seedReferenceData` + namespaced rows; RBAC; `Decimal`→`Number`). Plus, specific to S5.2:_

- **Base = `main` after PR #52 (S5.1) merges** — this consumes `toUsd` / `latestRateByCurrency` from `@svyft/shared` `fx.ts`. Do the fresh-worktree setup and confirm S5.1's symbols resolve before starting.
- **Read-only:** no Prisma migration, no `StatusService.fire`, no writes. `GET` only.
- **RBAC:** the comparison read is **Executive+** (auth-only, no `@Roles`).
- **Reuse the engine, don't reimplement it:** per-variant grand totals come from `computeQuoteTotals(draftJson)`; never re-derive totals by hand.
- Reusable codebase facts (from S5.1): caller id is `user.userId` (`RequestUser`); the Prisma CLI needs `set -a; . apps/api/.env; set +a`; an e2e that writes a `@db.Uuid` actor column needs `sub: randomUUID()` in the cookie.

## File-Structure Map

| File | Responsibility |
| :-- | :-- |
| `packages/shared/src/recommend.ts` (+ `recommend.test.ts`) | Pure `recommendOffer` ranking + the `transitKeyForVariant` helper |
| `packages/shared/src/award.ts` (+ `award.test.ts` if needed) | The comparison DTOs (`OfferDto`, `LegComparisonDto`, `RecommendationDto`, `ComparisonDto`, `PendingForwarderDto`) |
| `packages/shared/src/index.ts` | re-export the two new modules |
| `apps/api/src/modules/comparison/comparison.service.ts` | Assemble the `ComparisonDto` for a query |
| `apps/api/src/modules/comparison/comparison.controller.ts` | `GET /api/queries/:id/comparison` (Executive+) |
| `apps/api/src/modules/comparison/comparison.module.ts` | Wire it; register in `app.module.ts` |
| `apps/api/test/comparison.e2e-spec.ts` | End-to-end: 2 FFs, 2 currencies, a High-priority query |

---

## Task 1 — shared: `recommendOffer` + `transitKeyForVariant`

**Interfaces — Produces:**
- `transitKeyForVariant(mode: FreightMode | null, variant: ChargeRateVariant | null): TransitVariantKey`
- `type RecommendOffer = { quoteId: string; variant: ChargeRateVariant | null; usdTotal: number | null; transitDays: number | null; submittedAt: string }`
- `type RecommendResult = { quoteId: string; variant: ChargeRateVariant | null }`
- `recommendOffer(input: { priority: Priority; offers: RecommendOffer[] }): RecommendResult | null`

**Consumes:** `Priority` (`./query`), `ChargeRateVariant` / `FreightMode` / `TransitVariantKey` / `SEA_VARIANT_KEY` / `AIR_VARIANT_KEY` (`./quote`).

- [ ] **Step 1: Write the failing test** `packages/shared/src/recommend.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { recommendOffer, transitKeyForVariant, type RecommendOffer } from "./recommend";
import { SEA_VARIANT_KEY, AIR_VARIANT_KEY } from "./quote";

const o = (p: Partial<RecommendOffer> & { quoteId: string }): RecommendOffer => ({
  variant: null, usdTotal: 1000, transitDays: 5, submittedAt: "2026-08-10T00:00:00.000Z", ...p,
});

describe("transitKeyForVariant", () => {
  it("Road keys transit by the variant itself", () => {
    expect(transitKeyForVariant("ROAD", "DEDICATED")).toBe("DEDICATED");
    expect(transitKeyForVariant("ROAD", "GROUPAGE")).toBe("GROUPAGE");
  });
  it("Sea collapses both FCL/LCL to the common SEA key", () => {
    expect(transitKeyForVariant("SEA", "FCL")).toBe(SEA_VARIANT_KEY);
    expect(transitKeyForVariant("SEA", "LCL")).toBe(SEA_VARIANT_KEY);
  });
  it("Air (and null variant) uses the AIR key", () => {
    expect(transitKeyForVariant("AIR", null)).toBe(AIR_VARIANT_KEY);
    expect(transitKeyForVariant(null, null)).toBe(AIR_VARIANT_KEY);
  });
});

describe("recommendOffer", () => {
  it("HIGH → fastest transit wins", () => {
    const r = recommendOffer({ priority: "HIGH", offers: [
      o({ quoteId: "slow", transitDays: 5, usdTotal: 900 }),
      o({ quoteId: "fast", transitDays: 3, usdTotal: 1200 }),
    ]});
    expect(r?.quoteId).toBe("fast");
  });
  it("HIGH transit tie → lower price wins", () => {
    const r = recommendOffer({ priority: "HIGH", offers: [
      o({ quoteId: "pricey", transitDays: 3, usdTotal: 1200 }),
      o({ quoteId: "cheap", transitDays: 3, usdTotal: 1000 }),
    ]});
    expect(r?.quoteId).toBe("cheap");
  });
  it("URGENT behaves like HIGH (fastest wins)", () => {
    const r = recommendOffer({ priority: "URGENT", offers: [
      o({ quoteId: "fast", transitDays: 2, usdTotal: 1500 }),
      o({ quoteId: "slow", transitDays: 4, usdTotal: 800 }),
    ]});
    expect(r?.quoteId).toBe("fast");
  });
  it("MEDIUM → lowest price wins", () => {
    const r = recommendOffer({ priority: "MEDIUM", offers: [
      o({ quoteId: "fast", transitDays: 2, usdTotal: 1500 }),
      o({ quoteId: "cheap", transitDays: 6, usdTotal: 800 }),
    ]});
    expect(r?.quoteId).toBe("cheap");
  });
  it("MEDIUM price tie → faster transit wins", () => {
    const r = recommendOffer({ priority: "LOW", offers: [
      o({ quoteId: "slow", transitDays: 6, usdTotal: 1000 }),
      o({ quoteId: "fast", transitDays: 3, usdTotal: 1000 }),
    ]});
    expect(r?.quoteId).toBe("fast");
  });
  it("final tie → earliest submittedAt wins (deterministic)", () => {
    const r = recommendOffer({ priority: "HIGH", offers: [
      o({ quoteId: "later", transitDays: 3, usdTotal: 1000, submittedAt: "2026-08-11T00:00:00.000Z" }),
      o({ quoteId: "earlier", transitDays: 3, usdTotal: 1000, submittedAt: "2026-08-10T00:00:00.000Z" }),
    ]});
    expect(r?.quoteId).toBe("earlier");
  });
  it("excludes offers with no USD total (missing FX) or no transit days", () => {
    const r = recommendOffer({ priority: "MEDIUM", offers: [
      o({ quoteId: "noFx", usdTotal: null, transitDays: 2 }),
      o({ quoteId: "noTransit", usdTotal: 500, transitDays: null }),
      o({ quoteId: "ok", usdTotal: 900, transitDays: 4 }),
    ]});
    expect(r?.quoteId).toBe("ok");
  });
  it("returns null when nothing is rankable", () => {
    expect(recommendOffer({ priority: "HIGH", offers: [] })).toBeNull();
    expect(recommendOffer({ priority: "HIGH", offers: [o({ quoteId: "x", usdTotal: null })] })).toBeNull();
  });
});
```
- [ ] **Step 2: Run it → FAIL.** `pnpm --filter @svyft/shared test -- src/recommend.test.ts`
- [ ] **Step 3: Implement** `packages/shared/src/recommend.ts`:
```ts
import type { Priority } from "./query";
import {
  SEA_VARIANT_KEY,
  AIR_VARIANT_KEY,
  type ChargeRateVariant,
  type TransitVariantKey,
} from "./quote";
import type { FreightMode } from "./config";

/** Which `guaranteedTransitDaysByVariant` key an (FF × freight-variant) offer reads its transit
 *  from: Road keys per-variant (Dedicated/Groupage differ); Sea collapses FCL/LCL to one common
 *  value; Air (or an unresolved mode) uses its single key. Mirrors `variantsForTransit`. */
export function transitKeyForVariant(
  mode: FreightMode | null,
  variant: ChargeRateVariant | null,
): TransitVariantKey {
  if (mode === "ROAD") return (variant ?? AIR_VARIANT_KEY) as TransitVariantKey; // DEDICATED | GROUPAGE
  if (mode === "SEA") return SEA_VARIANT_KEY;
  return AIR_VARIANT_KEY;
}

export interface RecommendOffer {
  quoteId: string;
  variant: ChargeRateVariant | null;
  usdTotal: number | null; // null = no FX rate → excluded from ranking
  transitDays: number | null; // null → excluded from ranking
  submittedAt: string; // ISO — final deterministic tie-break
}
export interface RecommendResult {
  quoteId: string;
  variant: ChargeRateVariant | null;
}

/**
 * Per-leg recommendation over `(FF × variant)` offers (design §7/D4). HIGH/URGENT → fastest
 * transit, tie→lower USD, tie→earliest submit. MEDIUM/LOW → lowest USD, tie→faster transit,
 * tie→earliest submit. Offers missing a USD total (no FX rate) or transit days are excluded.
 * Returns `null` when nothing is rankable. Pure — no IO, no `Date.now()`.
 */
export function recommendOffer(input: { priority: Priority; offers: RecommendOffer[] }): RecommendResult | null {
  const rankable = input.offers.filter((o) => o.usdTotal != null && o.transitDays != null);
  if (rankable.length === 0) return null;
  const speedFirst = input.priority === "HIGH" || input.priority === "URGENT";
  const sorted = [...rankable].sort((a, b) => {
    const price = a.usdTotal! - b.usdTotal!;
    const transit = a.transitDays! - b.transitDays!;
    const submit = a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0;
    return speedFirst ? transit || price || submit : price || transit || submit;
  });
  const best = sorted[0];
  return { quoteId: best.quoteId, variant: best.variant };
}
```
- [ ] **Step 4: Re-export** — add `export * from "./recommend";` to `packages/shared/src/index.ts`.
- [ ] **Step 5: Run tests → PASS + build shared.** `pnpm --filter @svyft/shared test -- src/recommend.test.ts` then `pnpm --filter @svyft/shared build`.
- [ ] **Step 6: Commit** — `git commit -am "feat(stage5): recommendOffer + transitKeyForVariant (shared)"` (end message with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer).

---

## Task 2 — shared: comparison DTOs (`award.ts`)

**Interfaces — Produces** (consumed by Task 3 + later S5.3–S5.6):
- [ ] **Step 1: Implement** `packages/shared/src/award.ts` (pure type module — no runtime, so no separate test; it is exercised by Task 3's e2e):
```ts
import type { ChargeRateVariant } from "./quote";
import type { FreightMode } from "./config";
import type { Priority } from "./query";
import type { QuoteStatus } from "./status";

/** One comparable offer = a quoted FF's price for one freight-variant column on one leg. */
export interface OfferDto {
  quoteId: string;
  freightForwarderId: string;
  freightForwarderName: string;
  variant: ChargeRateVariant | null; // the freight column (null = Air's single column)
  variantLabel: string; // "Dedicated" | "Groupage" | "FCL" | "LCL" | "—"
  priced: boolean; // the variant carries its own freight rate (Air: any charge) — only priced offers are rankable
  nativeTotal: number; // grandTotal in the quote's own currency
  currency: string;
  unitsPerUsd: number | null; // the FX rate used (null if none on file)
  usdTotal: number | null; // toUsd(nativeTotal, currency, rate)
  transitDays: number | null; // guaranteed transit for this variant's transit key
  chargeableWeightKg: number;
  validUntil: string | null; // the RFQ's quoteValidityUntil
  quoteStatus: QuoteStatus;
}
/** An FF that was sent this leg but has not (yet) produced a comparable quote. */
export interface PendingForwarderDto {
  freightForwarderId: string;
  freightForwarderName: string;
  quoteStatus: QuoteStatus; // RFQ_SENT (awaiting) | REQUOTED | EXPIRED | INVALID | CLOSED
}
export interface RecommendationDto {
  quoteId: string;
  variant: ChargeRateVariant | null;
  reason: string; // human string, e.g. "High priority → fastest transit (3 days); price broke the tie."
}
export interface LegComparisonDto {
  legId: string;
  legCode: string;
  mode: FreightMode | null;
  origin: string;
  destination: string;
  offers: OfferDto[]; // one per (quoted FF × freight column)
  pendingForwarders: PendingForwarderDto[]; // sent, not yet comparably quoted (the "awaiting" indicator)
  recommendation: RecommendationDto | null;
}
export interface ComparisonDto {
  queryId: string;
  priority: Priority;
  fxAsOf: string | null; // when the FX rates were read (display)
  legs: LegComparisonDto[];
}
```
- [ ] **Step 2: Re-export** — add `export * from "./award";` to `packages/shared/src/index.ts`; then `pnpm --filter @svyft/shared build`; `pnpm --filter @svyft/shared exec tsc --noEmit`.
- [ ] **Step 3: Commit** — `git commit -am "feat(stage5): comparison DTOs (award.ts)"` (+ trailer).

---

## Task 3 — api: `comparison` module (`GET /queries/:id/comparison`)

**Interfaces — Consumes:** everything from Tasks 1–2 + `computeQuoteTotals` (`@svyft/shared` `quote-engine.ts`) + `variantsForMode` / `rateVariantLabel` / `AIR_VARIANT_KEY` (`quote.ts`) + `toUsd` / `latestRateByCurrency` / `FxRateDto` (S5.1 `fx.ts`). **Produces:** `GET /api/queries/:id/comparison` → `ComparisonDto`.

**READ FIRST** (the implementer must read these to write the exact Prisma query — they are the pattern, not guesswork):
- `apps/api/src/modules/rfq/rfq.service.ts` → `getRfqState` — how quotes/RFQs/FFs are loaded for a query (mirror its `where`/joins; **but this task selects `draftJson`, `status`, `submittedAt` per quote, which `getRfqState` deliberately drops**).
- `prisma/schema.prisma` → `Quote` (`draftJson Json?`, `status`, `submittedAt`, `legId`, `freightForwarderId`, `rfqId`), `Rfq` (`currency`, `quoteValidityUntil`), and how a query's legs (`legCode`, endpoints, `mode`) are shaped in `QueryDetail` / the legs read.
- `apps/api/src/modules/fx-rates/fx-rates.service.ts` (S5.1) — reuse it (or `prisma.fxRate.findMany` + `latestRateByCurrency`) to get the latest rate per currency.

**Service assembly logic** (`comparison.service.ts` — `getComparison(queryId): Promise<ComparisonDto>`):
1. Load the query (its `priority` and its legs: `legId`, `legCode`, `mode`, origin/destination names).
2. Load all quotes for the query with `draftJson`, `status`, `submittedAt`, `legId`, `freightForwarderId`; and the FFs (id→name), and each quote's RFQ `currency` + `quoteValidityUntil`.
3. Load the latest FX rate per currency: `latestRateByCurrency(await fxRatesService.list())`.
4. Per leg, per **QUOTED**/`REQUOTED` quote (has a `draftJson`): `const totals = computeQuoteTotals(draft)`. For each `v of variantsForMode(draft.mode)`:
   - `const vt = totals.variants.find(t => t.key === (v ?? AIR_VARIANT_KEY))!` → `nativeTotal = vt.grandTotal`, `priced = vt.rateAmount != null || (draft.mode !== "ROAD" && draft.mode !== "SEA" && totals.additionalChargeSum > 0)`.
     - (Road/Sea: `priced = vt.rateAmount != null`; Air: priced if any charge — mirror `isVariantPriced`; keep this in the service, it's read-only presentation.)
   - `const rate = ratesByCurrency.get(currency) ?? null` → `usdTotal = toUsd(nativeTotal, currency, rate)`, `unitsPerUsd = rate?.unitsPerUsd ?? null`.
   - `const transitDays = draft.transit?.guaranteedTransitDaysByVariant[transitKeyForVariant(draft.mode, v)] ?? null`.
   - Push an `OfferDto` (`variantLabel = v ? rateVariantLabel(v) : "—"`).
5. `pendingForwarders` = the leg's FFs whose quote status is `RFQ_SENT`/`REQUOTED`/`EXPIRED`/`INVALID`/`CLOSED` (i.e., no comparable submission) → `PendingForwarderDto[]`.
6. Recommendation: `const rec = recommendOffer({ priority, offers: offers.filter(o => o.priced).map(o => ({ quoteId: o.quoteId, variant: o.variant, usdTotal: o.usdTotal, transitDays: o.transitDays, submittedAt: <that quote's submittedAt> })) })`. If non-null, build `RecommendationDto` — find the winning offer, set `reason` from the priority rule + the winner's transit/price (e.g. `` `High priority → fastest transit (${d} days)${tie ? "; price broke the tie" : ""}.` ``).
7. Return `{ queryId, priority, fxAsOf: <now-ISO passed in or the max rate.effectiveFrom>, legs }`. (Pass `nowIso` in from the controller if you need a stamp — keep the service pure of `Date.now()` where the design's freeze-at-generate matters; here `fxAsOf` is display-only, so reading the latest rate's `effectiveFrom` is fine and avoids `Date.now()`.)

**Controller** (`comparison.controller.ts`): mirror the masters pattern — `@Controller("queries/:id")`, `@Get("comparison")` (NO `@Roles` → Executive+), `getComparison(@Param("id") id)`.

- [ ] **Step 1: Write the failing e2e** `apps/api/test/comparison.e2e-spec.ts`. Mirror the `rfq`/`ff-portal` e2e harness (boot AppModule, cookieParser, `PrismaExceptionFilter`, `setGlobalPrefix("api")`, `seedReferenceData(prisma)` in `beforeAll`, namespaced rows, **`await app.close()`** in `afterAll`, cookie `sub: randomUUID()`). Build a **High-priority** query with **one Road leg** and **two FFs** that have each SUBMITTED a quote (materialize/persist `draftJson` the way the ff-portal submit path does — reuse that helper, or seed `Quote.draftJson` + `status: "QUOTED"` directly): FF-A quotes in **INR** (Dedicated rate → grandTotal ₹123,000, transit 3 days), FF-B in **EUR** (Dedicated → €1,100, transit 3 days). Seed FX rates INR 83.2, EUR 0.92. Assert:
  - `GET /api/queries/:id/comparison` → 200, `body.priority === "HIGH"`, one leg with offers for both FFs.
  - Each offer's `usdTotal` equals `toUsd(nativeTotal, currency, rate)` (INR ₹123,000/83.2 ≈ $1,478; EUR €1,100/0.92 ≈ $1,196).
  - `body.legs[0].recommendation.quoteId` is **FF-B's** quote (both 3 days → tie → FF-B cheaper in USD).
  - An FF with `status: "RFQ_SENT"` (no draft) appears in `pendingForwarders`, not `offers`.
  - A currency with **no FX row** yields `usdTotal: null` on its offers and is excluded from the recommendation.
- [ ] **Step 2: Run it → FAIL** (route missing). `pnpm --filter @svyft/api test -- comparison.e2e-spec.ts`
- [ ] **Step 3: Implement** the service (assembly logic above), controller, and module; register `ComparisonModule` in `app.module.ts`.
- [ ] **Step 4: Run e2e → PASS + lint.** `pnpm --filter @svyft/api test -- comparison.e2e-spec.ts`; `pnpm run lint`.
- [ ] **Step 5: Commit** — `git commit -am "feat(stage5): comparison read model (GET queries/:id/comparison)"` (+ trailer).

### S5.2 acceptance
- [ ] **Run the gate:** `pnpm run ci` green. Then opus whole-branch review → PR to `main`.

---

## Self-review (against the design)
- **Spec coverage:** recommendation rule + tie-breaks + Urgent≡High + exclude-unpriced (design §7/D4) → Task 1; the per-`(FF×variant)` USD-normalised offers + pending indicator + live recommendation (§11 `GET …/comparison`) → Tasks 2–3. The Sea-transit-collapse subtlety is handled by `transitKeyForVariant` (Task 1), so a Sea offer never mis-reads a per-FCL/LCL transit that doesn't exist.
- **Type consistency:** `RecommendOffer`/`RecommendResult` (Task 1) are the exact shape the service maps offers into (Task 3, step 6); `OfferDto`/`LegComparisonDto`/`ComparisonDto` (Task 2) are what the controller returns and S5.6 will render.
- **Placeholder scan:** Tasks 1–2 carry full code; Task 3's Prisma query is intentionally delegated to the read-first files (the implementer mirrors `getRfqState`) — not a silent placeholder, a named pattern to follow, with the full assembly logic + e2e assertions specified.
- **No writes:** confirmed — read-only service, `GET` only, no migration, no `fire`.
