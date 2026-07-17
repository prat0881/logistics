# Stage 3 — Session Handoff & Progress

> Resume point for a fresh session. Points to the deliverables and records what's done + what's next so nothing is re-litigated.

## Current status (2026-07-17)
- ✅ **Functional spec** — complete & agreed: `Stage 3 - Create Query - Functional Spec.md` (behaviour; 12 decisions D1–D12). *The what.*
- ✅ **Technical design** — complete & committed: `Stage 3 - Technical Design.md` (architecture, data model, APIs, extensibility core, deployment). *The how.*
- ✅ **Plan 0 (Foundation)** — built, reviewed, merged to `main`, and **deployed LIVE**.
  - Plan doc: `docs/plans/stage-3/2026-07-16-plan-0-foundation.md` · Cutover: `docs/plans/stage-3/plan-0-cutover-runbook.md`
  - Live: `http://142.93.220.226:4096` (`/api/health`, `/api/health/db`, SPA). HTTP only, no domain/TLS yet.
- 🔜 **Next: Plan 1 — Auth & RBAC.**

## Read order for a fresh session
1. `Stage 3 - Create Query - Functional Spec.md` — the *what*.
2. `Stage 3 - Technical Design.md` — the *how* (esp. §7 Extensibility Core, §4 Data model, §8.1 Auth & RBAC).
3. This file — current state, roadmap, conventions.

## Roadmap (each plan = its own branch → PR)
Plan 0 Foundation ✅ · **Plan 1 Auth & RBAC (next)** · Plan 2 Masters & Reference Data · Plan 3 Extensibility Core · Plan 4 Query + Cargo · Plan 5 Points/Legs/Route Engine · Plan 6 Wizard & Query List UI · Plan 7 Notifications/Escalations/Emails · Plan 8 Completion & hardening.

## Stack (built in Plan 0)
pnpm monorepo · NestJS + Prisma (Neon Postgres) · Vite + React + Tailwind + shadcn/ui + TanStack Query · Docker + GitHub Actions CI/CD. Repo: `github.com/sj132q/svyft-logistics`. Local dev: see `README.md` (Docker Postgres + `pnpm dev`; `DEV_DB_PORT` override).

## Deployment facts
- Droplet `142.93.220.226` (Bangalore), Docker, **shared** with another app (on `:5173`). Our app: HTTP on **`:4096`** (no domain/TLS yet).
- Neon Postgres (Singapore `ap-southeast-1`); pooled+direct URLs live in droplet `/opt/svyft-logistics/.env` (NOT in the repo). The droplet uses an **HTTP-on-4096 compose variant**, not the repo's Caddy version.
- **CD:** pushing **runtime code** (`apps/**`, `packages/**`, `prisma/**`, `pnpm-lock.yaml`) to `main` → Actions builds image → GHCR → SSH deploy (`prisma migrate deploy` + `compose up`). Docs/config pushes do **not** deploy (path-filtered); redeploy manually via the Deploy workflow's **Run workflow** (`workflow_dispatch`).
- Secrets set: `DROPLET_HOST`, `DROPLET_USER`, `DROPLET_SSH_KEY`, `GHCR_TOKEN`.

## Pending (before "proper" production — not blocking Plan 1)
- **HTTPS** (needs a domain → switch to the repo's Caddy `docker-compose.prod.yml`).
- **Hardening:** non-root container `USER`; **DB-resilient health** (make Prisma `$connect` non-fatal so `/api/health` + the container HEALTHCHECK don't depend on the DB — currently the app won't boot if the DB is unreachable); SHA-pin marketplace actions; `permissions:` block on the deploy job; branch protection on `main`.

## Conventions
- **Brainstorm → write plan → subagent-driven execution** (fresh implementer per task, TDD, spec+quality review per task, whole-branch review on completion, then finish via PR). Skills: `superpowers:writing-plans`, `superpowers:subagent-driven-development`.
- **New branch per plan** (`feat/plan-N-<name>` off `main`); the plan doc *and* implementation live on that branch → one PR.
- Execution progress ledger: `.superpowers/sdd/progress.md` (gitignored scratch).

## Resume prompt for Plan 1
> "Read `Stage 3 - Create Query - Functional Spec.md`, `Stage 3 - Technical Design.md`, and `Stage 3 - Session Handoff.md`. Plan 0 (foundation) is done and deployed. Let's do **Plan 1 — Auth & RBAC**: users, real login with JWT-in-httpOnly-cookie + refresh token (hashed in a `RefreshToken` table), a roles guard for Executive / Manager / Administrator, and a seeded admin user — per Technical Design §8.1 and the data model §4.2. Write the Plan 1 implementation plan, then execute it subagent-driven on a fresh `feat/plan-1-auth` branch."
