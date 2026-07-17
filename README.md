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
pnpm exec prisma db seed                            # seed admin/manager/executive (idempotent)
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

## Verify

```bash
pnpm run ci    # lint + typecheck + test + build
```
