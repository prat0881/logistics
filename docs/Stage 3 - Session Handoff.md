# Stage 3 — Session Handoff & Progress

> Resume point for a fresh session. Points to the deliverables and records what's done + what's next so nothing is re-litigated.

## Current status (2026-07-18)
- ✅ **Functional spec** — `Stage 3 - Create Query - Functional Spec.md` (behaviour; decisions D1–D12). *The what.*
- ✅ **Technical design** — `Stage 3 - Technical Design.md` (architecture, data model, APIs, extensibility core, deployment). *The how.*
- ✅ **Plan 0 (Foundation)** — merged + **deployed LIVE**. `docs/plans/stage-3/2026-07-16-plan-0-foundation.md`.
- ✅ **Plan 1 (Auth & RBAC)** — merged (PR #2) + deployed. JWT access token in an httpOnly cookie + rotating refresh (SHA-256-hashed in `RefreshToken`); global `JwtAuthGuard`+`RolesGuard` (Executive/Manager/Administrator); seeded users; login UI. `docs/plans/stage-3/2026-07-17-plan-1-auth.md`.
- ✅ **CD fix** — merged (PR #3). Repo `docker-compose.prod.yml` now matches the live `:4096` HTTP stack; deploy uses `up -d --force-recreate`.
- ✅ **Plan 2 (Masters & Reference Data)** — merged (PR #4/#6) + cleanup (PR #5) + deployed. Clients (+contacts API), Vessels, Config (density factors + checklist); masters/admin UI; idempotent reference-data seed; a global `PrismaExceptionFilter`. `docs/plans/stage-3/2026-07-17-plan-2-masters.md`.
- ✅ **Plan 3 (Extensibility Core)** — merged (PR #8) + deployed. The reusable framework future stages plug into (Technical Design §7): the **Status Machine** (`status` module — `StatusService.fire`, declarative transition registry, log-backed state store, leg machine `DRAFT ↔ READY_FOR_RFQ`, in-process domain events, `deriveQueryStatus` projection) and the **Change-Impact mediator** (`changes` module — per-entity `ImpactRegistry`, the Free-path / Change-order fork, `reopen` seam). `StatusTransition` log + migration #3. Generic types in `@svyft/shared`. `docs/plans/stage-3/2026-07-18-plan-3-extensibility.md`.
- 🔜 **Next: Plan 4 — Query + Cargo** (the Query aggregate root + Cargo rows + checklist + MSDS uploads, wiring the now-built Extensibility Core).
- Live: `http://142.93.220.226:4096` — HTTP only, no domain/TLS yet.

## Read order for a fresh session
1. `Stage 3 - Create Query - Functional Spec.md` — the *what*. **For Plan 4:** §7.1 (Client & Query Details), §7.2 (Shipment Details), §7.3 (Cargo — the dynamic table, DG/MSDS, volume CBM), §7.5 (Internal Notes & checklist), §9 (status lifecycle), §13 (form actions incl. Create Query). *(Legs/route/§7.4 + §10 route rules are Plan 5.)*
2. `Stage 3 - Technical Design.md` — the *how*. **For Plan 4:** §4.2 (Query/CargoItem/QueryChecklistItem/FileAsset), §4.4 (`YALYY-NNNN` minting), §4.5 (derived vs stored — `volumeCbm` generated column, `dgIndicator` synced), §5.2 (APIs), §8.4 (file storage), §8.6 (Excel export). **§7 Extensibility Core is now BUILT** — Plan 4 *plugs into it* (never hand-write a status → `StatusService.fire`; never raw-write a user-editable field → `ChangeMediator.apply`; contribute impact classes → `ImpactRegistry.declare`). See the golden rules in Technical Design §0.
3. This file — current state, roadmap, conventions, open items.

## Roadmap (each plan = its own branch → PR)
Plan 0 Foundation ✅ · Plan 1 Auth & RBAC ✅ · Plan 2 Masters & Reference Data ✅ · Plan 3 Extensibility Core ✅ · **Plan 4 Query + Cargo (next)** · Plan 5 Points/Legs/Route Engine · Plan 6 Wizard & Query List UI · Plan 7 Notifications/Escalations/Emails · Plan 8 Completion & hardening.

## What's built so far (the foundation Plan 4+ extends)
- **Monorepo** (Plan 0): `apps/api` (NestJS + Prisma), `apps/web` (Vite/React/Tailwind/shadcn/TanStack Query), `packages/shared` (isomorphic zod schemas + types + enums). Docker + GitHub Actions CI/CD.
- **Auth/RBAC** (Plan 1): global secure-by-default guards + decorators in `apps/api/src/modules/auth/` — `@Roles(...Role[])`, `@Public()`, `@CurrentUser()`; `JwtStrategy` (cookie); `AuthService` (login/refresh/logout/me). `Role` enum + auth contracts in `@svyft/shared`.
- **Masters** (Plan 2): `clients`/`vessels`/`config` modules; reusable `ZodValidationPipe` (`apps/api/src/common/zod-validation.pipe.ts`); **global `PrismaExceptionFilter`** (`apps/api/src/common/prisma-exception.filter.ts`, registered in `main.ts`) mapping P2023→400, P2025→404, P2002→409, validation→400; `CodeSequence`-based `CL-`/`VS-` minting (inline `tx.codeSequence.upsert` in the create transaction); web↔`@svyft/shared` wiring (React Hook Form + `zodResolver`).
- **Extensibility Core** (Plan 3): the framework Plan 4+ plug into (Technical Design §7).
  - `apps/api/src/modules/status/` — `StatusService.fire(key, entityId, event, ctx)` (THE one guarded door: load current state → match a declared transition → guard (blocks with `Finding[]`) → append a `StatusTransition` row in-tx → run effect → emit `${key}.status.changed` **after commit**); `StatusRegistry` (`.register`/`.contribute` — clones on register so contributions can't mutate the source machine); a **log-backed `StatusStateStore`** (current state = latest `StatusTransition.to` by `seq`); the leg machine (`DRAFT ↔ READY_FOR_RFQ`, incl. the reserved `reopen` reverse edge); `QueryStatusProjector` (`@OnEvent('leg.status.changed')` → `recompute` — a **stub** until Query exists). In-process events via **`@nestjs/event-emitter`** (`EventEmitterModule.forRoot()` in `AppModule`).
  - `apps/api/src/modules/changes/` — `ChangeMediator.apply(req, uow)` (classify → `ScopeResolver.downstreamWork` → `decidePath` fork); per-entity `ImpactRegistry` (`.declare`); `ImpactClassifier`; **`FreePathStrategy`** (built: apply-via-uow-in-tx → revalidate → change-log); **`ChangeOrderStrategy`** (a stub that can never fire — resolver ≡ false); no-op `RouteValidator` + `ChangeLog` DI-token ports.
  - `@svyft/shared` — generic `Guard`/`Effect`/`Transition`/`Machine` types + `findTransition`; `LegStatus`/`LegEvent`/`QueryStatus` vocabularies (+ companion arrays); pure `deriveQueryStatus`; `ImpactClass`/`IMPACT_RANK`/`ChangeRequest`/`ImpactDecision` + pure `decidePath`.
- **Prisma models:** `User`, `RefreshToken`, `Client`, `ClientContact`, `Vessel`, `FreightDensityFactor`, `ChecklistDefinition`, `CodeSequence`, **`StatusTransition`** (append-only, `seq` autoincrement for deterministic "latest"). **Migrations:** `init_auth`, `masters_config`, `status_transition`. Every table has a nullable `tenantId` (tenant-ready). **Not built yet (Plan 4/5):** `Query`, `CargoItem`, `QueryChecklistItem`, `FileAsset`, `QuerySequence` (Plan 4); `Point`, `Leg`, `LegCargo` + the route-validation engine (Plan 5).

## Stack
pnpm monorepo · NestJS 10 (+ `@nestjs/event-emitter` for in-process domain events) + Prisma 5 (Neon Postgres) · Vite + React 18 + Tailwind + shadcn/ui + TanStack Query + React Hook Form · Docker + GitHub Actions CI/CD. Repo: `github.com/sj132q/svyft-logistics`. Local dev: `README.md` (Docker Postgres + `pnpm dev`; `DEV_DB_PORT` override; after install run `prisma migrate deploy` + `prisma db seed`).

## Deployment facts
- Droplet `142.93.220.226` (Bangalore), Docker, **shared** with another app (on `:5173`). Our app: HTTP on **`:4096`** (no domain/TLS yet).
- Neon Postgres (Singapore `ap-southeast-1`); pooled+direct URLs + `JWT_ACCESS_SECRET` + `SEED_*` + `COOKIE_SECURE=false` live in droplet `/opt/svyft-logistics/.env` (NOT in the repo).
- **Prod compose = `docker-compose.prod.yml`** (HTTP `:4096`, no Caddy); the Caddy/HTTPS variant is `docker-compose.caddy.yml` (for when a domain lands). Keep the droplet's copy in sync with the repo.
- **CD:** pushing runtime code (`apps/**`, `packages/**`, `prisma/**`, `pnpm-lock.yaml`) to `main` → build image → GHCR → SSH deploy (`prisma migrate deploy` + `compose up -d --force-recreate`). Docs/config pushes do **not** deploy (path-filtered); use the Deploy workflow's **Run workflow** for manual redeploys. *(Plan 3's merge deployed the `status_transition` migration + the `@nestjs/event-emitter` dep — no seed step needed for Plan 3.)*
- **After a fresh deploy, run the seed once** (deploy applies migrations but not the seed): `docker compose -f docker-compose.prod.yml run --rm api node /repo/apps/api/dist/seed/seed.js` — seeds users + reference data (density/checklist/code-sequences), idempotent. (Code minting is upsert-resilient, so client/vessel creates won't 500 if you forget, but the reference data needs it.)
- Secrets set: `DROPLET_HOST`, `DROPLET_USER`, `DROPLET_SSH_KEY`, `GHCR_TOKEN`.

## Conventions & key learnings (reuse in Plan 4)
- **Flow:** brainstorm → write plan (`superpowers:writing-plans`) → subagent-driven execution (`superpowers:subagent-driven-development`, fresh implementer per task, TDD, spec+quality review per task, opus whole-branch review at the end) → finish via PR. New branch per plan (`feat/plan-N-<name>` off `main`); plan doc + implementation ship as one PR. Ledger: `.superpowers/sdd/progress.md` (gitignored scratch — start fresh each plan).
- **Models:** sonnet for implementers + task reviewers; **opus** for the final whole-branch review.
- **Extensibility Core (golden rules — now enforced by real code):** never hand-write a status → go through `StatusService.fire` (add edges via `StatusRegistry.contribute`); never raw-write a user-editable field → route it through `ChangeMediator.apply` (declare its impact class via `ImpactRegistry.declare`); status is projected/derived where it can be (`deriveQueryStatus`), owned+transitioned only where a machine says so.
- **Validation:** bind Zod at **param level** — `@Body(new ZodValidationPipe(schema))` — NOT method-level `@UsePipes` (Nest applies a method-level pipe to `@Param()` too → validates the id against the body schema → wrong 400).
- **Prisma errors:** the global `PrismaExceptionFilter` maps them to 400/404/409 — don't hand-roll per-service 500s. Services throw specific `HttpException`s (e.g. `ConflictException`) which run before the filter; the filter is the backstop.
- **Env timing:** read env at DI/call time, not in a module top-level `const` (`ConfigModule` loads `.env` at init) — use `registerAsync`/a factory or read inside the method.
- **Lint:** `eslint.config.js` now sets `@typescript-eslint/no-unused-vars` `argsIgnorePattern: "^_"` — prefix intentional-unused params with `_` (needed for interface-required no-op stub params, e.g. the change-mediator ports).
- **CI gotcha:** CI runs a **fresh migrated-but-UNSEEDED** Postgres. Tests that reset sequences or depend on accumulated/seeded state pass locally (accumulated dev DB) but fail on CI — verify against `prisma migrate reset --schema prisma/schema.prisma --force --skip-seed` before pushing. Then watch the PR's CI (`gh run watch`).
- **Shared enums:** `const` object + `(typeof X)[keyof typeof X]` string-union, values matching the Prisma enum exactly, **plus a companion `Object.values(...) as [X, ...X[]]` array pinned by a `toEqual` test** (see `packages/shared/src/role.ts`, `status.ts`, `change.ts`).

## Open items / follow-ups (none block Plan 4 — schedule alongside)

**Plan 3 reserved seams / deferred (wire in Plan 4/5 — the framework is built to drop these in without re-plumbing)**
- **Query status persistence (Plan 4):** `QueryStatusProjector.recompute(queryId)` is a stub (logs only) — no `Query` table yet. Plan 4: persist `Query.status` (exercises Draft → Created → RFQ Ready via query-level milestones). The leg-derived rollup via `deriveQueryStatus(legStatuses, …)` fills in when legs land (Plan 5).
- **Change Mediator on real entities (Plan 4):** `ChangeMediator.apply(req, uow)` takes a caller unit-of-work — Plan 4 passes real Query/Cargo writes and declares Query/Cargo impact classes (`ImpactRegistry.declare`). Cargo→leg **scope fan-out** in `ImpactClassifier` (self-scope only today) lands with legs (Plan 5).
- **Leg status column + column-backed store (Plan 5):** `StatusStateStore` is log-backed now; Plan 5 adds the owned `Leg.status` column (column-backed store, or denormalize via the `leg.status.changed` subscriber). `deriveQueryStatus`'s `default` branch (AWARDED/IN_TRANSIT/DELIVERED → QUOTED) is a **placeholder** (`TODO(Plan 5)`) — define real rollup semantics when those leg states activate.
- **Route revalidation (Plan 5):** the `RouteValidator` port is a no-op (`[]`); Plan 5 implements it with `validateRoute` over the query graph. Full Create-Query route validation (§10 R1–R9) needs legs → Plan 5.
- **ChangeOrder cascade + durable change-log (Stage 4+):** `ChangeOrderStrategy` throws (unreachable — `ScopeResolver.downstreamWork` ≡ false); `ChangeLog` is a no-op sink. Both go live with downstream work (RFQ/quotes). The `reopen` edge is already built in the leg machine; the durable change-log + full audit stay deferred (Technical Design §7.7).
- **`fire` concurrency (Stage 4):** reads-then-appends under READ COMMITTED, no row lock (**last-write-wins** per functional spec §8.5 — reviewer-confirmed Stage-3-safe: a duplicate same-transition row is convergent). Pair a row lock / serializable+retry with the cascade that reads prior state from the log.
- **Code hygiene:** relocate `UnitOfWork`/`ChangeResult` from `apps/api/src/modules/changes/free-path.strategy.ts` to a neutral `changes/strategy.types.ts` (or `@svyft/shared`) before Stage 4 fleshes out ChangeOrder; narrow `impact.classifier.ts`'s `req.entity as FindingScope["type"]` cast when Plan 5 adds entities. The `argsIgnorePattern:"^_"` lint rule is repo-wide (intentional — the convention is reused by future no-op ports).

**Security / ops**
- **HTTPS + domain:** prod is HTTP-only on `:4096`, `COOKIE_SECURE=false`. When a domain lands → point CD + the droplet at `docker-compose.caddy.yml`, set `SITE_ADDRESS`, flip `COOKIE_SECURE=true`.
- **Seed-on-deploy gap:** the deploy runs `migrate deploy` but not the seed; every fresh environment needs the manual seed step. Consider folding reference-data seeding into the pipeline.
- **Staging env:** reserved (Neon branch + second compose stack), not built (Technical Design §11.7).

**CI/CD hardening**
- **SHA-pin the marketplace actions** in `ci.yml` + `deploy.yml` (also clears the recurring "Node.js 20 deprecated" annotation on every run).
- **Branch protection on `main`** / gate CD on CI — currently a direct push to `main` deploys even if CI would fail.
- Add a `permissions:` block to the deploy job.

**Container hardening**
- Non-root `USER` in `apps/api/Dockerfile`.
- **DB-resilient health:** make Prisma `$connect` non-fatal so `/api/health` + the container HEALTHCHECK don't depend on the DB (today the app won't boot if the DB is unreachable); make `/api/health/db` the readiness check (try/catch → 503).

**Plan 1 leftovers (non-blocking)**
- `login()` timing side-channel — add a dummy bcrypt compare on the user-not-found path (email enumeration via response time).
- Web logout handler has no `.catch` (unhandled rejection if the POST fails).
- No test for a route carrying both `@Public()` and `@Roles()` (latent footgun — such a route would be permanently 403).
- Opt into React Router v7 future flags to silence the `v7_*` warnings in web test output.

**Plan 2 leftovers (non-blocking)**
- Test coverage: `PATCH /clients/:id`, contact `PATCH`/`DELETE`, and `AppLayout` have no dedicated tests (verified by inspection only).
- **Multi-tenant:** the global uniques (`Client.companyName`, `Vessel.imoNumber`, `FreightDensityFactor.mode`, `ChecklistDefinition.itemKey`) will need to become composite `(tenantId, …)` when tenancy activates.

**Done (for the record)** — Neon password rotated ✅ · CD compose mismatch + `--force-recreate` (PR #3) ✅ · Plans 0–3 shipped + deployed ✅.

## Resume prompt for Plan 4
> "Read `Stage 3 - Create Query - Functional Spec.md`, `Stage 3 - Technical Design.md`, and `Stage 3 - Session Handoff.md`. Plans 0–3 (foundation, auth/RBAC, masters & reference data, Extensibility Core) are done, merged, and deployed. Let's do **Plan 4 — Query aggregate + Cargo**: the **Query root entity** (`queryCode` `YALYY-NNNN` minted on first persist via a row-locked `QuerySequence`; priority/response-deadline; **client-contact + vessel snapshots** so master edits never rewrite history; incoterms, shipment description, **`dgIndicator`** kept in sync (auto-true when any cargo is DG, manual override allowed); ready/target dates; internal notes; `assignedUserId`; system-only `status`), **Cargo rows** (atomic — one pickup/one delivery; reference tags; HS code; package type; **`isDangerous` + MSDS PDF upload**; qty/dims/weights; **`volumeCbm` as a Postgres generated column**; `freightDensity`/`chargeableWeight` **null/read-only in Stage 3**), the **completeness checklist** (`QueryChecklistItem` over the 9 seeded `ChecklistDefinition` items), and **`FileAsset`** (MSDS behind a storage service — local disk in dev). **Wire the now-built Extensibility Core:** persist `Query.status` via `QueryStatusProjector` (Draft → Created → RFQ Ready milestones; the leg-derived rollup lands with legs in Plan 5), route every Query/Cargo field edit through `ChangeMediator.apply(req, uow)` with a real unit-of-work (Free path only — Stage 3), and declare Query/Cargo impact classes via `ImpactRegistry.declare`. **Endpoints (Technical Design §5.2):** `POST /queries` (mints `queryCode`), `GET/PATCH /queries/:id` (PATCH runs the mediator per step), `POST /queries/:id/create` (field/cargo validation → status; **note the full route validation §10 R1–R9 + the leg-derived rollup are Plan 5**, since points/legs don't exist yet), cargo CRUD + `POST …/cargo/export` (xlsx, worksheet `Product`) + `POST …/cargo/:id/msds` (multipart PDF), `PATCH /queries/:id/checklist`. Per Technical Design §4.2 (Query/CargoItem/QueryChecklistItem/FileAsset), §4.4 (`YALYY-NNNN` minting), §4.5 (derived vs stored — `volumeCbm` generated column, `dgIndicator` synced), §5.2 (APIs), §8.4 (file storage), §8.6 (Excel export); functional spec §7.1–§7.3, §7.5, §9, §13. **Scope boundary:** Points/Legs/LegCargo + the route-validation engine + full route-gated Create Query are **Plan 5**; the wizard UI is **Plan 6**. Reuse the Plan 1–3 conventions (this handoff's 'Conventions & key learnings', incl. `@Body`-param-level Zod, the global `PrismaExceptionFilter`, read-env-at-call-time, and verifying against a fresh `migrate reset --skip-seed` DB before pushing). Write the Plan 4 implementation plan, then execute it subagent-driven on a fresh `feat/plan-4-query-cargo` branch."
