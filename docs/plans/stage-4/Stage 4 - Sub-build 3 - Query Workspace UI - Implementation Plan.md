# Stage 4 · Sub-build 3 — Query Workspace UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work in a **fresh git worktree off `main`** on branch `feat/stage-4-sb3`.

**Goal:** Build the internal Executive **Query Workspace** — a stage-railed hub (B9) that re-homes the Stage-3 wizard as the "Create" panel and adds the RFQ workspace (per-leg panels, eligible-FF selection grid, leg-wise Distribute + page-level Distribute-All) — consuming SB2b's distribution endpoints plus **one small new read endpoint** (`GET /queries/:id/rfq-state`) that hydrates the grid's persisted selection + per-FF forwarder status.

**Architecture:** SB3 is **~95% frontend** (`apps/web`) plus **one isolated backend read** in the existing `apps/api/src/modules/rfq/` module (SB2b built only writes + `eligible-ffs`; there is no way to read a leg's persisted quotes/forwarder-status on page load — this closes that read/write asymmetry). The frontend adds a `rfq-workspace` feature: TanStack Query hooks over the RFQ endpoints, presentational leg panels + FF grid, and a `QueryWorkspaceHub` routed at `/queries/:id/workspace` with a shared `StageRail` (Create ↔ RFQ). All status advancement stays server-side (SB2a/2b); the UI only reads + fires the SB2b write endpoints and re-GETs.

**Tech Stack:** React 18 · React Router v6 · TanStack Query v5 · React Hook Form + Zod (`@svyft/shared`) · Tailwind + Radix/shadcn UI kit (`@/components/ui/*`) · Vitest + React Testing Library + `user-event`. Backend task: NestJS 10 · Prisma 5 · Jest e2e (`supertest`).

---

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from `docs/Stage 4 - Session Handoff.md`.

- **Monorepo filters:** web = `@svyft/web`, api = `@svyft/api`, shared = `@svyft/shared`. Web scripts: `test` = `vitest run`, `lint` = `eslint src`, `typecheck` = `tsc -p tsconfig.json --noEmit`, `build` = `vite build`.
- **Shared package rebuild:** after editing anything in `packages/shared/src/`, run `pnpm --filter @svyft/shared build` — **web and api resolve the BUILT `@svyft/shared`**; a stale/absent `dist` fails web with *"Failed to resolve entry for @svyft/shared"*. Add every new export to `packages/shared/src/index.ts` (it already does `export * from "./rfq"` / `"./masters"`). Web/Vitest resolve the built dist, so **rebuild shared before running web tests that import new symbols.**
- **LINT is part of verification** — CI's `build-test` runs lint. Run `pnpm --filter @svyft/web lint` (and `pnpm --filter @svyft/api lint` for the backend task) before every commit. Watch `@typescript-eslint/no-unused-vars`: no destructure-to-omit (`const { x, ...rest }`).
- **CI must be green** (`build-test` = lint + typecheck + tests + build) before merge. Watch the run after pushing (`gh pr checks <n> --watch`) — do **not** assume green.
- **Web conventions (reuse, do not reinvent):** `fetchJson`/`postJson`/`patchJson` + the new `putJson` in `@/lib/api`; TanStack Query with `queryKey: ["resource", ...params]` + `invalidateQueries` re-GET for derived fields; RHF + `zodResolver` for forms; UI primitives from `@/components/ui/*`; `cn()` from `@/lib/utils`; the `@/` alias = `apps/web/src`; import shared symbols from `@svyft/shared`.
- **RBAC (settled in SB2b — Executive+):** every RFQ workflow endpoint (reads + writes) is **authenticated-only, no `@Roles`**. The UI need **not** hide any distribution action from a signed-in role. Only master-data writes gate to Admin/Manager.
- **Status is read-only to the UI:** never post a status directly. Selection/distribute mutate via the SB2b endpoints; leg + query status come back through the re-GET (`GET /queries/:id` rollup + the new `rfq-state`). The query rollup is a **least-advanced-leg gate** (query = "RFQ Sent" only when **every** leg is ≥ RFQ_SENT).
- **Backend task only — DB safety + e2e teardown:** local Postgres on **`:5433`** (may need `colima start` + `docker compose up -d`). Migrations are additive (this build adds **none** — no schema change). ANY e2e that boots `AppModule` **MUST** `await app.close()` in `afterAll` (the "11-hour hang" — no `forceExit` in `jest-e2e.json`). Make every e2e **self-contained**: create + delete its own `query`/`leg`/`FreightForwarder` fixtures; never `findFirst` ambient rows. `fire` context is `{ queryId }` only; never pass a non-UUID `actorId`.
- **Commits:** conventional prefixes (`feat(rfq):`, `feat(web):`, `test(web):`, `chore(shared):`). Frequent, per-step where the step structure calls for it. Co-author trailer per repo policy.

---

## Design decisions (resolved before this plan — do not re-litigate)

1. **New read endpoint (user-approved).** SB2b shipped no way to read a leg's persisted quotes/forwarder-status; `QueryDetail` carries no quote data. Spec §7.2.2 requires the grid to show current selection, the Selected-FF count, each FF's forwarder-status badge, and frozen (RFQ_SENT+) FFs as read-only — *on a fresh load*. Resolution (chosen): add **one** Executive+ `GET /queries/:id/rfq-state` → `{ quotes: QuoteDto[]; rfqs: RfqDto[]; freightForwarders: FreightForwarderDto[] }`. The `freightForwarders` array carries the FF-card display data for every FF referenced by a quote, so a frozen FF renders correctly even when it is no longer in the (filtered) eligible list. This is the plan's only backend touch.
2. **Stage rail = shared nav strip, wizard untouched internally (B9 re-home).** The `StageRail` (Create · RFQ · *Quotes/Award later, disabled*) renders at the top of **both** the existing wizard route (`/queries/:id`) and the new hub (`/queries/:id/workspace`). "Create" links to the wizard; "RFQ" links to the hub. This satisfies B9's "re-home the wizard as the Create panel" with a single additive JSX insertion in `QueryWizardPage` (no wizard-internals rewrite, no route redirect, no risk to Stage-3 create/edit flows). The RFQ stage is **enabled only when the query is ≥ RFQ_READY**.
3. **Scope IN:** Query Overview header (§7.1); per-leg panels + leg summary (§7.2.1); eligible-FF grid with select/deselect, Selected/Eligible counts, frozen read-only, per-FF status badge, E1 broaden/empty (§7.2.2, §10.3); leg-wise Distribute + page-level Distribute-All with deadline override, F1/F4/F5 inline (400 `codes`), F6 confirm-re-distribute (409), and `distribute-all` `skipped[]` display; the raw `accessToken` shown once as a copyable portal link (no email — SB5); a light **Preview RFQ** dialog (leg details + cargo manifest table).
4. **Scope OUT (later sub-builds):** the **scoped route diagram** (§7.3.4 — an FF-portal visualization, SB4); the FF portal itself + quoting (SB4); live emails/reminders/expiry (SB5); change-order cascade (SB6). The Preview dialog is a plain read-only render — **no** route-graph rendering.

---

## Fresh-worktree setup (do this FIRST, before Task 1)

A new worktree off `main` has none of the build state.

- [ ] **S1.** Create the worktree + branch (via `superpowers:using-git-worktrees`), base `main`, branch `feat/stage-4-sb3`.
- [ ] **S2.** `pnpm install` (repo root).
- [ ] **S3.** **Copy `apps/api/.env` from the main checkout** into the worktree's `apps/api/.env` (gitignored → provides `DATABASE_URL`/`DIRECT_URL` for the `:5433` dev DB; needed for the Task-1 e2e + api typecheck). Confirm the DB is reachable (`colima start` + `docker compose up -d` if needed).
- [ ] **S4.** `pnpm exec prisma generate` (repo root — no migration in this build; just the client for the api task).
- [ ] **S5.** `pnpm --filter @svyft/shared build`.
- [ ] **S6.** **Baseline green** before writing any code:
  - `pnpm --filter @svyft/shared build` → OK
  - `pnpm --filter @svyft/web test` → all pass
  - `pnpm --filter @svyft/web lint` → clean
  - `pnpm --filter @svyft/web typecheck` → clean
  - `pnpm --filter @svyft/api test -- rfq` → the SB2b RFQ e2e pass (and the process **exits**)
  If baseline is red, STOP and fix the environment before proceeding.

---

## File Structure

**Backend (Task 1 only):**
- Modify: `packages/shared/src/rfq.ts` — add `QueryRfqStateDto` (imports `FreightForwarderDto` from `./masters`). `index.ts` already re-exports `./rfq`.
- Modify: `apps/api/src/modules/rfq/rfq.service.ts` — add `getRfqState(queryId)`.
- Modify: `apps/api/src/modules/rfq/rfq.controller.ts` — add `@Get("rfq-state")`.
- Test: `apps/api/test/rfq-state.e2e-spec.ts` (new, self-contained).

**Frontend — new feature dir `apps/web/src/features/rfq-workspace/`:**
- `useRfq.ts` — `useRfqState`, `useEligibleFfs`, `useSetFfSelection`, `useDistributeLeg`, `useDistributeAll`.
- `statusBadges.tsx` — `LegStatusBadge`, `ForwarderStatusBadge`.
- `QueryOverviewHeader.tsx` — §7.1 header.
- `FfSelectionGrid.tsx` — §7.2.2 grid.
- `LegPanel.tsx` — §7.2.1 summary + grid + deadline + Distribute (Tasks 6–7).
- `PreviewRfqDialog.tsx` — light read-only RFQ preview.
- `RfqWorkspace.tsx` — composes header + leg panels + Distribute-All.
- `StageRail.tsx` — shared Create ↔ RFQ nav.
- `QueryWorkspaceHub.tsx` — routed hub.
- Co-located `*.test.tsx` per component.

**Frontend — modified:**
- `apps/web/src/lib/api.ts` — add `putJson`.
- `apps/web/src/App.tsx` — add `/queries/:id/workspace` route.
- `apps/web/src/features/query-wizard/QueryWizardPage.tsx` — one additive `<StageRail active="create" …/>` insertion for existing queries.

---

## Task 1: Backend — `GET /queries/:id/rfq-state` read endpoint

**Goal:** One Executive+ read that returns every quote + RFQ + referenced-FF for a query, so the workspace can hydrate the FF grid's selection + per-FF forwarder status on load.

**Files:**
- Modify: `packages/shared/src/rfq.ts`
- Modify: `apps/api/src/modules/rfq/rfq.service.ts`, `apps/api/src/modules/rfq/rfq.controller.ts`
- Test: `apps/api/test/rfq-state.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; existing `QuoteDto`/`RfqDto` shapes; `FreightForwarderDto` from `@svyft/shared`.
- Produces: shared `QueryRfqStateDto = { quotes: QuoteDto[]; rfqs: RfqDto[]; freightForwarders: FreightForwarderDto[] }`; `RfqService.getRfqState(queryId: string): Promise<QueryRfqStateDto>`; route `GET /api/queries/:id/rfq-state`.

- [ ] **Step 1: Add the shared DTO.** In `packages/shared/src/rfq.ts`, add the import at the top (next to the existing `import type { Incoterms } from "./query";`):
```ts
import type { FreightForwarderDto } from "./masters";
```
and add, after the `QuoteDto` interface:
```ts
/** Read model that hydrates the Query Workspace grid: all quotes + RFQs for a
 *  query, plus the FF-card data for every FF referenced by a quote (so a frozen
 *  FF renders even when it is no longer in the filtered eligible list). */
export interface QueryRfqStateDto {
  quotes: QuoteDto[];
  rfqs: RfqDto[];
  freightForwarders: FreightForwarderDto[];
}
```
Then rebuild shared:
```bash
pnpm --filter @svyft/shared build
```

- [ ] **Step 2: Write the failing e2e** `apps/api/test/rfq-state.e2e-spec.ts`. Mirror the SB2b HTTP harness (bootstrap `AppModule`, `cookie(Role.X)` helper, `PrismaService`). Self-contained fixtures: a query, a leg, two ACTIVE FFs, one `SELECT` quote (ffA) and one distributed quote (ffB → create an `Rfq` + a `RFQ_SENT` quote pointing at it). Assert shape:
```ts
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { createHash } from "node:crypto";
import { Role } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { signTestJwt } from "./helpers/jwt"; // reuse the SB2b harness helper (copy the pattern used by rfq-distribute.e2e-spec.ts)

const CODE = "E2E-RFQSTATE-Q1";
const FF_CODES = ["FF-STATE-A", "FF-STATE-B"];

describe("GET /queries/:id/rfq-state (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookie = (role: Role) => [`access_token=${signTestJwt(role)}`];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.use(cookieParser());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close(); // ⚠ mandatory — prevents the cron hang
  });

  async function cleanup() {
    await prisma.quote.deleteMany({ where: { query: { queryCode: CODE } } }).catch(() => {});
    await prisma.rfq.deleteMany({ where: { query: { queryCode: CODE } } }).catch(() => {});
    await prisma.freightForwarder.deleteMany({ where: { freightForwarderCode: { in: FF_CODES } } }).catch(() => {});
    await prisma.leg.deleteMany({ where: { query: { queryCode: CODE } } }).catch(() => {});
    await prisma.query.deleteMany({ where: { queryCode: CODE } }).catch(() => {});
  }

  const mkFf = (code: string) =>
    prisma.freightForwarder.create({
      data: { freightForwarderCode: code, companyName: `${code} Co`, pic: "P",
        contactNumber: "+10000000000", email: `${code}@e2e.test`,
        availableCountries: ["AE"], modes: ["AIR"], handleDg: false, paymentTerms: "NET 30", typicalLeadTime: "2d" },
    });

  it("returns quotes, rfqs, and the referenced FFs", async () => {
    const query = await prisma.query.create({ data: { queryCode: CODE } });
    const leg = await prisma.leg.create({ data: { queryId: query.id, legCode: "L1", status: "RFQ_SENT" } });
    const ffA = await mkFf("FF-STATE-A");
    const ffB = await mkFf("FF-STATE-B");
    await prisma.quote.create({ data: { queryId: query.id, legId: leg.id, freightForwarderId: ffA.id, status: "SELECT" } });
    const rfq = await prisma.rfq.create({
      data: { queryId: query.id, freightForwarderId: ffB.id, rfqNumber: "YAL26-0001-RFQ001",
        accessTokenHash: createHash("sha256").update("x").digest("hex"), submissionDeadline: new Date(Date.now() + 86400000), incoterms: "FOB" },
    });
    await prisma.quote.create({ data: { queryId: query.id, legId: leg.id, freightForwarderId: ffB.id, rfqId: rfq.id, status: "RFQ_SENT" } });

    const res = await request(app.getHttpServer())
      .get(`/api/queries/${query.id}/rfq-state`).set("Cookie", cookie(Role.EXECUTIVE)).expect(200);

    expect(res.body.quotes).toHaveLength(2);
    expect(res.body.rfqs).toHaveLength(1);
    expect(res.body.rfqs[0]).toMatchObject({ rfqNumber: "YAL26-0001-RFQ001", incoterms: "FOB" });
    expect(res.body.rfqs[0].accessTokenHash).toBeUndefined(); // secret never leaks
    const ffIds = res.body.freightForwarders.map((f: { id: string }) => f.id).sort();
    expect(ffIds).toEqual([ffA.id, ffB.id].sort());
    const sent = res.body.quotes.find((q: { status: string }) => q.status === "RFQ_SENT");
    expect(sent.rfqId).toBe(rfq.id);
  });

  it("401s an unauthenticated request", async () => {
    const query = await prisma.query.findFirstOrThrow({ where: { queryCode: CODE } });
    await request(app.getHttpServer()).get(`/api/queries/${query.id}/rfq-state`).expect(401);
  });
});
```
> Match the JWT/cookie helper actually used by the SB2b RFQ specs (open `apps/api/test/rfq-distribute.e2e-spec.ts` and copy its harness verbatim — do not invent `signTestJwt` if the repo names it differently).

- [ ] **Step 3: Run — RED.** `pnpm --filter @svyft/api test -- rfq-state` → 404 (route missing).

- [ ] **Step 4: Add `getRfqState` to `RfqService`.** Add `QueryRfqStateDto` + `FreightForwarderDto` to the `@svyft/shared` import block, then the method (place it near `reissueToken`):
```ts
async getRfqState(queryId: string): Promise<QueryRfqStateDto> {
  const query = await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } });
  if (!query) throw new NotFoundException("Query not found");

  const [quotes, rfqs] = await Promise.all([
    this.prisma.quote.findMany({ where: { queryId }, orderBy: { legId: "asc" } }),
    this.prisma.rfq.findMany({ where: { queryId }, orderBy: { rfqNumber: "asc" } }),
  ]);

  const ffIds = [...new Set(quotes.map((q) => q.freightForwarderId))];
  const ffs = ffIds.length
    ? await this.prisma.freightForwarder.findMany({ where: { id: { in: ffIds } }, orderBy: { companyName: "asc" } })
    : [];

  return {
    quotes: quotes.map((q) => ({
      id: q.id,
      queryId: q.queryId,
      legId: q.legId,
      freightForwarderId: q.freightForwarderId,
      rfqId: q.rfqId,
      status: q.status,
      submittedAt: q.submittedAt ? q.submittedAt.toISOString() : null,
    })),
    rfqs: rfqs.map((r) => ({
      id: r.id,
      queryId: r.queryId,
      freightForwarderId: r.freightForwarderId,
      rfqNumber: r.rfqNumber,
      submissionDeadline: r.submissionDeadline.toISOString(),
      incoterms: r.incoterms,
      currency: r.currency,
      quoteValidityUntil: r.quoteValidityUntil ? r.quoteValidityUntil.toISOString() : null,
    })),
    freightForwarders: ffs.map((f) => ({
      id: f.id,
      freightForwarderCode: f.freightForwarderCode,
      companyName: f.companyName,
      companyAddress: f.companyAddress,
      pic: f.pic,
      contactNumber: f.contactNumber,
      email: f.email,
      availableCountries: f.availableCountries,
      modes: f.modes,
      handleDg: f.handleDg,
      vatTrnEori: f.vatTrnEori,
      whLocation: f.whLocation,
      defaultCurrency: f.defaultCurrency,
      paymentTerms: f.paymentTerms,
      typicalLeadTime: f.typicalLeadTime,
      status: f.status,
    })),
  };
}
```
> **DRY note:** if `FreightForwardersService` already exposes a public `toDto(row)` mapper, import + reuse it for the `freightForwarders` map instead of inlining. Check `freight-forwarders.service.ts` first; only inline (as above) if the mapper is private/absent.

- [ ] **Step 5: Add the controller route.** Add `@Get("rfq-state")` to `RfqController` (it already imports `Get`, `Param`):
```ts
// Executive+ (no @Roles) — authenticated only. Read model for the Query Workspace grid.
@Get("rfq-state")
rfqState(@Param("id") id: string) {
  return this.rfq.getRfqState(id);
}
```

- [ ] **Step 6: Run — GREEN.** `pnpm --filter @svyft/api test -- rfq-state` → PASS, process exits.

- [ ] **Step 7: Full backend verify + commit.**
```bash
pnpm --filter @svyft/shared build && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint && pnpm --filter @svyft/api test -- rfq
git add packages/shared apps/api/src/modules/rfq apps/api/test/rfq-state.e2e-spec.ts
git commit -m "feat(rfq): GET rfq-state read endpoint (quotes + rfqs + referenced FFs)"
```

---

## Task 2: Web — `putJson` helper + RFQ query/mutation hooks

**Goal:** A `putJson` in the shared API layer, and the `rfq-workspace` hooks the UI consumes.

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/features/rfq-workspace/useRfq.ts`
- Test: `apps/web/src/features/rfq-workspace/useRfq.test.tsx`

**Interfaces:**
- Consumes: `fetchJson`/`postJson`/`putJson` from `@/lib/api`; `QueryRfqStateDto`, `FreightForwarderDto`, `DistributeInput`, `DistributeResult` from `@svyft/shared`.
- Produces:
  - `putJson<T>(url: string, body: unknown): Promise<T>`.
  - `useRfqState(queryId?: string)` → `UseQueryResult<QueryRfqStateDto>` (key `["rfq-state", queryId]`).
  - `useEligibleFfs(queryId, legId, broaden, enabled?)` → `UseQueryResult<FreightForwarderDto[]>` (key `["eligible-ffs", queryId, legId, broaden]`).
  - `useSetFfSelection(queryId, legId)` → mutation `(ffIds: string[]) => Promise<{ selected: string[] }>`.
  - `useDistributeLeg(queryId, legId)` → mutation `(input: DistributeInput) => Promise<DistributeResult>`.
  - `useDistributeAll(queryId)` → mutation `(input: DistributeInput) => Promise<DistributeResult>`.

- [ ] **Step 1: Add `putJson`** to `apps/web/src/lib/api.ts`, directly after `patchJson`:
```ts
export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return raise(res, url);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
```

- [ ] **Step 2: Write the failing test** `apps/web/src/features/rfq-workspace/useRfq.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { useRfqState, useSetFfSelection } from "./useRfq";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => vi.unstubAllGlobals());

describe("useRfq hooks", () => {
  it("useRfqState GETs the rfq-state endpoint", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/api/queries/q1/rfq-state"))
        return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      return { status: 404 };
    }));
    const { result } = renderHook(() => useRfqState("q1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ quotes: [], rfqs: [], freightForwarders: [] });
  });

  it("useSetFfSelection PUTs { ffIds } to ff-selection", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url.includes("/legs/l1/ff-selection") && init?.method === "PUT")
        return { status: 200, body: { selected: ["ff1"] } };
      return { status: 404 };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSetFfSelection("q1", "l1"), { wrapper });
    const res = await result.current.mutateAsync(["ff1"]);
    expect(res).toEqual({ selected: ["ff1"] });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("ff-selection"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ ffIds: ["ff1"] });
  });
});
```

- [ ] **Step 3: Run — RED.** `pnpm --filter @svyft/web test -- useRfq` → fail (module missing).

- [ ] **Step 4: Create `apps/web/src/features/rfq-workspace/useRfq.ts`:**
```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  QueryRfqStateDto,
  FreightForwarderDto,
  DistributeInput,
  DistributeResult,
} from "@svyft/shared";
import { fetchJson, postJson, putJson } from "@/lib/api";

export function useRfqState(queryId?: string) {
  return useQuery({
    queryKey: ["rfq-state", queryId],
    queryFn: () => fetchJson<QueryRfqStateDto>(`/api/queries/${queryId}/rfq-state`),
    enabled: !!queryId,
  });
}

export function useEligibleFfs(queryId: string, legId: string, broaden: boolean, enabled = true) {
  return useQuery({
    queryKey: ["eligible-ffs", queryId, legId, broaden],
    queryFn: () =>
      fetchJson<FreightForwarderDto[]>(
        `/api/queries/${queryId}/legs/${legId}/eligible-ffs?broaden=${broaden}`,
      ),
    enabled: enabled && !!queryId && !!legId,
  });
}

export function useSetFfSelection(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ffIds: string[]) =>
      putJson<{ selected: string[] }>(`/api/queries/${queryId}/legs/${legId}/ff-selection`, { ffIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rfq-state", queryId] }),
  });
}

export function useDistributeLeg(queryId: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DistributeInput) =>
      postJson<DistributeResult>(`/api/queries/${queryId}/legs/${legId}/distribute`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rfq-state", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
      qc.invalidateQueries({ queryKey: ["eligible-ffs", queryId, legId] });
    },
  });
}

export function useDistributeAll(queryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DistributeInput) =>
      postJson<DistributeResult>(`/api/queries/${queryId}/distribute-all`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rfq-state", queryId] });
      qc.invalidateQueries({ queryKey: ["query", queryId] });
    },
  });
}
```

- [ ] **Step 5: Run — GREEN.** `pnpm --filter @svyft/web test -- useRfq`.

- [ ] **Step 6: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
git add apps/web/src/lib/api.ts apps/web/src/features/rfq-workspace/useRfq.ts apps/web/src/features/rfq-workspace/useRfq.test.tsx
git commit -m "feat(web): putJson + rfq-workspace query/mutation hooks"
```

---

## Task 3: Web — status badge helpers

**Goal:** Reusable `LegStatusBadge` (leg status) + `ForwarderStatusBadge` (spec §9.1 forwarder status = `QuoteStatus`), with the spec's display labels.

**Files:**
- Create: `apps/web/src/features/rfq-workspace/statusBadges.tsx`
- Test: `apps/web/src/features/rfq-workspace/statusBadges.test.tsx`

**Interfaces:**
- Consumes: `Badge` from `@/components/ui/badge`; `LegStatus`, `QuoteStatus` types from `@svyft/shared`.
- Produces: `LegStatusBadge({ status: LegStatus })`, `ForwarderStatusBadge({ status: QuoteStatus })`.

- [ ] **Step 1: Write the failing test** `statusBadges.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LegStatusBadge, ForwarderStatusBadge } from "./statusBadges";

describe("status badges", () => {
  it("renders a human leg status label", () => {
    render(<LegStatusBadge status="RFQ_SENT" />);
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
  });
  it("maps forwarder (quote) status to the spec label", () => {
    render(<ForwarderStatusBadge status="SELECT" />);
    expect(screen.getByText("Select")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/web test -- statusBadges`).

- [ ] **Step 3: Create `statusBadges.tsx`:**
```tsx
import type { LegStatus, QuoteStatus } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";

type BadgeVariant =
  | "default" | "secondary" | "success" | "warning"
  | "accent" | "destructive" | "outline" | "pending";

function legStatusVariant(s: LegStatus): BadgeVariant {
  switch (s) {
    case "DRAFT": return "pending";
    case "READY_FOR_RFQ": return "default";
    case "RFQ_SENT": return "accent";
    case "PARTIALLY_QUOTED": return "warning";
    case "FULLY_QUOTED":
    case "AWARDED": return "success";
    default: return "outline";
  }
}

export function LegStatusBadge({ status }: { status: LegStatus }) {
  return <Badge variant={legStatusVariant(status)}>{status.replace(/_/g, " ")}</Badge>;
}

// Forwarder status (spec §9.1) uses the QuoteStatus vocabulary.
const FORWARDER_LABEL: Record<QuoteStatus, string> = {
  SELECT: "Select",
  RFQ_SENT: "RFQ Sent",
  QUOTED: "Quoted",
  EXPIRED: "Expired",
  INVALID: "Invalid",
  REQUOTED: "Requoted",
  CLOSED: "Closed",
  APPROVED: "Approved",
};

function forwarderVariant(s: QuoteStatus): BadgeVariant {
  switch (s) {
    case "SELECT": return "secondary";
    case "RFQ_SENT": return "accent";
    case "QUOTED":
    case "REQUOTED":
    case "APPROVED": return "success";
    case "EXPIRED":
    case "INVALID": return "destructive";
    default: return "outline";
  }
}

export function ForwarderStatusBadge({ status }: { status: QuoteStatus }) {
  return <Badge variant={forwarderVariant(status)}>{FORWARDER_LABEL[status]}</Badge>;
}
```

- [ ] **Step 4: Run — GREEN.** `pnpm --filter @svyft/web test -- statusBadges`.

- [ ] **Step 5: Commit.**
```bash
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
git add apps/web/src/features/rfq-workspace/statusBadges.tsx apps/web/src/features/rfq-workspace/statusBadges.test.tsx
git commit -m "feat(web): leg + forwarder status badges"
```

---

## Task 4: Web — Query Overview header (§7.1)

**Goal:** A read-only header derived entirely from `QueryDetail`: Query ID, Incoterms, Modes, Origin(s), Destination(s), rolled-up totals, and the query status badge.

**Files:**
- Create: `apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx`
- Test: `apps/web/src/features/rfq-workspace/QueryOverviewHeader.test.tsx`

**Interfaces:**
- Consumes: `QueryDetail`, `PointRef` from `@svyft/shared`; `Badge`.
- Produces: `QueryOverviewHeader({ query: QueryDetail })`.

- [ ] **Step 1: Write the failing test** `QueryOverviewHeader.test.tsx`. Build a minimal `QueryDetail` (only the fields the header reads; cast through `as unknown as QueryDetail` for brevity):
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QueryDetail } from "@svyft/shared";
import { QueryOverviewHeader } from "./QueryOverviewHeader";

const query = {
  queryCode: "YAL26-0001",
  incoterms: "FOB",
  status: "RFQ_SENT",
  freightMode: ["AIR", "ROAD"],
  origin: [{ id: "p1", name: "Shanghai Port", city: "Shanghai", country: "CN" }],
  destination: [{ id: "p2", name: null, city: "Dubai", country: "AE" }],
  legs: [
    { rollup: { totalPackages: 3, totalCbm: 12, totalGrossWt: 500, totalNetWt: 400 } },
    { rollup: { totalPackages: 2, totalCbm: 8, totalGrossWt: 300, totalNetWt: 250 } },
  ],
} as unknown as QueryDetail;

describe("QueryOverviewHeader", () => {
  it("shows the query code, modes, rolled-up totals and status", () => {
    render(<QueryOverviewHeader query={query} />);
    expect(screen.getByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByText("AIR")).toBeInTheDocument();
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
    expect(screen.getByText(/5 pkg/i)).toBeInTheDocument();   // 3 + 2 packages
    expect(screen.getByText(/Shanghai Port/)).toBeInTheDocument();
    expect(screen.getByText(/Dubai/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/web test -- QueryOverviewHeader`).

- [ ] **Step 3: Create `QueryOverviewHeader.tsx`:**
```tsx
import type { QueryDetail, PointRef } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";

function queryStatusVariant(s: string) {
  if (s === "DRAFT") return "pending" as const;
  if (s === "CREATED") return "secondary" as const;
  if (s === "RFQ_READY") return "default" as const;
  if (s === "RFQ_SENT") return "accent" as const;
  if (s === "QUOTED" || s === "WON") return "success" as const;
  return "outline" as const;
}

function pointLabel(p: PointRef): string {
  return p.name ?? [p.city, p.country].filter(Boolean).join(", ") ?? p.country ?? "—";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

export function QueryOverviewHeader({ query }: { query: QueryDetail }) {
  const totals = query.legs.reduce(
    (a, l) => ({
      pkg: a.pkg + l.rollup.totalPackages,
      cbm: a.cbm + l.rollup.totalCbm,
      gross: a.gross + l.rollup.totalGrossWt,
    }),
    { pkg: 0, cbm: 0, gross: 0 },
  );
  return (
    <section
      aria-label="Query overview"
      className="rounded-lg border border-border bg-card p-4 sm:p-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          <span className="font-mono tabular-nums text-primary">{query.queryCode}</span>
        </h1>
        <Badge variant={queryStatusVariant(query.status)}>{query.status.replace(/_/g, " ")}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <Field label="Incoterms">{query.incoterms ?? "—"}</Field>
        <Field label="Modes">
          <div className="flex flex-wrap gap-1">
            {query.freightMode.length
              ? query.freightMode.map((m) => (
                  <Badge key={m} variant="secondary">{m}</Badge>
                ))
              : "—"}
          </div>
        </Field>
        <Field label="Origin">
          {query.origin.length ? query.origin.map(pointLabel).join(" · ") : "—"}
        </Field>
        <Field label="Destination">
          {query.destination.length ? query.destination.map(pointLabel).join(" · ") : "—"}
        </Field>
        <Field label="Totals">
          {totals.pkg} pkg · {totals.cbm} CBM · {totals.gross} kg
        </Field>
      </dl>
    </section>
  );
}
```
> Note: `QueryDetail` has no joined client-company name (only `clientId` + `contactName`); §7.1's "Client Name" is intentionally omitted here to avoid an extra fetch/backend change — a small follow-up if desired.

- [ ] **Step 4: Run — GREEN**, then commit.
```bash
pnpm --filter @svyft/web test -- QueryOverviewHeader && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
git add apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx apps/web/src/features/rfq-workspace/QueryOverviewHeader.test.tsx
git commit -m "feat(web): query overview header (§7.1)"
```

---

## Task 5: Web — eligible-FF selection grid (§7.2.2)

**Goal:** The per-leg FF grid: lists eligible FFs as selectable cards, seeds selection + frozen state + per-FF forwarder status from the leg's quotes, shows Eligible/Selected counts, disables frozen (RFQ_SENT+) FFs, and handles E1 (no eligible → broaden / view-all).

**Files:**
- Create: `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx`
- Test: `apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx`

**Interfaces:**
- Consumes: `useEligibleFfs`, `useSetFfSelection`; `ForwarderStatusBadge`; `FreightForwarderDto`, `QuoteStatus` from `@svyft/shared`; `Checkbox`, `Card`/`CardContent`, `Button`.
- Produces:
```ts
interface LegQuote { freightForwarderId: string; status: QuoteStatus; }
interface FfSelectionGridProps {
  queryId: string;
  legId: string;
  legQuotes: LegQuote[];                    // this leg's quotes (from rfq-state)
  referencedFfs: FreightForwarderDto[];     // rfq-state.freightForwarders (card data for frozen/off-list FFs)
}
export function FfSelectionGrid(props: FfSelectionGridProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test** `FfSelectionGrid.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FreightForwarderDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { FfSelectionGrid } from "./FfSelectionGrid";

const ff = (id: string, name: string): FreightForwarderDto => ({
  id, freightForwarderCode: id, companyName: name, companyAddress: null, pic: "P",
  contactNumber: "+1", email: `${id}@x.com`, availableCountries: ["AE"], modes: ["AIR"],
  handleDg: false, vatTrnEori: null, whLocation: null, defaultCurrency: null,
  paymentTerms: "NET 30", typicalLeadTime: "2d", status: "ACTIVE",
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("FfSelectionGrid", () => {
  it("lists eligible FFs, toggles selection via PUT, shows counts", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("a", "Alpha FF"), ff("b", "Beta FF")] };
      if (url.includes("/ff-selection") && init?.method === "PUT") return { status: 200, body: { selected: ["a"] } };
      return { status: 404 };
    });
    vi.stubGlobal("fetch", fetchMock);

    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    expect(await screen.findByText("Alpha FF")).toBeInTheDocument();
    expect(screen.getByText(/Eligible 2/i)).toBeInTheDocument();
    expect(screen.getByText(/Selected 0/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: /select alpha ff/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("ff-selection"))).toBe(true),
    );
  });

  it("renders a frozen (RFQ_SENT) FF read-only with its forwarder badge", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(
      <FfSelectionGrid
        queryId="q1" legId="l1"
        legQuotes={[{ freightForwarderId: "b", status: "RFQ_SENT" }]}
        referencedFfs={[ff("b", "Beta FF")]}
      />,
    );
    expect(await screen.findByText("Beta FF")).toBeInTheDocument();
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /beta ff/i })).toBeDisabled();
  });

  it("shows the E1 empty state with a broaden action", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("broaden=false")) return { status: 200, body: [] };
      if (url.includes("broaden=true")) return { status: 200, body: [ff("c", "Gamma FF")] };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    expect(await screen.findByText(/No eligible Freight Forwarders/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /view all active/i }));
    expect(await screen.findByText("Gamma FF")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/web test -- FfSelectionGrid`).

- [ ] **Step 3: Create `FfSelectionGrid.tsx`:**
```tsx
import { useEffect, useMemo, useState } from "react";
import type { FreightForwarderDto, QuoteStatus } from "@svyft/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useEligibleFfs, useSetFfSelection } from "./useRfq";
import { ForwarderStatusBadge } from "./statusBadges";

export interface LegQuote {
  freightForwarderId: string;
  status: QuoteStatus;
}
interface FfSelectionGridProps {
  queryId: string;
  legId: string;
  legQuotes: LegQuote[];
  referencedFfs: FreightForwarderDto[];
}

export function FfSelectionGrid({ queryId, legId, legQuotes, referencedFfs }: FfSelectionGridProps) {
  const [broaden, setBroaden] = useState(false);
  const { data: eligible = [], isLoading } = useEligibleFfs(queryId, legId, broaden);
  const setSelection = useSetFfSelection(queryId, legId);

  // Per-FF status + frozen (anything past SELECT is locked, spec §7.2.2).
  const statusByFf = useMemo(
    () => new Map(legQuotes.map((q) => [q.freightForwarderId, q.status])),
    [legQuotes],
  );
  const frozen = useMemo(
    () => new Set(legQuotes.filter((q) => q.status !== "SELECT").map((q) => q.freightForwarderId)),
    [legQuotes],
  );

  // Selection = the mutable SELECT set; seed from the server, re-seed on re-GET.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(legQuotes.filter((q) => q.status === "SELECT").map((q) => q.freightForwarderId)),
  );
  useEffect(() => {
    setSelected(new Set(legQuotes.filter((q) => q.status === "SELECT").map((q) => q.freightForwarderId)));
  }, [legQuotes]);

  // Display = eligible ∪ any FF that already has a quote (so frozen/off-list FFs still show).
  const display = useMemo(() => {
    const byId = new Map<string, FreightForwarderDto>();
    for (const f of eligible) byId.set(f.id, f);
    for (const f of referencedFfs) if (statusByFf.has(f.id) && !byId.has(f.id)) byId.set(f.id, f);
    return [...byId.values()];
  }, [eligible, referencedFfs, statusByFf]);

  const selectedCount = new Set([...selected, ...frozen]).size;

  function toggle(ffId: string, next: boolean) {
    if (frozen.has(ffId)) return;
    const nextSet = new Set(selected);
    if (next) nextSet.add(ffId);
    else nextSet.delete(ffId);
    setSelected(nextSet);
    setSelection.mutate([...nextSet]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex gap-3 text-muted-foreground">
          <span>Eligible {eligible.length}</span>
          <span>·</span>
          <span>Selected {selectedCount}</span>
        </div>
        {broaden && (
          <Button variant="ghost" size="sm" onClick={() => setBroaden(false)}>
            Back to filtered
          </Button>
        )}
      </div>

      {broaden && (
        <p className="text-xs text-warning">
          Showing all active forwarders — the route/mode filter is off (DG rules still enforced at distribute).
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading forwarders…</p>
      ) : display.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm">
          <p className="text-muted-foreground">
            No eligible Freight Forwarders were found for this route and transport mode.
          </p>
          {!broaden && (
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setBroaden(true)}>
              View all active forwarders
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {display.map((f) => {
            const isFrozen = frozen.has(f.id);
            const status = statusByFf.get(f.id);
            return (
              <Card key={f.id} className={isFrozen ? "opacity-90" : ""}>
                <CardContent className="flex gap-3 p-4">
                  <Checkbox
                    aria-label={`Select ${f.companyName}`}
                    checked={selected.has(f.id) || isFrozen}
                    disabled={isFrozen}
                    onCheckedChange={(v) => toggle(f.id, v === true)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{f.companyName}</span>
                      {status && <ForwarderStatusBadge status={status} />}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {f.availableCountries.join(", ")} · {f.modes.join(", ")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {f.paymentTerms ?? "—"} · Lead {f.typicalLeadTime ?? "—"}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — GREEN** (`pnpm --filter @svyft/web test -- FfSelectionGrid`). If the Radix `Checkbox` role/label assertion needs the jsdom polyfills, they are already in `test/setup.ts` (pointer-capture / ResizeObserver) — no extra setup.

- [ ] **Step 5: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
git add apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx
git commit -m "feat(web): eligible-FF selection grid (§7.2.2)"
```

---

## Task 6: Web — Leg panel (§7.2.1 summary + grid + deadline field)

**Goal:** A collapsible per-leg panel: read-only leg summary (endpoints resolved from points, mode, dates, rollup totals) + leg status badge + the FF grid + a submission-deadline field (default now+48h). The Distribute action is added in Task 7.

**Files:**
- Create: `apps/web/src/features/rfq-workspace/LegPanel.tsx`
- Test: `apps/web/src/features/rfq-workspace/LegPanel.test.tsx`

**Interfaces:**
- Consumes: `FfSelectionGrid`, `LegStatusBadge`; `QueryLegDto`, `QueryPointDto`, `QuoteDto`, `FreightForwarderDto` from `@svyft/shared`; `Card`, `Button`, `Input`, `Label`, `Badge`.
- Produces:
```ts
interface LegPanelProps {
  queryId: string;
  leg: QueryLegDto;
  points: QueryPointDto[];
  legQuotes: QuoteDto[];                  // quotes for THIS leg
  referencedFfs: FreightForwarderDto[];
}
export function LegPanel(props: LegPanelProps): JSX.Element;
export function defaultDeadlineLocal(nowMs?: number): string; // "YYYY-MM-DDTHH:mm" for <input type=datetime-local>, +48h
```

- [ ] **Step 1: Write the failing test** `LegPanel.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { QueryLegDto, QueryPointDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { LegPanel, defaultDeadlineLocal } from "./LegPanel";

const leg = {
  id: "l1", legCode: "L1", legName: "Main air leg", mode: "AIR", status: "READY_FOR_RFQ",
  originPointId: "p1", destinationPointId: "p2", readyDate: "2026-08-01T00:00:00.000Z",
  targetDelivery: "2026-08-05T00:00:00.000Z",
  rollup: { totalPackages: 3, totalCbm: 12, totalGrossWt: 500, totalNetWt: 400 },
} as unknown as QueryLegDto;
const points = [
  { id: "p1", name: "Shanghai PVG", city: "Shanghai", country: "CN" },
  { id: "p2", name: "Dubai DXB", city: "Dubai", country: "AE" },
] as unknown as QueryPointDto[];

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("LegPanel", () => {
  it("defaultDeadlineLocal is +48h from now", () => {
    const s = defaultDeadlineLocal(Date.parse("2026-08-01T10:00:00.000Z"));
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("shows leg summary + status, and reveals the grid when expanded", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} />);
    expect(screen.getByText("Main air leg")).toBeInTheDocument();
    expect(screen.getByText("READY FOR RFQ")).toBeInTheDocument();
    expect(screen.getByText(/Shanghai PVG/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /main air leg/i }));
    expect(await screen.findByText(/Eligible 0/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/web test -- LegPanel`).

- [ ] **Step 3: Create `LegPanel.tsx`** (summary + grid + deadline; the Distribute button/action is a placeholder region filled in Task 7):
```tsx
import { useState } from "react";
import type { QueryLegDto, QueryPointDto, QuoteDto, FreightForwarderDto } from "@svyft/shared";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { LegStatusBadge } from "./statusBadges";
import { FfSelectionGrid } from "./FfSelectionGrid";

interface LegPanelProps {
  queryId: string;
  leg: QueryLegDto;
  points: QueryPointDto[];
  legQuotes: QuoteDto[];
  referencedFfs: FreightForwarderDto[];
}

/** "YYYY-MM-DDTHH:mm" (local) for <input type="datetime-local">, defaulted +48h. */
export function defaultDeadlineLocal(nowMs?: number): string {
  const d = new Date((nowMs ?? Date.now()) + 48 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pointName(points: QueryPointDto[], id: string | null): string {
  if (!id) return "—";
  const p = points.find((x) => x.id === id);
  return p?.name ?? [p?.city, p?.country].filter(Boolean).join(", ") || "—";
}
function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export function LegPanel({ queryId, leg, points, legQuotes, referencedFfs }: LegPanelProps) {
  const [open, setOpen] = useState(true);
  const [deadline, setDeadline] = useState(defaultDeadlineLocal());

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-mono text-xs text-muted-foreground">{leg.legCode}</span>
        <span className="font-medium">{leg.legName ?? "Unnamed leg"}</span>
        {leg.mode && <Badge variant="secondary">{leg.mode}</Badge>}
        <span className="ml-auto"><LegStatusBadge status={leg.status} /></span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-muted-foreground">Origin</dt><dd>{pointName(points, leg.originPointId)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Destination</dt><dd>{pointName(points, leg.destinationPointId)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Ready</dt><dd>{fmtDate(leg.readyDate)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Target delivery</dt><dd>{fmtDate(leg.targetDelivery)}</dd></div>
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-xs text-muted-foreground">Manifest totals</dt>
              <dd>{leg.rollup.totalPackages} pkg · {leg.rollup.totalCbm} CBM · {leg.rollup.totalGrossWt} kg gross · {leg.rollup.totalNetWt} kg net</dd>
            </div>
          </dl>

          <FfSelectionGrid
            queryId={queryId}
            legId={leg.id}
            legQuotes={legQuotes.map((q) => ({ freightForwarderId: q.freightForwarderId, status: q.status }))}
            referencedFfs={referencedFfs}
          />

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
            <div className="space-y-1">
              <Label htmlFor={`deadline-${leg.id}`}>Submission deadline</Label>
              <Input
                id={`deadline-${leg.id}`}
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-56"
              />
            </div>
            {/* Distribute action added in Task 7 */}
            <div data-testid={`distribute-slot-${leg.id}`} />
          </div>
        </div>
      )}
    </Card>
  );
}
```
> Confirm `lucide-react` exports `ChevronDown`/`ChevronRight` (it does — already used across the kit). `Label`/`Input` are existing `@/components/ui/*`.

- [ ] **Step 4: Run — GREEN**, then commit.
```bash
pnpm --filter @svyft/web test -- LegPanel && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
git add apps/web/src/features/rfq-workspace/LegPanel.tsx apps/web/src/features/rfq-workspace/LegPanel.test.tsx
git commit -m "feat(web): leg panel — summary + FF grid + deadline (§7.2.1)"
```

---

## Task 7: Web — Distribute (leg-wise) with gate errors, dup-guard confirm, mint result

**Goal:** Wire the leg-wise Distribute action into `LegPanel`: fire `distribute` with the deadline, render minted RFQ numbers + a copyable portal link (accessToken, once), surface F1/F4/F5 gate errors inline (400 `codes`), and handle the F6 dup-guard (409 → "confirm re-distribute" → resend `confirm:true`).

**Files:**
- Create: `apps/web/src/features/rfq-workspace/DistributeLegAction.tsx`
- Modify: `apps/web/src/features/rfq-workspace/LegPanel.tsx` (mount the action in the distribute slot)
- Test: `apps/web/src/features/rfq-workspace/DistributeLegAction.test.tsx`

**Interfaces:**
- Consumes: `useDistributeLeg`; `ApiError` from `@/lib/api`; `DistributeResult`, `DistributeRfqEntry` from `@svyft/shared`; `Button`, `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter`.
- Produces:
```ts
interface DistributeLegAction Props { queryId: string; legId: string; deadlineLocal: string; canDistribute: boolean; }
export function DistributeLegAction(props): JSX.Element;
export const GATE_CODE_LABEL: Record<string, string>; // F1/F4/F5 → friendly text
export function localToIso(local: string): string | undefined; // datetime-local → ISO (undefined if empty)
```

- [ ] **Step 1: Write the failing test** `DistributeLegAction.test.tsx`. Cover happy mint, 400-codes inline, and 409→confirm→resend:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { DistributeLegAction } from "./DistributeLegAction";

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("DistributeLegAction", () => {
  it("distributes and shows the minted RFQ number", async () => {
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/distribute") && init?.method === "POST")
        return { status: 201, body: { rfqs: [{ freightForwarderId: "a", rfqId: "r1", rfqNumber: "YAL26-0001-RFQ001", minted: true, accessToken: "T".repeat(64), legIds: ["l1"] }], distributedLegIds: ["l1"], skipped: [] } };
      return { status: 404 };
    }));
    wrap(<DistributeLegAction queryId="q1" legId="l1" deadlineLocal="2026-08-01T10:00" canDistribute />);
    await userEvent.click(screen.getByRole("button", { name: /^distribute rfq$/i }));
    expect(await screen.findByText(/YAL26-0001-RFQ001/)).toBeInTheDocument();
  });

  it("renders F1/F4/F5 gate codes inline on 400", async () => {
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/distribute") && init?.method === "POST")
        return { status: 400, body: { message: "Leg is not ready for distribution", codes: ["F1_INCOMPLETE_LEG", "F5_DG_FF_CANNOT_HANDLE"] } };
      return { status: 404 };
    }));
    wrap(<DistributeLegAction queryId="q1" legId="l1" deadlineLocal="2026-08-01T10:00" canDistribute />);
    await userEvent.click(screen.getByRole("button", { name: /^distribute rfq$/i }));
    expect(await screen.findByText(/leg is incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot handle dangerous goods/i)).toBeInTheDocument();
  });

  it("on 409 opens a confirm dialog and resends with confirm:true", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/distribute") && init?.method === "POST") {
        const body = JSON.parse((init.body as string) ?? "{}");
        bodies.push(body);
        if (!body.confirm) return { status: 409, body: { message: "already sent; confirm to proceed." } };
        return { status: 201, body: { rfqs: [], distributedLegIds: [], skipped: [{ legId: "l1", reason: "already-distributed" }] } };
      }
      return { status: 404 };
    }));
    wrap(<DistributeLegAction queryId="q1" legId="l1" deadlineLocal="2026-08-01T10:00" canDistribute />);
    await userEvent.click(screen.getByRole("button", { name: /^distribute rfq$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /re-distribute/i }));
    await waitFor(() => expect(bodies.some((b) => (b as { confirm?: boolean }).confirm === true)).toBe(true));
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/web test -- DistributeLegAction`).

- [ ] **Step 3: Create `DistributeLegAction.tsx`:**
```tsx
import { useState } from "react";
import type { DistributeResult } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { useDistributeLeg } from "./useRfq";

export const GATE_CODE_LABEL: Record<string, string> = {
  F1_INCOMPLETE_LEG: "The leg is incomplete — it needs an origin, destination, mode, cargo and dates before it can be distributed.",
  F4_LEG_NOT_READY: "The leg has unresolved validation issues from Create Query and is not ready for RFQ.",
  F5_DG_FF_CANNOT_HANDLE: "A selected forwarder cannot handle Dangerous Goods, but this leg carries DG cargo.",
};

export function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function extractCodes(err: ApiError): string[] {
  const body = err.body as { codes?: unknown } | undefined;
  return Array.isArray(body?.codes) ? (body!.codes as string[]) : [];
}

interface Props {
  queryId: string;
  legId: string;
  deadlineLocal: string;
  canDistribute: boolean;
}

export function DistributeLegAction({ queryId, legId, deadlineLocal, canDistribute }: Props) {
  const distribute = useDistributeLeg(queryId, legId);
  const [codes, setCodes] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<DistributeResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function run(confirm: boolean) {
    setCodes([]); setMessage(null);
    try {
      const res = await distribute.mutateAsync({ submissionDeadline: localToIso(deadlineLocal), confirm });
      setResult(res);
      setConfirmOpen(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) { setConfirmOpen(true); return; }
        const gate = extractCodes(err);
        if (gate.length) setCodes(gate);
        else setMessage(err.message);
      } else {
        setMessage("Distribution failed. Please try again.");
      }
    }
  }

  return (
    <div className="space-y-2">
      <Button disabled={!canDistribute || distribute.isPending} onClick={() => run(false)}>
        {distribute.isPending ? "Distributing…" : "Distribute RFQ"}
      </Button>

      {codes.length > 0 && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
          {codes.map((c) => (
            <p key={c} className="text-sm text-destructive">{GATE_CODE_LABEL[c] ?? c}</p>
          ))}
        </div>
      )}
      {message && <p role="alert" className="text-sm text-destructive">{message}</p>}

      {result && result.rfqs.length > 0 && (
        <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm">
          {result.rfqs.map((r) => (
            <div key={r.rfqId} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{r.rfqNumber}</span>
              <span className="text-muted-foreground">{r.minted ? "sent" : "updated"}</span>
              {r.accessToken && (
                <Button
                  variant="link" size="sm"
                  onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/ff/rfq/${r.accessToken}`)}
                >
                  Copy portal link
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {result && result.rfqs.length === 0 && result.skipped.length > 0 && (
        <p className="text-sm text-muted-foreground">Nothing new to send (already distributed).</p>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-distribute this RFQ?</DialogTitle>
            <DialogDescription>
              The selected forwarders have already been sent this RFQ. Confirm to re-distribute.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={() => run(true)} disabled={distribute.isPending}>Re-distribute</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Mount the action in `LegPanel.tsx`.** Import it and replace the `distribute-slot` div. Compute `canDistribute` = there is at least one FF selected or already engaged for the leg (fresh `SELECT` present):
```tsx
import { DistributeLegAction } from "./DistributeLegAction";
// ...inside the panel body, replace the slot div:
<DistributeLegAction
  queryId={queryId}
  legId={leg.id}
  deadlineLocal={deadline}
  canDistribute={legQuotes.some((q) => q.status === "SELECT")}
/>
```
> Keep the `LegPanel` test green — the earlier test rendered with `legQuotes={[]}`, so the button renders **disabled**, which is fine (it only asserts summary + expand). If a lint `no-unused` fires on the removed `data-testid` slot, delete that line.

- [ ] **Step 5: Run — GREEN** for both specs.
```bash
pnpm --filter @svyft/web test -- DistributeLegAction LegPanel
```

- [ ] **Step 6: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
git add apps/web/src/features/rfq-workspace/DistributeLegAction.tsx apps/web/src/features/rfq-workspace/DistributeLegAction.test.tsx apps/web/src/features/rfq-workspace/LegPanel.tsx
git commit -m "feat(web): leg-wise distribute — gate errors, dup-guard confirm, mint result"
```

---

## Task 8: Web — Preview RFQ dialog (light, read-only)

**Goal:** A read-only preview of the RFQ package for a leg (leg details + cargo manifest table) as it will appear to the selected FF(s), available **before** the first distribute for that leg (§7.2.2, §13.1). No route diagram (that is §7.3.4 / SB4).

**Files:**
- Create: `apps/web/src/features/rfq-workspace/PreviewRfqDialog.tsx`
- Modify: `apps/web/src/features/rfq-workspace/LegPanel.tsx` (add a "Preview RFQ" trigger when the leg has no sent quote)
- Test: `apps/web/src/features/rfq-workspace/PreviewRfqDialog.test.tsx`

**Interfaces:**
- Consumes: `QueryLegDto`, `QueryPointDto`, `CargoDto` from `@svyft/shared`; `Dialog` family, `Button`.
- Produces:
```ts
interface PreviewRfqDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  leg: QueryLegDto;
  points: QueryPointDto[];
  cargo: CargoDto[];   // full query cargo; filter to leg.assignedCargoIds inside
}
export function PreviewRfqDialog(props): JSX.Element;
```

- [ ] **Step 1: Write the failing test** `PreviewRfqDialog.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QueryLegDto, QueryPointDto, CargoDto } from "@svyft/shared";
import { PreviewRfqDialog } from "./PreviewRfqDialog";

const leg = { id: "l1", legCode: "L1", legName: "Air leg", mode: "AIR",
  originPointId: "p1", destinationPointId: "p2", assignedCargoIds: ["c1"] } as unknown as QueryLegDto;
const points = [{ id: "p1", name: "PVG", country: "CN" }, { id: "p2", name: "DXB", country: "AE" }] as unknown as QueryPointDto[];
const cargo = [
  { id: "c1", poReference: "PO-1", productName: "Pumps", packageType: "CRATE", qty: 4, grossWt: "500", isDangerous: false },
  { id: "c2", poReference: "PO-2", productName: "Other", packageType: "BOX", qty: 1, grossWt: "10", isDangerous: false },
] as unknown as CargoDto[];

describe("PreviewRfqDialog", () => {
  it("renders only the leg's assigned cargo", () => {
    render(<PreviewRfqDialog open onOpenChange={() => {}} leg={leg} points={points} cargo={cargo} />);
    expect(screen.getByText("Pumps")).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
    expect(screen.getByText(/PVG/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/web test -- PreviewRfqDialog`).

- [ ] **Step 3: Create `PreviewRfqDialog.tsx`:**
```tsx
import type { QueryLegDto, QueryPointDto, CargoDto } from "@svyft/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

interface PreviewRfqDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  leg: QueryLegDto;
  points: QueryPointDto[];
  cargo: CargoDto[];
}

function name(points: QueryPointDto[], id: string | null): string {
  const p = id ? points.find((x) => x.id === id) : undefined;
  return p?.name ?? p?.country ?? "—";
}

export function PreviewRfqDialog({ open, onOpenChange, leg, points, cargo }: PreviewRfqDialogProps) {
  const rows = cargo.filter((c) => leg.assignedCargoIds?.includes(c.id));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>RFQ preview — {leg.legName ?? leg.legCode}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {name(points, leg.originPointId)} → {name(points, leg.destinationPointId)}
            {leg.mode ? ` · ${leg.mode}` : ""}
          </p>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-left">
              <thead className="bg-muted text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">PO</th>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">Pkg</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Gross</th>
                  <th className="px-3 py-2 font-medium">DG</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono">{c.poReference}</td>
                    <td className="px-3 py-2">{c.productName}</td>
                    <td className="px-3 py-2">{c.packageType}</td>
                    <td className="px-3 py-2">{c.qty}</td>
                    <td className="px-3 py-2">{c.grossWt}</td>
                    <td className="px-3 py-2">{c.isDangerous ? <Badge variant="destructive">DG</Badge> : "—"}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No cargo assigned to this leg.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Add the trigger to `LegPanel.tsx`.** The panel needs the query cargo to preview — add `cargo: CargoDto[]` to `LegPanelProps` and thread it from `RfqWorkspace` (Task 9). Add local `previewOpen` state + a "Preview RFQ" button shown only when the leg has **no** sent quote (before first distribute):
```tsx
import { PreviewRfqDialog } from "./PreviewRfqDialog";
// props: add `cargo: CargoDto[];`
const [previewOpen, setPreviewOpen] = useState(false);
const hasSent = legQuotes.some((q) => q.status !== "SELECT");
// ...in the deadline/action row, before <DistributeLegAction/>:
{!hasSent && (
  <Button variant="outline" onClick={() => setPreviewOpen(true)}>Preview RFQ</Button>
)}
<PreviewRfqDialog open={previewOpen} onOpenChange={setPreviewOpen} leg={leg} points={points} cargo={cargo} />
```
Update the `LegPanel.test.tsx` render calls to pass `cargo={[]}` (keeps that test green).

- [ ] **Step 5: Run — GREEN** for `PreviewRfqDialog` + `LegPanel`.

- [ ] **Step 6: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
git add apps/web/src/features/rfq-workspace/PreviewRfqDialog.tsx apps/web/src/features/rfq-workspace/PreviewRfqDialog.test.tsx apps/web/src/features/rfq-workspace/LegPanel.tsx apps/web/src/features/rfq-workspace/LegPanel.test.tsx
git commit -m "feat(web): read-only Preview RFQ dialog (§7.2.2)"
```

---

## Task 9: Web — RFQ workspace body (compose + Distribute All)

**Goal:** `RfqWorkspace` loads `QueryDetail` + `rfq-state`, renders the overview header + a leg panel per leg (each hydrated with its own quotes + the referenced FFs), and a page-level **Distribute All** that reports `skipped[]` per leg with reasons (§7.2.2 grid, B7).

**Files:**
- Create: `apps/web/src/features/rfq-workspace/RfqWorkspace.tsx`
- Test: `apps/web/src/features/rfq-workspace/RfqWorkspace.test.tsx`

**Interfaces:**
- Consumes: `useQueryDetail` (from `@/features/query-wizard/useQueryDetail`), `useRfqState`, `useDistributeAll`; `QueryOverviewHeader`, `LegPanel`; `ApiError`.
- Produces: `RfqWorkspace({ queryId: string })`.

- [ ] **Step 1: Write the failing test** `RfqWorkspace.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { RfqWorkspace } from "./RfqWorkspace";

const queryDetail = {
  id: "q1", queryCode: "YAL26-0001", incoterms: "FOB", status: "RFQ_READY",
  freightMode: ["AIR"], origin: [{ id: "p1", name: "PVG", city: "Shanghai", country: "CN" }],
  destination: [{ id: "p2", name: "DXB", city: "Dubai", country: "AE" }], cargo: [], points: [
    { id: "p1", name: "PVG", city: "Shanghai", country: "CN" }, { id: "p2", name: "DXB", city: "Dubai", country: "AE" },
  ],
  legs: [{ id: "l1", legCode: "L1", legName: "Air leg", mode: "AIR", status: "READY_FOR_RFQ",
    originPointId: "p1", destinationPointId: "p2", readyDate: null, targetDelivery: null, assignedCargoIds: [],
    rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 } }],
};

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("RfqWorkspace", () => {
  it("renders header + leg panels and runs Distribute All", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/queries/q1")) return { status: 200, body: queryDetail };
      if (url.includes("/rfq-state")) return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      if (url.includes("/distribute-all") && init?.method === "POST")
        return { status: 201, body: { rfqs: [], distributedLegIds: [], skipped: [{ legId: "l1", reason: "nothing-selected" }] } };
      return { status: 404 };
    }));

    wrap(<RfqWorkspace queryId="q1" />);
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByText("Air leg")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /distribute all/i }));
    expect(await screen.findByText(/L1/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/nothing selected/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/web test -- RfqWorkspace`).

- [ ] **Step 3: Create `RfqWorkspace.tsx`:**
```tsx
import { useState } from "react";
import type { DistributeResult } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import { Button } from "@/components/ui/button";
import { useRfqState, useDistributeAll } from "./useRfq";
import { QueryOverviewHeader } from "./QueryOverviewHeader";
import { LegPanel } from "./LegPanel";

const SKIP_REASON_LABEL: Record<string, string> = {
  "nothing-selected": "nothing selected",
  "already-distributed": "already distributed",
};
function skipLabel(reason: string): string {
  return SKIP_REASON_LABEL[reason] ?? reason.replace(/_/g, " ").toLowerCase();
}

export function RfqWorkspace({ queryId }: { queryId: string }) {
  const query = useQueryDetail(queryId);
  const rfqState = useRfqState(queryId);
  const distributeAll = useDistributeAll(queryId);
  const [allResult, setAllResult] = useState<DistributeResult | null>(null);
  const [allError, setAllError] = useState<string | null>(null);

  if (query.isLoading || rfqState.isLoading) return <p className="text-sm text-muted-foreground">Loading workspace…</p>;
  if (query.isError || !query.data) return <p className="text-sm text-destructive">Failed to load the query.</p>;

  const q = query.data;
  const quotes = rfqState.data?.quotes ?? [];
  const referencedFfs = rfqState.data?.freightForwarders ?? [];
  const legCodeById = new Map(q.legs.map((l) => [l.id, l.legCode]));

  async function runDistributeAll() {
    setAllError(null);
    try {
      setAllResult(await distributeAll.mutateAsync({}));
    } catch (err) {
      setAllError(err instanceof ApiError ? err.message : "Distribute all failed.");
    }
  }

  return (
    <div className="space-y-5">
      <QueryOverviewHeader query={q} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">RFQ distribution</h2>
        <Button variant="secondary" onClick={runDistributeAll} disabled={distributeAll.isPending}>
          {distributeAll.isPending ? "Distributing…" : "Distribute All"}
        </Button>
      </div>

      {allError && <p role="alert" className="text-sm text-destructive">{allError}</p>}
      {allResult && (
        <div className="rounded-md border border-border bg-card p-3 text-sm">
          {allResult.distributedLegIds.length > 0 && (
            <p className="text-success">Distributed {allResult.distributedLegIds.length} leg(s).</p>
          )}
          {allResult.skipped.map((s) => (
            <p key={s.legId} className="text-muted-foreground">
              {legCodeById.get(s.legId) ?? s.legId}: skipped — {skipLabel(s.reason)}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {q.legs.map((leg) => (
          <LegPanel
            key={leg.id}
            queryId={queryId}
            leg={leg}
            points={q.points}
            cargo={q.cargo}
            legQuotes={quotes.filter((qt) => qt.legId === leg.id)}
            referencedFfs={referencedFfs}
          />
        ))}
        {q.legs.length === 0 && (
          <p className="text-sm text-muted-foreground">This query has no legs yet — add legs in the Create stage first.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run — GREEN** (`pnpm --filter @svyft/web test -- RfqWorkspace`).

- [ ] **Step 5: typecheck + lint + commit.**
```bash
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
git add apps/web/src/features/rfq-workspace/RfqWorkspace.tsx apps/web/src/features/rfq-workspace/RfqWorkspace.test.tsx
git commit -m "feat(web): RFQ workspace body — compose header + leg panels + Distribute All"
```

---

## Task 10: Web — Stage rail + Workspace hub + routing + wizard entry (B9)

**Goal:** Ship the `/queries/:id/workspace` hub (Query Workspace) with a shared `StageRail` (Create ↔ RFQ), wire the route, and add the rail atop the existing wizard for existing queries so the two stages read as one hub. The RFQ stage is enabled only when the query is ≥ RFQ_READY.

**Files:**
- Create: `apps/web/src/features/rfq-workspace/StageRail.tsx`
- Create: `apps/web/src/features/rfq-workspace/QueryWorkspaceHub.tsx`
- Modify: `apps/web/src/App.tsx` (add the route)
- Modify: `apps/web/src/features/query-wizard/QueryWizardPage.tsx` (additive rail for existing queries)
- Test: `apps/web/src/features/rfq-workspace/StageRail.test.tsx`, `apps/web/src/features/rfq-workspace/QueryWorkspaceHub.test.tsx`

**Interfaces:**
- Consumes: `Link` from `react-router-dom`; `useParams`; `useQueryDetail`; `RfqWorkspace`; `QueryStatus`/`QUERY_STATUSES` from `@svyft/shared`; `cn`.
- Produces:
```ts
export function isRfqStageEnabled(status: string): boolean; // status rank ≥ RFQ_READY
interface StageRailProps { queryId: string; active: "create" | "rfq"; rfqEnabled: boolean; }
export function StageRail(props): JSX.Element;
export function QueryWorkspaceHub(): JSX.Element; // reads :id, renders StageRail(active=rfq) + RfqWorkspace
```

- [ ] **Step 1: Write the failing tests.**

`StageRail.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StageRail, isRfqStageEnabled } from "./StageRail";

describe("StageRail", () => {
  it("computes RFQ-stage enablement from status rank", () => {
    expect(isRfqStageEnabled("DRAFT")).toBe(false);
    expect(isRfqStageEnabled("CREATED")).toBe(false);
    expect(isRfqStageEnabled("RFQ_READY")).toBe(true);
    expect(isRfqStageEnabled("RFQ_SENT")).toBe(true);
    expect(isRfqStageEnabled("QUOTED")).toBe(true);
  });

  it("links Create to the wizard and RFQ to the workspace when enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="create" rfqEnabled />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
    expect(screen.getByRole("link", { name: /rfq/i })).toHaveAttribute("href", "/queries/q1/workspace");
  });

  it("disables the RFQ stage (no link) when not enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="create" rfqEnabled={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /rfq/i })).not.toBeInTheDocument();
    expect(screen.getByText(/rfq/i)).toBeInTheDocument();
  });
});
```

`QueryWorkspaceHub.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { Routes, Route } from "react-router-dom";
import { QueryWorkspaceHub } from "./QueryWorkspaceHub";

afterEach(() => vi.unstubAllGlobals());

describe("QueryWorkspaceHub", () => {
  it("renders the rail + RFQ workspace for the routed query id", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.endsWith("/api/queries/q1"))
        return { status: 200, body: { id: "q1", queryCode: "YAL26-0001", status: "RFQ_READY",
          incoterms: "FOB", freightMode: [], origin: [], destination: [], cargo: [], points: [], legs: [] } };
      if (url.includes("/rfq-state")) return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      return { status: 404 };
    }));
    renderWithProviders(
      <Routes><Route path="/queries/:id/workspace" element={<QueryWorkspaceHub />} /></Routes>,
      { route: "/queries/q1/workspace", user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } },
    );
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
  });
});
```

- [ ] **Step 2: Run — RED** (`pnpm --filter @svyft/web test -- StageRail QueryWorkspaceHub`).

- [ ] **Step 3: Create `StageRail.tsx`:**
```tsx
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const RANK: Record<string, number> = {
  DRAFT: 0, CREATED: 1, RFQ_READY: 2, RFQ_SENT: 3, QUOTED: 4,
  AWAITING_CLIENT_DECISION: 5, WON: 6, LOST: 6, CLOSED: 7,
};
export function isRfqStageEnabled(status: string): boolean {
  return (RANK[status] ?? 0) >= RANK.RFQ_READY;
}

interface StageRailProps {
  queryId: string;
  active: "create" | "rfq";
  rfqEnabled: boolean;
}

export function StageRail({ queryId, active, rfqEnabled }: StageRailProps) {
  const base = "rounded-md px-3 py-1.5 text-sm font-medium transition-colors";
  const on = "bg-primary text-primary-foreground";
  const off = "text-muted-foreground hover:bg-muted";
  return (
    <nav aria-label="Query stages" className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
      <Link to={`/queries/${queryId}`} className={cn(base, active === "create" ? on : off)}>
        Create
      </Link>
      {rfqEnabled ? (
        <Link to={`/queries/${queryId}/workspace`} className={cn(base, active === "rfq" ? on : off)}>
          RFQ
        </Link>
      ) : (
        <span className={cn(base, "cursor-not-allowed text-muted-foreground/50")} aria-disabled="true">
          RFQ
        </span>
      )}
      <span className={cn(base, "cursor-not-allowed text-muted-foreground/40")} aria-disabled="true">Quotes</span>
      <span className={cn(base, "cursor-not-allowed text-muted-foreground/40")} aria-disabled="true">Award</span>
    </nav>
  );
}
```

- [ ] **Step 4: Create `QueryWorkspaceHub.tsx`:**
```tsx
import { useParams } from "react-router-dom";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import { StageRail, isRfqStageEnabled } from "./StageRail";
import { RfqWorkspace } from "./RfqWorkspace";

export function QueryWorkspaceHub() {
  const { id } = useParams<{ id: string }>();
  const { data: query, isLoading, isError } = useQueryDetail(id);

  if (!id) return <p className="text-sm text-destructive">Missing query id.</p>;
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !query) return <p className="text-sm text-destructive">Failed to load the query.</p>;

  return (
    <div className="space-y-4">
      <StageRail queryId={id} active="rfq" rfqEnabled={isRfqStageEnabled(query.status)} />
      <RfqWorkspace queryId={id} />
    </div>
  );
}
```

- [ ] **Step 5: Wire the route in `App.tsx`.** Add the import and the route (place it **before** `/queries/:id` is not required — React Router v6 matches by specificity, but keep it grouped with the query routes):
```tsx
import { QueryWorkspaceHub } from "@/features/rfq-workspace/QueryWorkspaceHub";
// ...inside <Routes>, alongside the other /queries routes:
<Route
  path="/queries/:id/workspace"
  element={
    <Protected>
      <QueryWorkspaceHub />
    </Protected>
  }
/>
```

- [ ] **Step 6: Add the rail atop the wizard for existing queries.** In `apps/web/src/features/query-wizard/QueryWizardPage.tsx`, render `<StageRail active="create" .../>` when editing an existing query (an `id` param exists) using the loaded query status. Insert a single block near the top of the page's returned JSX (above the wizard shell). Use the wizard's existing query detail/status source (`WizardContext.detail` or the page's `useParams().id` + `useQueryDetail`). Minimal shape:
```tsx
import { useParams } from "react-router-dom";
import { StageRail, isRfqStageEnabled } from "@/features/rfq-workspace/StageRail";
// ...within the component, where the existing query id + detail are available:
{id && detail && (
  <div className="mb-4">
    <StageRail queryId={id} active="create" rfqEnabled={isRfqStageEnabled(detail.status)} />
  </div>
)}
```
> Read `QueryWizardPage.tsx` first and adapt to how it already exposes the id + loaded query (it hydrates `WizardProvider` from a detail). Do **not** restructure the wizard — this is one conditional block + two imports. If the wizard has no existing-query status in scope at that point, gate the rail on `id` only and pass `rfqEnabled={isRfqStageEnabled(detail?.status ?? "DRAFT")}`.

- [ ] **Step 7: Run — GREEN** for the new specs **and** the wizard's existing tests (the additive rail must not break them):
```bash
pnpm --filter @svyft/web test -- StageRail QueryWorkspaceHub QueryWizardPage
```

- [ ] **Step 8: Full web verify + commit.**
```bash
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint && pnpm --filter @svyft/web test
git add apps/web/src/features/rfq-workspace/StageRail.tsx apps/web/src/features/rfq-workspace/StageRail.test.tsx apps/web/src/features/rfq-workspace/QueryWorkspaceHub.tsx apps/web/src/features/rfq-workspace/QueryWorkspaceHub.test.tsx apps/web/src/App.tsx apps/web/src/features/query-wizard/QueryWizardPage.tsx
git commit -m "feat(web): query workspace hub + stage rail + route (B9)"
```

---

## Final verification (before PR)

- [ ] **V1.** Rebuild shared, then run the full matrix (both packages):
```bash
pnpm --filter @svyft/shared build
pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint && pnpm --filter @svyft/web test
pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/api lint && pnpm --filter @svyft/api test -- rfq
```
All green, and the api jest process **exits**.
- [ ] **V2.** Manual smoke (optional but recommended): `pnpm --filter @svyft/web dev` + api running; open an RFQ-Ready query → RFQ stage → select FFs → Distribute → confirm the leg/query badges advance after the re-GET; reload and confirm the grid still shows the sent FFs (proves the `rfq-state` hydration).
- [ ] **V3.** **opus** whole-branch review (per the Stage-4 workflow), then open the PR (`feat/stage-4-sb3` → `main`) and watch CI: `gh pr checks <n> --watch` — do not assume green.

---

## Self-Review (author checklist — done while writing)

1. **Spec coverage:**
   - §7.1 Query Overview Header → Task 4. §7.2.1 Leg summary → Task 6. §7.2.2 FF grid (eligible list, selection, Selected/Eligible counts, frozen read-only, per-FF status, deadline, Preview, Distribute, E1 broaden) → Tasks 5–8. §9 status display (leg + rollup, forwarder status) → Tasks 3–4, via re-GET. §10 validation (F1/F4/F5 inline, F6 confirm, E1) → Tasks 5, 7. §13.1 form actions (Select, Preview RFQ, Distribute, broaden) → Tasks 5, 7, 8. B7 Distribute All → Task 9. B9 hub + stage rail → Task 10. Read-state gap → Task 1.
   - **Deliberately deferred:** §7.3.4 scoped route diagram (SB4); live emails (SB5); client-company name in the header (needs a join — noted).
2. **Placeholder scan:** every code step ships real code; no "add validation"/"similar to Task N" placeholders.
3. **Type consistency:** hook names (`useRfqState`/`useEligibleFfs`/`useSetFfSelection`/`useDistributeLeg`/`useDistributeAll`), the `QueryRfqStateDto` shape (`quotes`/`rfqs`/`freightForwarders`), gate codes (`F1_INCOMPLETE_LEG`/`F4_LEG_NOT_READY`/`F5_DG_FF_CANNOT_HANDLE`), and skip reasons (`nothing-selected`/`already-distributed`) are used identically across the backend contract (Task 1 / verified against the merged `rfq.service.ts` + `rfq.controller.ts`) and every consuming component. `FreightForwarderDto`/`QuoteDto`/`RfqDto`/`QueryDetail`/`QueryLegDto` field names match `packages/shared/src/{masters,rfq,query}.ts`.
