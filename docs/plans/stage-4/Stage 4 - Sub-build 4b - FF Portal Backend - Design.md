# Stage 4 · Sub-build 4b — FF Portal Backend — Design

> Design of record for **SB4b** (the second slice of SB4 — the FF Portal). The authoritative *what/how* remains the Functional Spec (§7.3–§7.4, §9.1, §10.4, §13.2) and the Technical Design (§5.2 endpoints, §6 engine, §8.1 token auth, §9.5 portal, §11 deployment). This doc records the **4b slice boundary + concrete decisions**; it does not re-derive the locked design. Sibling of `Stage 4 - Sub-build 4 - Decomposition & 4a Design.md` (the SB4 decomposition + the SB4a slice).

## SB4b — scope

**Goal:** the **headless** FF Portal backend — the token-guarded `/ff/*` boundary + the three portal endpoints (resolve-scope / draft-save / submit) + submit orchestration + e2e. It **consumes** SB4a (the pure `@svyft/shared` engine + `QuoteDraft`) and the SB2a/2b RFQ/Quote/manifest foundation; it adds **no** new pricing logic. **No UI** (SB4c), no live email / TLS (SB5).

**Locked decisions (from the SB4b brainstorm, 2026-07-29):**
- **Draft persistence = a draft blob → materialize on submit.** A partial `QuoteDraft` (nullable amounts) is stored as JSON on the Quote; the NOT-NULL child tables + `Quote` totals are written **only** on a validated submit. (The alternative — write-through to child tables — was rejected: the child tables' amount columns are NOT NULL, so a partially-typed line can't be stored, and it would mix draft with final data.)
- **Rate-limiting deferred to SB5 go-live.** No real token is transmitted yet (emails are compose-&-log, portal is HTTP-only), so there is nothing to abuse; it pairs with the TLS + live-send swap. Recorded as a carried go-live item.
- **Portal API path = `/api/ff/rfq/:token/*`** — under the existing global `/api` prefix (no `main.ts` global-prefix surgery). The boundary is **behavioural** (the token guard is the only gate on `/ff/*`), not path-cosmetic.

---

### 1. Module + token boundary (§8.1)

- **`FfPortalModule`** (`apps/api/src/modules/ff-portal/`) registered in `AppModule`. Imports `RfqModule` (for `RfqTokenService`), `StatusModule`, `PrismaModule`, `ConfigModule` (density factors).
- **`FfPortalController`** — `@Controller("ff/rfq/:token")`, decorated **`@Public()`** (the SB-existing `@Public()` sets `isPublic` metadata → `JwtAuthGuard` skips; the global `RolesGuard` passes because there is no `@Roles`). The token guard is applied with `@UseGuards(RfqTokenGuard)`.
- **`RfqTokenGuard`** (`implements CanActivate`) — the **only** real gate on `/ff/*`:
  - reads the `:token` route param, computes `RfqTokenService.hash(token)`, and resolves `prisma.rfq.findUnique({ where: { accessTokenHash }, include: { quotes: { include: { leg: { …points } } } } })` (unique-index lookup → constant-time, no enumeration).
  - miss → `throw new UnauthorizedException("This RFQ link is invalid or has expired")` (generic; no distinction between not-found and revoked — no enumeration).
  - hit → attaches a **scoped context** to the request: `request.ffScope = { rfq, quotes }` (that RFQ's quotes only, each with its leg + the frozen `manifestSnapshot`). Every downstream read/write is filtered to this scope; a `:legId` not among `ffScope.quotes` → `403` (D4 leg-visibility isolation).
- **`RfqTokenService` gains `resolveByToken(rawToken)`** — the hash + `findUnique` + include helper (the mint/hash halves already exist; there is no resolver today). The guard delegates to it.
- **Interim transport:** plain HTTP (no TLS) — safe for this phase only (B2). TLS is the SB5 go-live gate.

### 2. Endpoints (§5.2)

All under `/api/ff/rfq/:token`, `@Public()` + `RfqTokenGuard`. Errors use the standard `Finding[]` envelope where they carry submit findings (§5.3).

| Method + path | Purpose | Success | Failure |
|---|---|---|---|
| **`GET /`** | Resolve scope: the FF's RFQ header + its assigned legs (rendered from the frozen manifest), with seeded presets/density + any saved draft. | `200 FfPortalRfqDto` | `401` bad token |
| **`PATCH /quotes/:legId`** | Draft-save (last-write-wins, **no** business validation). | `200 { savedAt }` | `401`/`403` scope · `400` malformed body (Zod shape only) |
| **`POST /quotes/:legId/submit`** | Validate (§10.4 Q1–Q8) → materialize pricing → fire `SUBMIT`. | `201 { quoteId, status: "QUOTED" }` | `422 { findings }` invalid · `409` not in `RFQ_SENT` (already submitted / not sent) · `401`/`403` |

> **`GET /pdf`** (§13.2) is **deferred** to the polish pass (§8.4 `RfqPdfService`), not built in 4b.

### 3. DTOs (shared — `packages/shared/src/ff-portal.ts`)

- **`FfPortalRfqDto`** (the `GET` response):
  ```
  {
    rfqNumber: string;
    incoterms: string | null;
    submissionDeadline: string;              // ISO — from Rfq (NOT Quote)
    currency: string | null;                 // Rfq.currency ?? FreightForwarder.defaultCurrency
    quoteValidityUntil: string | null;       // Rfq.quoteValidityUntil
    freightForwarder: { companyName: string };
    legs: FfPortalLegDto[];
  }
  FfPortalLegDto = {
    legId: string; quoteId: string; status: QuoteStatus;
    manifest: ManifestSnapshot;              // the frozen SB2b snapshot (cargo, mode, endpoints, dates)
    endpoints: { pointId: string; type: PointType; name: string | null; country: string | null;
                 warehousePosition: WarehousePosition | null }[];  // structural point IDs for trucking/warehouse FKs
    seededCharges: { zone: ChargeZone; presetKey: string; label: string; isPreset: true; amount: null }[]; // Air/Sea only
    seededDensity: { cargoItemId: string; freightDensity: number }[]; // kg/CBM by leg mode
    draft: QuoteDraft | null;                // Quote.draftJson, if the FF saved one
  }
  ```
- **`QuoteDraft`** (SB4a, `@svyft/shared`) is reused verbatim as the **`PATCH` body** and the submit input. A `quoteDraftSchema` (Zod) validates its **shape** on `PATCH` (well-formed, correct types) — **not** the Q1–Q8 business rules (those are submit-only).
- Decimal → string in DTOs (Stage-3 convention); the engine works in `number` (the manifest's Decimal strings are parsed at the boundary).

### 4. Point IDs & warehouse positions (non-obvious — call out for the plan)

- The frozen `manifestSnapshot` carries cargo + origin/destination as `{ country, name, city }` **but not Point IDs**. `TruckingCharge.legEndpointPointId` and `WarehouseStagingLine.warehousePointId` are **FK→Point (Restrict)**, so the portal needs real Point IDs. These come from the **token-scoped leg's points** (a legitimate scoped read — the leg belongs to the token's RFQ), returned in `FfPortalLegDto.endpoints`. Cargo still renders from `manifestSnapshot.cargo` (never the live query) — the "never the live graph" rule is about **stale cargo**, not the leg's own structural endpoints.
- **Warehouse Origin/Destination is a per-RFQ (cross-leg) classification:** `classifyWarehousePositions(legs, warehousePointIds)` (SB4a) takes the FF's **whole** assigned-leg set. The `GET` computes the position map once across all `ffScope` legs and stamps each warehouse endpoint's `warehousePosition`. Charge zones, trucking, and transit are per-leg.

### 5. Persistence model — draft blob → materialize on submit

- **Migration (additive):** add **`Quote.draftJson Json?`** (nullable). One small migration (`add_quote_draft_json`); hand-authored + `migrate deploy` (project convention — `migrate dev` needs a TTY).
- **`PATCH` (draft-save):** Zod-shape-check the body → `prisma.quote.update({ where: { id }, data: { draftJson: body } })` (last-write-wins). RFQ-level **currency + quoteValidityUntil** are upserted to **`Rfq`** (shared across the FF's legs, §7.3.1) so every leg's `GET` pre-fills consistently. No child-table writes, no status change, no validation.
- **`POST …/submit`:**
  1. Assemble the `QuoteDraft` from `Quote.draftJson` + the RFQ-level `Rfq.currency`/`quoteValidityUntil`.
  2. Guard status: the Quote must be in **`RFQ_SENT`** → else `409` (already submitted / not distributed).
  3. `validateQuote(draft, rfq.submissionDeadline, nowIso)` → non-empty findings ⇒ **`422 { findings }`**, no writes, no status change. (Q7 catches past-deadline here — the portal refuses submit after the deadline even though the auto-expiry sweep is SB5.)
  4. Valid ⇒ one `prisma.$transaction`:
     - `computeQuoteTotals` + per-row `computeChargeableWeight`; `classifyWarehousePositions` for the warehouse rows.
     - **materialize** the 5 child tables (delete-existing-then-create for this Quote — idempotent replace-all): `QuoteCargoLine` (freightDensity + chargeableWeightT), `ChargeLine` (Air/Sea, `isPreset`/`presetKey`/`sortOrder`), `TruckingCharge` (Road), `WarehouseStagingLine` (position from the classifier), `TransitPlan` (1:1).
     - update `Quote`: `totalChargeableWeightT`, `grandTotal`, `dgSurchargeNote`, `termsConditions`, `submittedAt = now`, `draftJson = null` (child tables are now authoritative).
     - **guard the `Point` Restrict-FK:** a `P2003` on `TruckingCharge`/`WarehouseStagingLine` (a priced point vanished) → catch and map to a domain `Finding`/`422` (P2003 is unmapped by default — the carried 4a follow-up).
  5. **AFTER the tx:** `StatusService.fire("quote", quoteId, QuoteEvent.SUBMIT, { queryId })` (fire owns its own tx) → `RFQ_SENT→QUOTED` → `LegQuoteProjector` (`@OnEvent("quote.status.changed")`) rolls the leg up (`PARTIALLY_QUOTED`/`FULLY_QUOTED`) → the `QueryStatusProjector` rollup comes free.

### 6. Seeding (on `GET`, response-only)

- **Charge presets:** `AIR_CHARGE_PRESETS`/`SEA_CHARGE_PRESETS` by leg mode (Road → no zone presets; the FF prices trucking blocks instead), returned in `seededCharges` with `amount: null`.
- **Density:** `ConfigDataService.densityFactors()` → the `{ mode, kgPerCbm }` for the leg's mode → each cargo row's default `freightDensity`, returned in `seededDensity`.
- Seeding is **computed into the `GET` response only** — never persisted. The FF's actual values persist via `PATCH` (draftJson) → `submit` (child tables). If a `draft` exists, the FF's saved values take precedence in the UI over the seeds (4c merges).

### 7. Reuse — consume, don't rebuild

- **SB4a (`@svyft/shared`):** `validateQuote` / `computeQuoteTotals` / `computeChargeableWeight` / `classifyWarehousePositions`; `QuoteDraft`; `AIR_/SEA_CHARGE_PRESETS`; the 5 pricing tables + `Quote` pricing cols + 4 enums.
- **SB2a:** `RfqTokenService.mint/hash`; the Quote machine `SUBMIT` edge (`RFQ_SENT→QUOTED`) + `LegQuoteProjector` + contributed leg edges; `StatusService.fire`.
- **SB2b:** the frozen `Quote.manifestSnapshot` (the read-only cargo source); `loadLegForRfq` / the leg-points shape.
- **Stage-3/config:** `ConfigDataService.densityFactors()`; `@Public()` + the global guard wiring; `PrismaExceptionFilter` (P2003 NOT mapped → guard in the service).

### 8. Tests

- **api e2e** (`apps/api/test/ff-portal.e2e-spec.ts`) — self-contained (create Query→Points→CargoItem→Leg→FF, `ff-selection`, `distribute` to mint a real token), PFX-scoped cleanup, **`await app.close()`** (cron-hang):
  - **unauthenticated resolve:** `GET` with the raw token (no JWT cookie) → `200`, scoped legs + seeded presets/density.
  - **scope isolation:** a token cannot `GET`/`PATCH`/`submit` a leg outside its RFQ → `403`; a bad token → `401`.
  - **draft-save → resume:** `PATCH` a partial draft → `GET` shows it back.
  - **submit happy-path:** valid draft → `201`, Quote `QUOTED` + `submittedAt` set + child tables populated + leg rolled up (`FULLY_QUOTED` when it's the only FF) + query rollup.
  - **submit-invalid:** missing density/currency/etc. → `422 { findings }`, Quote stays `RFQ_SENT`, no child rows.
  - **expired-deadline:** submit past `rfq.submissionDeadline` → `422` with a Q7 finding.
  - **double-submit:** submit an already-`QUOTED` quote → `409`.
- **Shared unit tests (carried 4a follow-ups):** add the **Q3 "validity absent"** case + **isolate the Q4/Q5/Q6/Q7** rules (SB4a asserted Q4–Q7 together) in `quote-engine.test.ts`.

### 9. Concrete decisions (locked for the plan)

- **Draft store:** `Quote.draftJson Json?` (one additive migration); child tables written only on submit.
- **RFQ-level currency + validity** live on **`Rfq`** (pre-filled from `FreightForwarder.defaultCurrency`), upserted on draft-save, validated (Q3/Q4) + confirmed on submit.
- **Path:** `/api/ff/rfq/:token/*`; guard-enforced boundary; JWT never honored (via `@Public()`).
- **Point IDs** for trucking/warehouse FKs come from the token-scoped leg's points; **warehouse positions** classified across the FF's full leg set.
- **Submit** is transactional for persistence; **status fires AFTER the tx** (the one `StatusService.fire` door); **P2003 → domain finding**.
- **Rate-limiting, PDF, scoped route diagram, FF Preview, live email/TLS** — **out of scope** (SB5 / polish / 4c).

### 10. Out of scope / deferred

| Item | Where |
|---|---|
| Portal UI (`/ff/rfq/:token` SPA + panels + client engine) | **SB4c** |
| Per-token / per-IP rate-limiting (§8.1 hardening) | **SB5 go-live** (with TLS) |
| Live email send + TLS/domain | **SB5 go-live** |
| Reminder/expiry scheduler + auto-discard-draft + `EXPIRED` sweep + "No Response" | **SB5** |
| PDF (`RfqPdfService`, `GET /ff/rfq/:token/pdf`, §8.4/§13.2) | polish pass |
| Scoped route diagram (§7.3.4) · FF read-only Preview (§7.4.7) | polish pass |
| Change-order re-freeze / `INVALID` re-distribute cascade | **SB6** |

## Build workflow

`superpowers:brainstorming` (this doc — DONE) → `superpowers:writing-plans` (this doc + Technical Design §5.2/§8.1/§6 + spec §7.4/§10.4/§13.2 are the inputs) → `superpowers:subagent-driven-development` (fresh implementer per task, TDD, per-task spec+quality review, **opus** whole-branch review) → PR `feat/stage-4-sb4b` → `main`. Worktree already set up at `.claude/worktrees/feat+stage-4-sb4b` (off `main`@`b8b852b`); run the fresh-worktree setup (`pnpm install`, copy `apps/api/.env`, `pnpm exec prisma generate`, `pnpm --filter @svyft/shared build`) before implementation.
