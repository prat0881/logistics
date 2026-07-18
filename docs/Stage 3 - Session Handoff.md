# Stage 3 — Session Handoff & Progress

> Resume point for a fresh session. Points to the deliverables and records what's done + what's next so nothing is re-litigated.

## Current status (2026-07-18)
- ✅ **Functional spec** — `Stage 3 - Create Query - Functional Spec.md` (behaviour; decisions D1–D12). *The what.*
- ✅ **Technical design** — `Stage 3 - Technical Design.md` (architecture, data model, APIs, extensibility core, deployment). *The how.*
- ✅ **Plan 0 (Foundation)** — merged + **deployed LIVE**. `docs/plans/stage-3/2026-07-16-plan-0-foundation.md`.
- ✅ **Plan 1 (Auth & RBAC)** — merged (PR #2) + deployed. JWT access token in an httpOnly cookie + rotating refresh (SHA-256-hashed in `RefreshToken`); global `JwtAuthGuard`+`RolesGuard` (Executive/Manager/Administrator); seeded users; login UI. `docs/plans/stage-3/2026-07-17-plan-1-auth.md`.
- ✅ **CD fix** — merged (PR #3). Repo `docker-compose.prod.yml` now matches the live `:4096` HTTP stack; deploy uses `up -d --force-recreate`.
- ✅ **Plan 2 (Masters & Reference Data)** — merged (PR #4/#6) + cleanup (PR #5) + deployed. Clients (+contacts API), Vessels, Config (density factors + checklist); masters/admin UI; idempotent reference-data seed; a global `PrismaExceptionFilter`. `docs/plans/stage-3/2026-07-17-plan-2-masters.md`.
- 🔜 **Next: Plan 3 — Extensibility Core** (Status Machine + Change-Impact mediator, per Technical Design §7).
- Live: `http://142.93.220.226:4096` — HTTP only, no domain/TLS yet.

## Read order for a fresh session
1. `Stage 3 - Create Query - Functional Spec.md` — the *what* (esp. §9 status model, §11 change model for Plan 3).
2. `Stage 3 - Technical Design.md` — the *how*. **For Plan 3, §7 Extensibility Core is the section you build**; also §9.1/§9.2 (status) and §11 (change-impact).
3. This file — current state, roadmap, conventions, open items.

## Roadmap (each plan = its own branch → PR)
Plan 0 Foundation ✅ · Plan 1 Auth & RBAC ✅ · Plan 2 Masters & Reference Data ✅ · **Plan 3 Extensibility Core (next)** · Plan 4 Query + Cargo · Plan 5 Points/Legs/Route Engine · Plan 6 Wizard & Query List UI · Plan 7 Notifications/Escalations/Emails · Plan 8 Completion & hardening.

## What's built so far (the foundation Plan 3+ extends)
- **Monorepo** (Plan 0): `apps/api` (NestJS + Prisma), `apps/web` (Vite/React/Tailwind/shadcn/TanStack Query), `packages/shared` (isomorphic zod schemas + types + enums). Docker + GitHub Actions CI/CD.
- **Auth/RBAC** (Plan 1): global secure-by-default guards + decorators in `apps/api/src/modules/auth/` — `@Roles(...Role[])`, `@Public()`, `@CurrentUser()`; `JwtStrategy` (cookie); `AuthService` (login/refresh/logout/me). `Role` enum + auth contracts in `@svyft/shared`.
- **Masters** (Plan 2): `clients`/`vessels`/`config` modules; reusable `ZodValidationPipe` (`apps/api/src/common/zod-validation.pipe.ts`); **global `PrismaExceptionFilter`** (`apps/api/src/common/prisma-exception.filter.ts`, registered in `main.ts`) mapping P2023→400, P2025→404, P2002→409, validation→400; `CodeSequence`-based `CL-`/`VS-` minting (inline `tx.codeSequence.upsert` in the create transaction); web↔`@svyft/shared` wiring (React Hook Form + `zodResolver`).
- **Prisma models:** `User`, `RefreshToken`, `Client`, `ClientContact`, `Vessel`, `FreightDensityFactor`, `ChecklistDefinition`, `CodeSequence`. **Migrations:** `init_auth`, `masters_config`. Every table has a nullable `tenantId` (tenant-ready). `StatusTransition` and the leg/query/status enums are **not built yet** — that's Plan 3.

## Stack
pnpm monorepo · NestJS 10 + Prisma 5 (Neon Postgres) · Vite + React 18 + Tailwind + shadcn/ui + TanStack Query + React Hook Form · Docker + GitHub Actions CI/CD. Repo: `github.com/sj132q/svyft-logistics`. Local dev: `README.md` (Docker Postgres + `pnpm dev`; `DEV_DB_PORT` override; after install run `prisma migrate deploy` + `prisma db seed`).

## Deployment facts
- Droplet `142.93.220.226` (Bangalore), Docker, **shared** with another app (on `:5173`). Our app: HTTP on **`:4096`** (no domain/TLS yet).
- Neon Postgres (Singapore `ap-southeast-1`); pooled+direct URLs + `JWT_ACCESS_SECRET` + `SEED_*` + `COOKIE_SECURE=false` live in droplet `/opt/svyft-logistics/.env` (NOT in the repo).
- **Prod compose = `docker-compose.prod.yml`** (HTTP `:4096`, no Caddy); the Caddy/HTTPS variant is `docker-compose.caddy.yml` (for when a domain lands). Keep the droplet's copy in sync with the repo.
- **CD:** pushing runtime code (`apps/**`, `packages/**`, `prisma/**`, `pnpm-lock.yaml`) to `main` → build image → GHCR → SSH deploy (`prisma migrate deploy` + `compose up -d --force-recreate`). Docs/config pushes do **not** deploy (path-filtered); use the Deploy workflow's **Run workflow** for manual redeploys.
- **After a fresh deploy, run the seed once** (deploy applies migrations but not the seed): `docker compose -f docker-compose.prod.yml run --rm api node /repo/apps/api/dist/seed/seed.js` — seeds users + reference data (density/checklist/code-sequences), idempotent. (Code minting is upsert-resilient, so client/vessel creates won't 500 if you forget, but the reference data needs it.)
- Secrets set: `DROPLET_HOST`, `DROPLET_USER`, `DROPLET_SSH_KEY`, `GHCR_TOKEN`.

## Conventions & key learnings (reuse in Plan 3)
- **Flow:** brainstorm → write plan (`superpowers:writing-plans`) → subagent-driven execution (`superpowers:subagent-driven-development`, fresh implementer per task, TDD, spec+quality review per task, opus whole-branch review at the end) → finish via PR. New branch per plan (`feat/plan-N-<name>` off `main`); plan doc + implementation ship as one PR. Ledger: `.superpowers/sdd/progress.md` (gitignored scratch — start fresh each plan).
- **Models:** sonnet for implementers + task reviewers; **opus** for the final whole-branch review.
- **Validation:** bind Zod at **param level** — `@Body(new ZodValidationPipe(schema))` — NOT method-level `@UsePipes` (Nest applies a method-level pipe to `@Param()` too → validates the id against the body schema → wrong 400).
- **Prisma errors:** the global `PrismaExceptionFilter` maps them to 400/404/409 — don't hand-roll per-service 500s. Services throw specific `HttpException`s (e.g. `ConflictException`) which run before the filter; the filter is the backstop.
- **Env timing:** read env at DI/call time, not in a module top-level `const` (`ConfigModule` loads `.env` at init) — use `registerAsync`/a factory or read inside the method.
- **CI gotcha:** CI runs a **fresh migrated-but-UNSEEDED** Postgres. Tests that reset sequences or depend on accumulated/seeded state pass locally (accumulated dev DB) but fail on CI — verify against `prisma migrate reset --schema prisma/schema.prisma --force --skip-seed` before pushing. Then watch the PR's CI (`gh run watch`).
- **Shared enums:** `const` object + `(typeof X)[keyof typeof X]` string-union, values matching the Prisma enum exactly (see `packages/shared/src/role.ts`).

## Open items / follow-ups (none block Plan 3 — schedule alongside)
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

**Done (for the record)** — Neon password rotated ✅ · CD compose mismatch + `--force-recreate` (PR #3) ✅ · Plans 0–2 shipped + deployed ✅.

## Resume prompt for Plan 3
> "Read `Stage 3 - Create Query - Functional Spec.md`, `Stage 3 - Technical Design.md`, and `Stage 3 - Session Handoff.md`. Plans 0–2 (foundation, auth/RBAC, masters & reference data) are done, merged, and deployed. Let's do **Plan 3 — Extensibility Core**: the **Status Machine** (owned/transitioned status via a declarative transition registry + `StatusService.fire` with guards/effects/`StatusTransition` log + in-process domain events; derived/rollup status as a projection) and the **Change-Impact mediator** (impact classification via a per-entity `ImpactRegistry`, the Free-path / Change-order fork, and the `reopen` seam), per Technical Design §7 (and functional spec §9 status model + §11 change model). Build it as the reusable **framework** future stages plug into — generic transition/impact types in `@svyft/shared`, the services + `StatusTransition` model in `apps/api` — with the Stage-3 slice declared/wired to whatever extent is possible before the leg/query entities exist (legs land in Plan 5): leg `DRAFT ↔ READY_FOR_RFQ`, query status derived, **Free path only**, and the **ChangeOrder strategy as a stub that can never fire** (scope resolver always returns 'no downstream work'). Reuse the Plan 1/2 conventions (see the handoff's 'Conventions & key learnings'). Write the Plan 3 implementation plan, then execute it subagent-driven on a fresh `feat/plan-3-extensibility` branch."
