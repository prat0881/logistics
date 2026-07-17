# Svyft Logistics

Monorepo: `apps/api` (NestJS), `apps/web` (React/Vite), `packages/shared`.

## Local development

```bash
docker compose -f docker-compose.dev.yml up -d      # Postgres on :5432 (see DEV_DB_PORT below)
cp apps/api/.env.example apps/api/.env              # then uncomment the local URLs
pnpm install
pnpm exec prisma generate --schema prisma/schema.prisma --allow-no-models
pnpm dev                                            # shared(watch) + api(:4000) + web(:5173)
```

- API: http://localhost:4000/api/health  ·  http://localhost:4000/api/health/db
- Web: http://localhost:5173 (proxies `/api` → :4000)

### `DEV_DB_PORT` (shared machines)

`docker-compose.dev.yml` maps the container's Postgres port to `${DEV_DB_PORT:-5432}` on the
host — it defaults to `5432` for normal dev machines, but can be overridden when `5432` is
already bound by something else (e.g. another project's Postgres container on a shared box):

```bash
DEV_DB_PORT=5433 docker compose -f docker-compose.dev.yml up -d
```

If you override the port, point `apps/api/.env`'s `DATABASE_URL` / `DIRECT_URL` at the same
port (e.g. `localhost:5433` instead of `localhost:5432`).

## Verify

```bash
pnpm run ci    # lint + typecheck + test + build
```
