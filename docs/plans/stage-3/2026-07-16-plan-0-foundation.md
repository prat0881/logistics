# Stage 3 — Plan 0: Foundation (Walking Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pnpm monorepo (NestJS API + React web + shared package) with Neon/Postgres connectivity, a health endpoint proven end-to-end, and the Docker + Caddy + GitHub Actions deploy pipeline — a deployable walking skeleton before any feature work.

**Architecture:** Modular-monolith monorepo (pnpm workspaces). One NestJS app serves `/api` and (in production) the built React SPA; an isomorphic `@svyft/shared` package holds types/validation reused by both apps. Postgres via Prisma on Neon (pooled runtime URL + direct migration URL). Deploy: GitHub → GHCR image → DigitalOcean droplet behind a containerized Caddy edge; CI builds/tests, CD builds the image and SSH-deploys.

**Tech Stack:** Node 20 · pnpm 9 · TypeScript 5.6 · NestJS 10 (+ Jest/supertest) · Prisma 5 · PostgreSQL (Neon) · Vite 5 + React 18 + Tailwind 3 + shadcn/ui + TanStack Query · Vitest + Testing Library · Docker + Caddy · GitHub Actions.

## Global Constraints

- Node `>=20 <21`; pnpm `9.x`; TypeScript `^5.6`. All new code TypeScript, `strict` on.
- Package manager is pnpm workspaces; shared package name `@svyft/shared`, api `@svyft/api`, web `@svyft/web`.
- API global route prefix is `/api`; API listens on `PORT` (default `4000`).
- Web dev server proxies `/api` → `http://localhost:4000`.
- Secrets are never committed: `.env` is gitignored; `.env.example` documents keys.
- Prisma datasource: `url = env("DATABASE_URL")` (pooled), `directUrl = env("DIRECT_URL")` (direct) — per Technical Design §11.5.
- Commit messages follow Conventional Commits.
- Repo remote: `origin` = `https://github.com/sj132q/svyft-logistics` (already created; baseline pushed).

---

### Task 1: Monorepo scaffold & tooling

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `.npmrc`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.editorconfig`

**Interfaces:**
- Produces: root scripts `lint` / `typecheck` / `test` / `build` / `ci` / `dev` used by every later task and by CI. `tsconfig.base.json` is extended by every package.

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "svyft-logistics",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20 <21" },
  "scripts": {
    "dev": "pnpm --filter @svyft/shared build && pnpm -r --parallel run dev",
    "lint": "pnpm -r run lint",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test",
    "build": "pnpm -r run build",
    "ci": "pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build"
  },
  "devDependencies": {
    "@eslint/js": "^9.12.0",
    "eslint": "^9.12.0",
    "prettier": "^3.3.3",
    "prisma": "^5.20.0",
    "typescript": "^5.6.2",
    "typescript-eslint": "^8.8.0"
  }
}
```

- [ ] **Step 3: Create `.npmrc`**

```
auto-install-peers=true
strict-peer-dependencies=false
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "CommonJS",
    "moduleResolution": "Node",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 5: Create `eslint.config.js`**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "**/.vite/**", "**/coverage/**"] },
);
```

- [ ] **Step 6: Create `.prettierrc` and `.editorconfig`**

`.prettierrc`:
```json
{ "singleQuote": false, "semi": true, "trailingComma": "all", "printWidth": 100 }
```
`.editorconfig`:
```ini
root = true
[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

- [ ] **Step 7: Install and smoke-check**

Run: `pnpm install`
Expected: resolves, writes `pnpm-lock.yaml`, exit 0.
Run: `pnpm -r run lint`
Expected: "No projects matched the filters" (no workspace packages yet) — exit 0.
(`"type": "module"` on the root package.json keeps the ESM `eslint.config.js` loading without a `MODULE_TYPELESS_PACKAGE_JSON` warning on Node 20.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo and shared tooling"
```

---

### Task 2: `@svyft/shared` — Finding type + formatQueryCode (TDD)

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.mts`
- Create: `packages/shared/src/findings.ts`, `packages/shared/src/query-code.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/query-code.test.ts`

**Interfaces:**
- Produces: `formatQueryCode(year: number, seq: number): string` → `"YAL26-0042"`.
- Produces: `type Finding = { rule: string; severity: "blocking" | "warning"; scope: { type: "query"|"leg"|"cargo"|"point"|"field"; id?: string }; message: string }`. These are consumed by the route engine (Plan 5) and the API error envelope (Plan 4+).

- [ ] **Step 1: Create package files**

`packages/shared/package.json`:
```json
{
  "name": "@svyft/shared",
  "version": "0.0.0",
  "private": true,
  "type": "commonjs",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch --preserveWatchOutput",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "devDependencies": {
    "typescript": "^5.6.2",
    "vitest": "^2.1.2"
  }
}
```
`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "dist"]
}
```
`packages/shared/vitest.config.mts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
```

- [ ] **Step 2: Install the new package**

Run: `pnpm install`
Expected: links `@svyft/shared`, installs vitest, exit 0.

- [ ] **Step 3: Write the failing test**

`packages/shared/src/query-code.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { formatQueryCode } from "./query-code";

describe("formatQueryCode", () => {
  it("formats year + zero-padded 4-digit sequence", () => {
    expect(formatQueryCode(2026, 42)).toBe("YAL26-0042");
  });
  it("uses the last two digits of the year", () => {
    expect(formatQueryCode(2030, 1)).toBe("YAL30-0001");
  });
  it("does not truncate sequences beyond 4 digits", () => {
    expect(formatQueryCode(2026, 12345)).toBe("YAL26-12345");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared test`
Expected: FAIL — cannot resolve `./query-code`.

- [ ] **Step 5: Implement `query-code.ts`**

`packages/shared/src/query-code.ts`:
```ts
export function formatQueryCode(year: number, seq: number): string {
  const yy = String(year % 100).padStart(2, "0");
  const nnnn = String(seq).padStart(4, "0");
  return `YAL${yy}-${nnnn}`;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @svyft/shared test`
Expected: PASS (3 tests).

- [ ] **Step 7: Add `findings.ts` and the barrel**

`packages/shared/src/findings.ts`:
```ts
export type Severity = "blocking" | "warning";

export interface FindingScope {
  type: "query" | "leg" | "cargo" | "point" | "field";
  id?: string;
}

export interface Finding {
  rule: string;
  severity: Severity;
  scope: FindingScope;
  message: string;
}
```
`packages/shared/src/index.ts`:
```ts
export * from "./findings";
export * from "./query-code";
```

- [ ] **Step 8: Build and verify output**

Run: `pnpm --filter @svyft/shared build`
Expected: creates `packages/shared/dist/index.js` and `index.d.ts`, exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(shared): add Finding type and formatQueryCode util"
```

---

### Task 3: `apps/api` NestJS app + `GET /api/health` (TDD e2e)

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/modules/health/health.module.ts`, `apps/api/src/modules/health/health.controller.ts`
- Test: `apps/api/test/health.e2e-spec.ts`, `apps/api/test/jest-e2e.json`

**Interfaces:**
- Produces: HTTP `GET /api/health` → `200 { status: "ok" }`. Bootstrap sets global prefix `api`, listens on `PORT` (default 4000). `AppModule` is the composition root later tasks add modules to.

- [ ] **Step 1: Create package + config files**

`apps/api/package.json`:
```json
{
  "name": "@svyft/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "start:prod": "node dist/main.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest --config test/jest-e2e.json --runInBand",
    "lint": "eslint src test"
  },
  "dependencies": {
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "@svyft/shared": "workspace:*",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.5",
    "@nestjs/schematics": "^10.1.4",
    "@nestjs/testing": "^10.4.0",
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.13",
    "@types/node": "^20.16.0",
    "@types/supertest": "^6.0.2",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.5",
    "typescript": "^5.6.2"
  }
}
```
`apps/api/nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true }
}
```
`apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "target": "ES2022",
    "outDir": "dist",
    "baseUrl": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```
`apps/api/tsconfig.build.json` (excludes tests so `nest build` emits a flat `dist/main.js`, not `dist/src/main.js`):
```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```
`apps/api/test/jest-e2e.json`:
```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  "moduleNameMapper": { "^@svyft/shared$": "<rootDir>/../../../packages/shared/src/index.ts" }
}
```

- [ ] **Step 2: Create the app skeleton (boots, no health route yet)**

`apps/api/src/main.ts`:
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.PORT ?? 4000));
}
void bootstrap();
```
`apps/api/src/app.module.ts`:
```ts
import { Module } from "@nestjs/common";

@Module({})
export class AppModule {}
```

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: installs Nest + jest deps, exit 0.

- [ ] **Step 4: Write the failing test**

`apps/api/test/health.e2e-spec.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it("GET /api/health → 200 { status: 'ok' }", async () => {
    const res = await request(app.getHttpServer()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 6: Implement the health module**

`apps/api/src/modules/health/health.controller.ts`:
```ts
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }
}
```
`apps/api/src/modules/health/health.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

@Module({ controllers: [HealthController] })
export class HealthModule {}
```
Update `apps/api/src/app.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module";

@Module({ imports: [HealthModule] })
export class AppModule {}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @svyft/api test`
Expected: PASS.

- [ ] **Step 8: Build and commit**

Run: `pnpm --filter @svyft/api build` → expect `dist/main.js`, exit 0.
```bash
git add -A
git commit -m "feat(api): bootstrap NestJS app with /api/health endpoint"
```

---

### Task 4: Prisma + Neon wiring + `GET /api/health/db` (TDD integration)

**Files:**
- Create: `prisma/schema.prisma`
- Create: `apps/api/src/prisma/prisma.service.ts`, `apps/api/src/prisma/prisma.module.ts`
- Create: `apps/api/.env.example`, `docker-compose.dev.yml`
- Modify: `apps/api/package.json` (add `@prisma/client`), `apps/api/src/app.module.ts`, `apps/api/src/modules/health/health.controller.ts`
- Test: `apps/api/test/health-db.e2e-spec.ts`

**Interfaces:**
- Produces: `PrismaService` (injectable `PrismaClient` with connect/disconnect lifecycle), exported by a `@Global()` `PrismaModule`; consumed by every data module in later plans.
- Produces: HTTP `GET /api/health/db` → `200 { status: "ok", db: "ok" }` when Postgres is reachable.

> **Note:** No Prisma models yet — connectivity is proven with a raw `SELECT 1`. The first migration (User model) lands in Plan 1. Because the schema has zero models, `prisma generate` needs `--allow-no-models` (a permissive flag, safe to keep after models exist). `@prisma/client` is added to BOTH the root `package.json` (so `prisma generate` run from the repo root resolves it) and `apps/api`. Prisma Client does NOT auto-load `apps/api/.env` at runtime, so `DATABASE_URL`/`DIRECT_URL` must be present in the process environment when the app or e2e tests run — CI sets them as job env; local dev gets proper `.env` loading via `@nestjs/config` in Task 6.

- [ ] **Step 1: Add Prisma deps**

Edit `apps/api/package.json` → add to `dependencies`: `"@prisma/client": "^5.20.0"`. (`prisma` CLI is already a root devDependency.)
Run: `pnpm install`

- [ ] **Step 2: Create `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

- [ ] **Step 3: Create `apps/api/.env.example` and local dev DB**

`apps/api/.env.example`:
```
# Neon pooled connection (runtime)
DATABASE_URL="postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DB?sslmode=require"
# Neon direct connection (migrations)
DIRECT_URL="postgresql://USER:PASSWORD@HOST.REGION.aws.neon.tech/DB?sslmode=require"
PORT=4000

# --- Local dev alternative (docker-compose.dev.yml) ---
# DATABASE_URL="postgresql://svyft:svyft@localhost:5432/svyft?schema=public"
# DIRECT_URL="postgresql://svyft:svyft@localhost:5432/svyft?schema=public"
```
`docker-compose.dev.yml` (repo root):
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: svyft
      POSTGRES_PASSWORD: svyft
      POSTGRES_DB: svyft
    ports: ["5432:5432"]
    volumes: ["svyft_pgdata:/var/lib/postgresql/data"]
volumes:
  svyft_pgdata:
```

- [ ] **Step 4: Start Postgres, create local `.env`, generate client**

Run: `docker compose -f docker-compose.dev.yml up -d`
Create `apps/api/.env` with the two local URLs from `.env.example` (uncommented) + `PORT=4000`.
Run: `pnpm exec prisma generate --schema prisma/schema.prisma --allow-no-models`
Expected: "Generated Prisma Client", exit 0.

- [ ] **Step 5: Write the failing test**

`apps/api/test/health-db.e2e-spec.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Health DB (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it("GET /api/health/db → 200 { db: 'ok' } when Postgres reachable", async () => {
    const res = await request(app.getHttpServer()).get("/api/health/db");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("ok");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test -- test/health-db.e2e-spec.ts`
Expected: FAIL — 404 (`/db` route not implemented).

- [ ] **Step 7: Implement PrismaService + module and the `/db` route**

`apps/api/src/prisma/prisma.service.ts`:
```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> { await this.$connect(); }
  async onModuleDestroy(): Promise<void> { await this.$disconnect(); }
}
```
`apps/api/src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```
Update `apps/api/src/modules/health/health.controller.ts`:
```ts
import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }

  @Get("db")
  async checkDb(): Promise<{ status: string; db: string }> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", db: "ok" };
  }
}
```
Update `apps/api/src/app.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./modules/health/health.module";

@Module({ imports: [PrismaModule, HealthModule] })
export class AppModule {}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @svyft/api test`
Expected: PASS (health + health-db).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): add Prisma/Neon wiring and /api/health/db connectivity check"
```

---

### Task 5: `apps/web` Vite + React + Tailwind + shadcn + HealthStatus (TDD component)

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/index.html`, `apps/web/tailwind.config.ts`, `apps/web/postcss.config.js`, `apps/web/components.json`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/index.css`, `apps/web/src/test/setup.ts`
- Create: `apps/web/src/lib/utils.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/components/ui/badge.tsx`, `apps/web/src/features/health/HealthStatus.tsx`
- Test: `apps/web/src/features/health/HealthStatus.test.tsx`

**Interfaces:**
- Produces: `HealthStatus` React component that renders API + DB status from `/api/health` and `/api/health/db`. `cn(...)` util and `queryClient` are consumed by all later web features.

> **Post-review fix (commit `9326396`):** the shipped `HealthStatus` distinguishes the *loading* state (a neutral `pending` badge, `checking…`) from *error* (red) — the brief's original `variant={... ? "success" : "destructive"}` rendered red during loading, misreading as "down". `badge.tsx` gains a `pending` variant; the test covers the loading state and adds `afterEach(vi.unstubAllGlobals())`. The committed files are the source of truth for this component.

- [ ] **Step 1: Create package + build config**

`apps/web/package.json`:
```json
{
  "name": "@svyft/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "lucide-react": "^0.451.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tailwind-merge": "^2.5.3"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.10",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.2",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.1",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "typescript": "^5.6.2",
    "vite": "^5.4.8",
    "vitest": "^2.1.2"
  }
}
```
`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "noEmit": true,
    "declaration": false
  },
  "include": ["src"]
}
```
`apps/web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: { port: 5173, proxy: { "/api": "http://localhost:4000" } },
});
```
`apps/web/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "jsdom", globals: true, setupFiles: ["src/test/setup.ts"] },
});
```

- [ ] **Step 2: Create Tailwind + shadcn base files**

`apps/web/tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```
`apps/web/postcss.config.js`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```
`apps/web/components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "tailwind.config.ts", "css": "src/index.css", "baseColor": "slate", "cssVariables": true },
  "aliases": { "components": "@/components", "utils": "@/lib/utils" }
}
```
`apps/web/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```
`apps/web/src/lib/utils.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```
`apps/web/src/components/ui/badge.tsx`:
```tsx
import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold",
  {
    variants: {
      variant: {
        default: "border-transparent bg-slate-900 text-slate-50",
        success: "border-transparent bg-green-600 text-white",
        destructive: "border-transparent bg-red-600 text-white",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
```

- [ ] **Step 3: Create app entry + api client + test setup**

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Svyft Logistics</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
`apps/web/src/lib/api.ts`:
```ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient();

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}
```
`apps/web/src/test/setup.ts`:
```ts
import "@testing-library/jest-dom";
```
`apps/web/src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/api";
import { App } from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
```
`apps/web/src/App.tsx`:
```tsx
import { HealthStatus } from "@/features/health/HealthStatus";

export function App() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <HealthStatus />
    </main>
  );
}
```

- [ ] **Step 4: Install**

Run: `pnpm install`
Expected: installs React/Vite/Vitest toolchain, exit 0.

- [ ] **Step 5: Write the failing test**

`apps/web/src/features/health/HealthStatus.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HealthStatus } from "./HealthStatus";

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HealthStatus />
    </QueryClientProvider>,
  );
}

describe("HealthStatus", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const body = url.endsWith("/db") ? { status: "ok", db: "ok" } : { status: "ok" };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
      }),
    );
  });

  it("shows API and DB as ok", async () => {
    renderWithClient();
    const okBadges = await screen.findAllByText("ok");
    expect(okBadges).toHaveLength(2);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test`
Expected: FAIL — cannot resolve `./HealthStatus`.

- [ ] **Step 7: Implement `HealthStatus.tsx`**

`apps/web/src/features/health/HealthStatus.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { fetchJson } from "@/lib/api";

export function HealthStatus() {
  const api = useQuery({
    queryKey: ["health"],
    queryFn: () => fetchJson<{ status: string }>("/api/health"),
  });
  const db = useQuery({
    queryKey: ["health-db"],
    queryFn: () => fetchJson<{ db: string }>("/api/health/db"),
  });

  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">Svyft Logistics</h1>
      <div className="flex items-center gap-2">
        <span>API:</span>
        <Badge variant={api.data?.status === "ok" ? "success" : "destructive"}>
          {api.isLoading ? "…" : (api.data?.status ?? "error")}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <span>DB:</span>
        <Badge variant={db.data?.db === "ok" ? "success" : "destructive"}>
          {db.isLoading ? "…" : (db.data?.db ?? "error")}
        </Badge>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test`
Expected: PASS.

- [ ] **Step 9: Build and commit**

Run: `pnpm --filter @svyft/web build` → expect `apps/web/dist/`, exit 0.
```bash
git add -A
git commit -m "feat(web): scaffold Vite/React/Tailwind/shadcn app with HealthStatus"
```

---

### Task 6: Local dev orchestration & README

**Files:**
- Create: `README.md`
- (Root `dev` script + `docker-compose.dev.yml` already exist from Tasks 1 & 4.)

**Interfaces:**
- Produces: a documented one-command local loop (`pnpm dev`) proving web → `/api` proxy → DB end-to-end.

**Carry-forward requirements from Task 4 (implement in this task):**
1. **Env loading:** add `@nestjs/config` and wire `ConfigModule.forRoot({ isGlobal: true })` into `apps/api` `AppModule` so `DATABASE_URL`/`DIRECT_URL` load from `apps/api/.env` (the default lookup is cwd, which is `apps/api` for both `nest start` and `pnpm --filter @svyft/api test`). Acceptance: `pnpm --filter @svyft/api test` passes with only `apps/api/.env` present — no inline env vars.
2. **Dev DB port:** parameterize the host port in `docker-compose.dev.yml` as `"${DEV_DB_PORT:-5432}:5432"` and document `DEV_DB_PORT` in the README, so local Postgres doesn't collide with a `5432` already bound on a shared machine.
3. Any `prisma generate` shown in the README already carries `--allow-no-models` (Plan 0 has no models yet).

- [ ] **Step 1: Create `README.md`**

````markdown
# Svyft Logistics

Monorepo: `apps/api` (NestJS), `apps/web` (React/Vite), `packages/shared`.

## Local development

```bash
docker compose -f docker-compose.dev.yml up -d      # Postgres on :5432
cp apps/api/.env.example apps/api/.env              # then uncomment the local URLs
pnpm install
pnpm exec prisma generate --schema prisma/schema.prisma --allow-no-models
pnpm dev                                            # shared(watch) + api(:4000) + web(:5173)
```

- API: http://localhost:4000/api/health  ·  http://localhost:4000/api/health/db
- Web: http://localhost:5173 (proxies `/api` → :4000)

## Verify

```bash
pnpm run ci    # lint + typecheck + test + build
```
````

- [ ] **Step 2: Run the full local loop**

Run: `docker compose -f docker-compose.dev.yml up -d` then `pnpm dev`
In another shell:
Run: `curl -s http://localhost:4000/api/health` → Expected: `{"status":"ok"}`
Run: `curl -s http://localhost:4000/api/health/db` → Expected: `{"status":"ok","db":"ok"}`
Open http://localhost:5173 → Expected: two green `ok` badges (API + DB).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: add README with local development loop"
```

---

### Task 7: Production image + prod compose + Caddyfile

**Files:**
- Create: `apps/api/Dockerfile`, `.dockerignore`, `docker-compose.prod.yml`, `Caddyfile`
- Modify: `apps/api/package.json` (add `@nestjs/serve-static`), `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: a runnable image where NestJS serves `/api` **and** the built SPA (SPA when `SERVE_STATIC=true`). Consumed by the CD workflow (Task 9) and the cutover (Task 10).

- [ ] **Step 1: Add static-serving dependency**

Edit `apps/api/package.json` → add to `dependencies`: `"@nestjs/serve-static": "^4.0.2"`.
Run: `pnpm install`

- [ ] **Step 2: Serve the SPA in production only**

Update `apps/api/src/app.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./modules/health/health.module";

const staticImports =
  process.env.SERVE_STATIC === "true"
    ? [
        ServeStaticModule.forRoot({
          rootPath: join(__dirname, "..", "client"),
          exclude: ["/api/(.*)"],
        }),
      ]
    : [];

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ...staticImports, PrismaModule, HealthModule],
})
export class AppModule {}
```

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
**/node_modules
**/dist
**/build
.git
**/.env
**/.env.*
!**/.env.example
```

- [ ] **Step 4: Create `apps/api/Dockerfile`**

```dockerfile
FROM node:20-alpine
RUN corepack enable
# node:20-alpine ships no `openssl` package, so Prisma's engine (needs libssl) crash-loops at boot — install it.
RUN apk add --no-cache openssl
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @svyft/shared build \
 && pnpm exec prisma generate --schema prisma/schema.prisma --allow-no-models \
 && pnpm --filter @svyft/web build \
 && pnpm --filter @svyft/api build \
 && mkdir -p apps/api/client && cp -r apps/web/dist/. apps/api/client/
ENV NODE_ENV=production SERVE_STATIC=true PORT=4000
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
```

> `rootPath` = `join(__dirname, "..", "client")`; with the API compiled to `apps/api/dist/main.js`, that resolves to `apps/api/client` where the SPA is copied.

- [ ] **Step 5: Create `Caddyfile` and `docker-compose.prod.yml`**

`Caddyfile`:
```
{$SITE_ADDRESS} {
	reverse_proxy api:4000
}
```
`docker-compose.prod.yml`:
```yaml
services:
  api:
    image: ${IMAGE:-ghcr.io/sj132q/svyft-logistics:latest}
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
      SERVE_STATIC: "true"
      PORT: "4000"
    expose: ["4000"]
    volumes: ["svyft_uploads:/repo/apps/api/uploads"]
    mem_limit: 512m
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:4000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [api]
volumes:
  svyft_uploads:
  caddy_data:
  caddy_config:
```

- [ ] **Step 6: Build the image and verify it serves API + SPA**

Run: `docker build -f apps/api/Dockerfile -t svyft-logistics:local .`
Expected: build succeeds.
Run: `docker run --rm -e SERVE_STATIC=true -e PORT=4000 -p 4000:4000 svyft-logistics:local`
In another shell:
Run: `curl -s http://localhost:4000/api/health` → Expected: `{"status":"ok"}`
Run: `curl -s http://localhost:4000/ | grep -o "<title>[^<]*"` → Expected: `<title>Svyft Logistics`
(DB health needs a reachable DB; already covered in Tasks 4/6.) Stop the container.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build: add production Dockerfile, prod compose, and Caddy edge"
```

---

### Task 8: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a PR/push gate running lint · typecheck · test · build against an ephemeral Postgres.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  build-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: svyft
          POSTGRES_PASSWORD: svyft
          POSTGRES_DB: svyft
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U svyft"
          --health-interval 10s --health-timeout 5s --health-retries 5
    env:
      DATABASE_URL: postgresql://svyft:svyft@localhost:5432/svyft?schema=public
      DIRECT_URL: postgresql://svyft:svyft@localhost:5432/svyft?schema=public
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @svyft/shared build
      - run: pnpm exec prisma generate --schema prisma/schema.prisma --allow-no-models
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run test
      - run: pnpm run build
```

- [ ] **Step 2: Verify the steps pass locally (mirror of CI)**

Run (with local Postgres up and `apps/api/.env` set): `pnpm run ci`
Expected: lint, typecheck, test, build all pass, exit 0.

- [ ] **Step 3: Commit and push; confirm CI green**

```bash
git add -A
git commit -m "ci: add GitHub Actions lint/typecheck/test/build workflow"
git push
```
Then: `gh run watch` (or check the Actions tab) → Expected: CI run succeeds.

---

### Task 9: GitHub Actions CD (build → GHCR → SSH deploy)

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: on push to `main`, builds+pushes the image to GHCR and SSH-deploys to the droplet (migrate, then `compose up`). Requires repo secrets (documented in Task 10).

- [ ] **Step 1: Create `.github/workflows/deploy.yml`**

```yaml
name: Deploy
on:
  push:
    branches: [main]
concurrency:
  group: deploy-prod
  cancel-in-progress: false

jobs:
  build-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/api/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.sha }}
            ghcr.io/${{ github.repository }}:latest

  deploy:
    needs: build-push
    runs-on: ubuntu-latest
    steps:
      - name: SSH deploy
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: ${{ secrets.DROPLET_USER }}
          key: ${{ secrets.DROPLET_SSH_KEY }}
          script: |
            set -e
            cd /opt/svyft-logistics
            export IMAGE=ghcr.io/${{ github.repository }}:${{ github.sha }}
            echo "${{ secrets.GHCR_TOKEN }}" | docker login ghcr.io -u ${{ github.repository_owner }} --password-stdin
            docker compose -f docker-compose.prod.yml pull
            docker compose -f docker-compose.prod.yml run --rm -e IMAGE="$IMAGE" api pnpm exec prisma migrate deploy --schema prisma/schema.prisma
            docker compose -f docker-compose.prod.yml up -d
```

> `prisma migrate deploy` runs inside the app image (Prisma is present) using `DIRECT_URL` from the droplet's `.env`. On Plan 0 there are no migrations yet, so this is a safe no-op until Plan 1 adds the first one.

- [ ] **Step 2: Validate workflow syntax**

Run: `gh workflow view Deploy` (after commit/push) or lint YAML locally with `pnpm dlx yaml-lint .github/workflows/deploy.yml`
Expected: valid YAML, workflow recognized.

- [ ] **Step 3: Commit and push (deploy will fail until secrets/droplet exist — expected, completed in Task 10)**

```bash
git add -A
git commit -m "ci: add GHCR build + SSH deploy workflow"
git push
```

---

### Task 10: Operational cutover runbook (gated on infrastructure)

**Files:**
- Create: `docs/plans/stage-3/plan-0-cutover-runbook.md`

**Interfaces:**
- This task is **operational** (performed by a human with droplet + Neon + DNS access). It produces the first live deployment at `https://logistics.<domain>`.

- [ ] **Step 1: Write the runbook**

`docs/plans/stage-3/plan-0-cutover-runbook.md`:
````markdown
# Plan 0 — Production Cutover Runbook

Prereqs: DigitalOcean droplet (Docker), a domain, GitHub repo `sj132q/svyft-logistics`.

## 1. Neon
- [ ] Create a **new Neon project** for logistics, region nearest the droplet.
- [ ] Copy the **pooled** URL (`-pooler` host) → `DATABASE_URL` and the **direct** URL → `DIRECT_URL`.

## 2. Droplet pre-flight (coexistence)
- [ ] `ss -tlnp | grep -E ':80|:443'` — confirm `:80/:443` are free.
      - Free → proceed with the Caddy edge below.
      - Occupied → an edge already exists; instead of the `caddy` service, add a route for `logistics.<domain>` to the existing edge and drop the `caddy` service + `ports` from `docker-compose.prod.yml`.
- [ ] Ensure the droplet's DO firewall exposes only 80/443 publicly.

## 3. Droplet files
- [ ] `mkdir -p /opt/svyft-logistics && cd /opt/svyft-logistics`
- [ ] Copy `docker-compose.prod.yml` and `Caddyfile` here.
- [ ] Create `.env`:
```
DATABASE_URL=...neon pooled...
DIRECT_URL=...neon direct...
SITE_ADDRESS=logistics.<domain>
```

## 4. DNS
- [ ] A-record `logistics.<domain>` → droplet public IP. Wait for propagation.

## 5. GitHub secrets (repo → Settings → Secrets → Actions)
- [ ] `DROPLET_HOST`, `DROPLET_USER`, `DROPLET_SSH_KEY` (private key with droplet access)
- [ ] `GHCR_TOKEN` (a PAT with `read:packages`, used by the droplet to pull the image)

## 6. First deploy
- [ ] Push any commit to `main` (or re-run the Deploy workflow).
- [ ] Watch: `gh run watch`.
- [ ] Verify: `curl -s https://logistics.<domain>/api/health` → `{"status":"ok"}`
- [ ] Verify: `curl -s https://logistics.<domain>/api/health/db` → `{"db":"ok"}`
- [ ] Open `https://logistics.<domain>/` → two green `ok` badges.

## Rollback
- [ ] Re-run Deploy for a previous commit SHA, or on the droplet:
      `export IMAGE=ghcr.io/sj132q/svyft-logistics:<prev-sha> && docker compose -f docker-compose.prod.yml up -d`
````

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "docs: add Plan 0 production cutover runbook"
git push
```

---

## Self-Review (completed by plan author)

**Spec coverage (against Technical Design §2, §3, §11):**
- Monorepo + module boundaries → Tasks 1–5. ✓
- `packages/shared` isomorphic → Task 2 (types) — engine lands Plan 5. ✓
- NestJS + Prisma + Neon (pooled/direct) → Tasks 3–4. ✓
- Vite + React + Tailwind + shadcn + TanStack Query → Task 5. ✓
- Docker image (Nest serves SPA) + Caddy edge + prod compose → Task 7. ✓
- CI (lint/typecheck/test/build + Postgres service) → Task 8. ✓
- CD (GHCR + SSH deploy + migrate) → Task 9. ✓
- Coexistence / `:80/:443` pre-flight / Neon separate project → Task 10 runbook. ✓
- Deferred to later plans (noted inline): first migration + auth (Plan 1); route engine (Plan 5); escalation cron, notifications, emails (Plan 7).

**Placeholder scan:** none — every code step contains complete content; `<domain>` / Neon host placeholders are user-supplied infra values confined to `.env.example` and the runbook.

**Type consistency:** `formatQueryCode(year, seq)`, `Finding`, `PrismaService`, `HealthStatus`, `cn`, `fetchJson`, `queryClient` are referenced with consistent signatures across tasks.

---

*End of Plan 0.*
