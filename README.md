# Svyft Logistics

Monorepo: `apps/api` (NestJS), `apps/web` (React/Vite), `packages/shared`.

## Local development

```bash
docker compose -f docker-compose.dev.yml up -d      # Postgres on :5432 (override DEV_DB_PORT if taken)
cp apps/api/.env.example apps/api/.env              # then uncomment the local URLs + set JWT_ACCESS_SECRET
pnpm install
pnpm --filter @svyft/shared build
set -a; . apps/api/.env; set +a                     # export DB + auth env for the CLI
pnpm exec prisma migrate deploy --schema prisma/schema.prisma   # apply migrations
pnpm exec prisma db seed                            # seed users + reference data (idempotent)
pnpm dev                                            # shared(watch) + api(:4000) + web(:5173)
```

- API: http://localhost:4000/api/health  ·  http://localhost:4000/api/health/db
- Web: http://localhost:5173 → redirects to `/login`; sign in with a seeded account (default `admin@svyft.local` / `admin-dev-password`).

### `DEV_DB_PORT` (shared machines)

`docker-compose.dev.yml` maps the container's Postgres port to `${DEV_DB_PORT:-5432}` on the
host — it defaults to `5432` for normal dev machines, but can be overridden when `5432` is
already bound by something else (e.g. another project's Postgres container on a shared box):

```bash
DEV_DB_PORT=5433 docker compose -f docker-compose.dev.yml up -d
```

If you override the port, point `apps/api/.env`'s `DATABASE_URL` / `DIRECT_URL` at the same
port (e.g. `localhost:5433` instead of `localhost:5432`).

## Auth

Real login: access-token JWT in an httpOnly cookie (15 min) + a rotating refresh token (7 days, SHA-256-hashed in `RefreshToken`). Roles: Executive / Manager / Administrator, enforced by global guards (`@Public()` opts out). Endpoints: `POST /api/auth/login` · `/refresh` · `/logout` · `GET /api/auth/me`. Seed accounts and `JWT_ACCESS_SECRET` come from env (see `apps/api/.env.example`). `COOKIE_SECURE` must be `false` on plain HTTP and `true` only under HTTPS.

## Masters

Client and Vessel masters (search/create/edit) live under `/masters/*` — Administrator/Manager can
write, every authenticated role can read. Codes are auto-minted (`CL-####` / `VS-####`). Client
contacts are managed via the API only (`/api/clients/:id/contacts`) — no UI yet. Reference data
(freight density factors, checklist definitions) lives at `/admin/config`: any authenticated role
can read it via the API, but only an Administrator can edit it (the `/admin/config` page is
Admin-only). `pnpm exec prisma db seed` now seeds the reference data alongside the users — density
factors (ROAD/AIR/SEA), the 9 checklist items, and the `CLIENT`/`VESSEL` code sequences —
idempotently.

## Extensibility Core

The framework future stages plug into (Technical Design §7). **Status Machine:** owned
statuses move only through `StatusService.fire` (guarded, declarative transitions in a
registry), which appends an operational `StatusTransition` log and emits in-process
`${key}.status.changed` events; derived query status is a pure projection
(`deriveQueryStatus`). **Change-Impact mediator:** every mutation flows through
`ChangeMediator.apply`, which classifies impact and forks Free-path (built) vs
Change-order (a stub that can never fire in Stage 3 — no downstream work exists). Generic
types live in `@svyft/shared`; the services + `StatusTransition` model live in `apps/api`.
Stage-3 slice: leg `DRAFT ↔ READY_FOR_RFQ`, query status derived, Free path only.

## Verify

```bash
pnpm run ci    # lint + typecheck + test + build
```
