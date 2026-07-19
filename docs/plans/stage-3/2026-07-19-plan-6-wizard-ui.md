# Plan 6 — Wizard & Query List UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Stage-3 frontend in `apps/web` — the All-Records Query List, the 5-step Create-Query wizard, and the leg/route builder with a live route diagram — as the client for the already-built Plan 1–5 API, plus the one missing backend piece (`GET /queries`).

**Architecture:** A thin, typed fetch client (`@/lib/api`) over the `/api` REST surface; TanStack Query for server cache; TanStack Table for the list; React Hook Form + `@svyft/shared` Zod schemas for forms; one `<FindingsPanel>` rendering `Finding[]` from client `validateRoute` and server 422/validate; a bespoke SVG `RouteDiagram` driven by the isomorphic `validateRoute`. A single design-language pass (frontend-design skill) produces app-wide shadcn CSS-variable theme tokens before any component is built.

**Tech Stack:** Vite · React 18 · TypeScript · Tailwind + shadcn/ui · TanStack Query 5 · TanStack Table 8 · React Hook Form 7 + `@hookform/resolvers` · React Router 6 · `react-day-picker` + `date-fns` · `cmdk` · `@radix-ui/*`. Backend delta: NestJS + Prisma. Shared: `@svyft/shared` (Zod + types + `validateRoute`).

## Global Constraints

- **Monorepo:** pnpm workspaces. Run all commands from the repo root unless a task says otherwise. `pnpm --filter @svyft/web ...`, `pnpm --filter @svyft/api ...`, `pnpm --filter @svyft/shared ...`.
- **`@svyft/shared` is the single source of truth** for Zod schemas, DTO types, enums, and `validateRoute`. Never redefine a schema/enum/type that exists there — import it. New shared enums use the repo idiom: `const` object + `(typeof X)[keyof typeof X]` union + companion `Object.values(...) as [X, ...X[]]` array pinned by a `toEqual` test. **Never a TS `enum`.**
- **API:** global prefix `/api`. Auth is httpOnly-cookie JWT → every request sends cookies. The `@/lib/api` helpers already set `credentials: "include"`; use them, never raw `fetch`.
- **Two error envelopes:** Zod validation failures return **400** `{ message: "Validation failed", issues: ZodIssue[] }`; domain/route failures (Create-Query gate, leg V-M1) return **422** `{ findings: Finding[] }`. Handle both distinctly (Task 3).
- **Dates:** API accepts/returns ISO 8601 **with offset** (`z.string().datetime({ offset: true })`). Prisma `Decimal` columns (`dimL/dimW/dimH/netWt/grossWt/volumeCbm/...`) serialize to **strings** over JSON — coerce with `Number(...)` before math or display.
- **RBAC:** the Query List and the wizard are open to **all authenticated roles** (Executive is the base; Manager/Administrator inherit). No new route-level role gate. The Query Date field is editable **only when `user.role === Role.ADMINISTRATOR`** (the API returns 403 otherwise) — disable it in the UI for non-admins.
- **Design:** every UI task **invokes the `frontend-design` skill**, derives all color/type/spacing from the Task 1 token system, and ends with a **screenshot self-critique** using the Preview tools (`preview_start` → `preview_screenshot` / `preview_inspect`). No literal hex in components — use the theme tokens.
- **shadcn:** `apps/web/components.json` already exists. Add primitives with `pnpm --filter @svyft/web dlx shadcn@latest add <name>` (or `npx`), then reconcile to the token theme. Existing four primitives (`badge/button/input/label`) stay working.
- **Testing (TDD, non-negotiable):** write the failing test first, watch it fail, implement minimally, watch it pass, commit.
  - Web: Vitest + jsdom (`globals: true`); mock the network with `mockFetch` from `@/test/mock-fetch` via `vi.stubGlobal("fetch", …)` + `afterEach(vi.unstubAllGlobals)`; render through the shared `renderWithProviders` helper (Task 3). Run: `pnpm --filter @svyft/web test`.
  - API: Jest e2e, **seed-independent + self-cleaning** (each test seeds its own reference data + owns its rows by a unique prefix; a Query delete cascades points/legs/legCargo/cargo/checklist). Use a **UUID** jwt `sub`. Before pushing, verify against a reset DB: `pnpm --filter @svyft/api exec prisma migrate reset --schema ../../prisma/schema.prisma --force --skip-seed` then `pnpm run ci`.
- **Commits:** frequent, one per task-slice, Conventional Commits (`feat(web): …`, `feat(api): …`, `feat(shared): …`, `test(web): …`, `chore(web): …`). End every commit message with the repo's `Co-Authored-By` trailer per the harness rule.
- **Branch:** all work on `feat/plan-6-wizard-ui` off `main`. The plan doc ships in the same PR as the implementation.

---

## File Structure

**Backend + shared (Task 0):**
- `packages/shared/src/query.ts` — ADD `QueryListRow`, `QueryDetail` (+ `QueryLegDto`, `LegRollup`, `QueryPointDto`, `QueryChecklistItemDto`, `QueryFileDto`, `PointRef`), `queryListQuerySchema` / `QueryListParams`. Keep the existing `querySaveSchema`/`checklistPatchSchema`.
- `packages/shared/src/findings.ts` — ADD `dedupeFindings(findings): Finding[]`.
- `packages/shared/src/index.ts` — ensure the new names are exported (barrel already re-exports each module).
- `apps/api/src/modules/queries/queries.service.ts` — ADD `list(params): Promise<Paginated<QueryListRow>>`.
- `apps/api/src/modules/queries/queries.controller.ts` — ADD `GET /` (`list`).
- `apps/api/test/queries-list.e2e-spec.ts` — NEW e2e suite.

**Frontend platform (Tasks 1–3):**
- `apps/web/src/index.css`, `apps/web/tailwind.config.ts` — shadcn CSS-variable theme tokens (Task 1).
- `apps/web/src/components/ui/{table,select,checkbox,textarea,form,dialog,dropdown-menu,popover,tooltip,separator,card,calendar,command}.tsx` — shadcn primitives (Task 2).
- `apps/web/src/components/ui/stepper.tsx` — bespoke stepper (Task 2).
- `apps/web/src/components/ui/data-table.tsx` — TanStack Table wrapper (Task 2).
- `apps/web/src/lib/api.ts` — ADD `del`, `ApiError` (Task 3).
- `apps/web/src/lib/dates.ts` — display/format helpers (Task 3).
- `apps/web/src/components/FindingsPanel.tsx` — one findings renderer (Task 3).
- `apps/web/src/test/renderWithProviders.tsx` — shared test render (Task 3).

**Query List (Task 4):**
- `apps/web/src/features/query-list/useQueries.ts` — list hook.
- `apps/web/src/features/query-list/columns.tsx` — TanStack column defs.
- `apps/web/src/features/query-list/QueriesToolbar.tsx` — search + filters.
- `apps/web/src/features/query-list/QueriesListPage.tsx` — page.

**Wizard (Tasks 5–13):**
- `apps/web/src/features/query-wizard/useQueryDetail.ts` — detail query + the mutation hooks (query/cargo/points/legs/checklist/create).
- `apps/web/src/features/query-wizard/WizardContext.tsx` — wizard state (loaded `QueryDetail`, current step, dirty tracking).
- `apps/web/src/features/query-wizard/WizardShell.tsx` — header + stepper + body slot + action bar + findings panel.
- `apps/web/src/features/query-wizard/QueryWizardPage.tsx` — route entry (`/queries/new`, `/queries/:id`), wires context + steps.
- `apps/web/src/features/query-wizard/steps/Step1Client.tsx`, `Step2Shipment.tsx`, `Step3Cargo.tsx`, `Step5Notes.tsx`.
- `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx`, `LegEditor.tsx`, `PointEditor.tsx`, `CargoAssignmentControl.tsx`, `RouteDiagram.tsx`, `routeGraph.ts` (assemble `RouteGraph` from `QueryDetail`).
- `apps/web/src/features/query-wizard/steps/Step1Client` uses pickers: `apps/web/src/features/query-wizard/pickers/ClientPicker.tsx`, `VesselPicker.tsx`.

**Wiring + polish (Tasks 4, 14):**
- `apps/web/src/App.tsx` — routes (`/queries`, `/queries/new`, `/queries/:id`); `/` → redirect `/queries`.
- `apps/web/src/components/AppLayout.tsx` — nav link "Queries"; widen `<main>` for the table/wizard.
- `apps/web/src/features/{masters,auth,home,admin}/**` — light polish to the new tokens (Task 14).

---

## Task 0: Backend — `GET /queries` list endpoint + shared response types

**Files:**
- Modify: `packages/shared/src/query.ts`
- Modify: `packages/shared/src/index.ts` (only if it lists names explicitly; if it does `export * from "./query"`, no change)
- Modify: `apps/api/src/modules/queries/queries.service.ts`
- Modify: `apps/api/src/modules/queries/queries.controller.ts`
- Test: `apps/api/test/queries-list.e2e-spec.ts` (new); `packages/shared/src/query.test.ts` (extend)

**Interfaces:**
- Consumes: existing `Paginated<T>` (`@svyft/shared`), `FreightMode`, `Priority`, `QueryStatus`, `CargoDto`, `ZodValidationPipe`, `@CurrentUser()`/`RequestUser`, the existing `shapeQuery` mapper in `queries.service.ts`.
- Produces (later tasks import these from `@svyft/shared`):
  - `type QueryListRow = { id: string; queryCode: string; queryDate: string; customerName: string | null; contactName: string | null; shipmentDescription: string | null; freightMode: FreightMode[]; origin: string; destination: string; responseDeadline: string | null; priority: Priority; status: QueryStatus; assignedUserId: string | null; assignedUserName: string | null; updatedAt: string }` (the service resolves `assignedUserName` via a batched `user.findMany` since `assignedUserId` is a soft ref with no relation)
  - `type PointRef = { id: string; name: string | null; city: string | null; country: string | null }`
  - `type LegRollup = { totalPackages: number; totalCbm: number; totalGrossWt: number; totalNetWt: number }`
  - `type QueryLegDto = { id: string; legCode: string; legName: string | null; originPointId: string | null; destinationPointId: string | null; mode: FreightMode | null; readyDate: string | null; targetDelivery: string | null; status: LegStatus; executionStatus: LegExecutionStatus; totalChargeableWeight: string | null; assignedCargoIds: string[]; rollup: LegRollup }`
  - `type QueryPointDto` = every `Point` column (id, type, name, streetAddress, city, postalCode, country, contactName, contactPhone, contactEmail, warehouseType, iataCode, icaoCode, unLocode, terminal — strings or null).
  - `type QueryChecklistItemDto = { id: string; itemKey: string; checked: boolean }`
  - `type QueryFileDto = { id: string; kind: string; filename: string; mime: string; sizeBytes: number; uploadedById: string | null; createdAt: string }`
  - `type QueryDetail` = all `Query` columns (as returned by `shapeQuery`) **plus** `cargo: CargoDto[]; checklist: QueryChecklistItemDto[]; files: QueryFileDto[]; points: QueryPointDto[]; legs: QueryLegDto[]; freightMode: FreightMode[]; origin: PointRef[]; destination: PointRef[]`.
  - `queryListQuerySchema` / `type QueryListParams = { q?: string; status?: QueryStatus; priority?: Priority; assignedUserId?: string; freightMode?: string; country?: string; dateField?: "queryDate" | "updatedAt"; dateFrom?: string; dateTo?: string; sort?: string; page?: number; pageSize?: number }`
  - `QueriesService.list(params: QueryListParams): Promise<Paginated<QueryListRow>>`

- [ ] **Step 1: Write the failing shared-type test**

Add to `packages/shared/src/query.test.ts`:

```ts
import { queryListQuerySchema } from "./query";

describe("queryListQuerySchema", () => {
  it("coerces page/pageSize and passes through filters", () => {
    const parsed = queryListQuerySchema.parse({
      q: "YAL26", status: "DRAFT", priority: "HIGH",
      freightMode: "SEA,ROAD", page: "2", pageSize: "25", sort: "updatedAt:desc",
    });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(25);
    expect(parsed.status).toBe("DRAFT");
    expect(parsed.freightMode).toBe("SEA,ROAD");
  });

  it("defaults page=1 pageSize=20 when omitted", () => {
    const parsed = queryListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm --filter @svyft/shared test -- query.test.ts`
Expected: FAIL — `queryListQuerySchema` is not exported.

- [ ] **Step 3: Add the schema + types to `packages/shared/src/query.ts`**

```ts
import { z } from "zod";
import { PRIORITIES, QUERY_STATUSES } from "./status"; // if Priority/PRIORITIES live in query.ts already, import locally instead
import type { FreightMode } from "./config";
import type { CargoDto } from "./cargo";
import type { LegStatus, LegExecutionStatus } from "./status"; // LegExecutionStatus is in legs.ts — import from correct module

export const queryListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(QUERY_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignedUserId: z.string().uuid().optional(),
  freightMode: z.string().optional(),      // single value or CSV, split in the service
  country: z.string().trim().min(1).optional(),
  dateField: z.enum(["queryDate", "updatedAt"]).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  sort: z.string().optional(),             // "<column>:<asc|desc>"
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type QueryListParams = z.infer<typeof queryListQuerySchema>;

export type PointRef = { id: string; name: string | null; city: string | null; country: string | null };
export type LegRollup = { totalPackages: number; totalCbm: number; totalGrossWt: number; totalNetWt: number };
export type QueryListRow = {
  id: string; queryCode: string; queryDate: string;
  customerName: string | null; contactName: string | null; shipmentDescription: string | null;
  freightMode: FreightMode[]; origin: string; destination: string;
  responseDeadline: string | null; priority: (typeof PRIORITIES)[number];
  status: (typeof QUERY_STATUSES)[number]; assignedUserId: string | null; assignedUserName: string | null; updatedAt: string;
};
// QueryLegDto, QueryPointDto, QueryChecklistItemDto, QueryFileDto, QueryDetail per the Interfaces block above.
```

Notes for the implementer:
- Confirm where `Priority`/`PRIORITIES` and `Incoterms` actually live (they are in `query.ts` per the contract map — if so, don't re-import, reference locally). `FreightMode` is in `config.ts`; `LegStatus`/`QueryStatus` in `status.ts`; `LegExecutionStatus` in `legs.ts`; `CargoDto` in `cargo.ts`.
- Write out `QueryLegDto`, `QueryPointDto`, `QueryChecklistItemDto`, `QueryFileDto`, `QueryDetail` in full as typed above (they are display types — no Zod needed).
- Delete the old stub `QueryDto` only if nothing imports it; otherwise leave it and add the new types alongside.

- [ ] **Step 4: Run the shared test, confirm pass**

Run: `pnpm --filter @svyft/shared test -- query.test.ts`
Expected: PASS. Then `pnpm --filter @svyft/shared build` to confirm types compile.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/query.ts packages/shared/src/query.test.ts
git commit -m "feat(shared): add QueryListRow/QueryDetail types + queryListQuerySchema"
```

- [ ] **Step 6: Write the failing e2e test for `GET /queries`**

Create `apps/api/test/queries-list.e2e-spec.ts`, following the existing query e2e pattern (seed-independent, unique prefix, UUID jwt sub, self-cleaning in `afterAll`). Cover:

```ts
// Setup: seedReferenceData(); create a client; sign a UUID-sub jwt.
// Create 3 queries via POST /api/queries with a unique shipmentDescription prefix "P6LIST-".
//   Q1: priority HIGH, status DRAFT, no legs.
//   Q2: add a SEA leg (Pickup+Seaport points) so freightMode=[SEA]; set contactName "Alice".
//   Q3: priority LOW.

it("lists queries with pagination envelope", async () => {
  const res = await request(app.getHttpServer())
    .get("/api/queries?pageSize=2&sort=queryDate:asc")
    .set("Cookie", authCookie).expect(200);
  expect(res.body).toMatchObject({ total: expect.any(Number), page: 1, pageSize: 2 });
  expect(Array.isArray(res.body.items)).toBe(true);
  expect(res.body.items[0]).toHaveProperty("queryCode");
  expect(res.body.items[0]).toHaveProperty("freightMode");
});

it("searches across queryCode/contact/description", async () => {
  const res = await request(app.getHttpServer())
    .get("/api/queries?q=Alice").set("Cookie", authCookie).expect(200);
  expect(res.body.items.some((r) => r.contactName === "Alice")).toBe(true);
});

it("filters by priority and by derived freightMode", async () => {
  const high = await request(app.getHttpServer())
    .get("/api/queries?priority=HIGH&q=P6LIST-").set("Cookie", authCookie).expect(200);
  expect(high.body.items.every((r) => r.priority === "HIGH")).toBe(true);
  const sea = await request(app.getHttpServer())
    .get("/api/queries?freightMode=SEA&q=P6LIST-").set("Cookie", authCookie).expect(200);
  expect(sea.body.items.every((r) => r.freightMode.includes("SEA"))).toBe(true);
});

it("401s without auth", () =>
  request(app.getHttpServer()).get("/api/queries").expect(401));
```

- [ ] **Step 7: Run it, confirm it fails**

Run: `pnpm --filter @svyft/api test:e2e -- queries-list`
Expected: FAIL — `GET /api/queries` returns 404 (route not defined).

- [ ] **Step 8: Implement `QueriesService.list`**

In `queries.service.ts`, add:

```ts
async list(params: QueryListParams): Promise<Paginated<QueryListRow>> {
  const { q, status, priority, assignedUserId, freightMode, country, dateField, dateFrom, dateTo, sort, page, pageSize } = params;
  const modes = freightMode ? freightMode.split(",").map((m) => m.trim()).filter(Boolean) : undefined;

  const where: Prisma.QueryWhereInput = {
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(assignedUserId ? { assignedUserId } : {}),
    ...(q ? { OR: [
      { queryCode: { contains: q, mode: "insensitive" } },
      { contactName: { contains: q, mode: "insensitive" } },
      { shipmentDescription: { contains: q, mode: "insensitive" } },
      { client: { companyName: { contains: q, mode: "insensitive" } } },
    ] } : {}),
    ...(dateFrom || dateTo ? {
      [dateField ?? "updatedAt"]: {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo) } : {}),
      },
    } : {}),
    ...(modes && modes.length ? { legs: { some: { mode: { in: modes as FreightMode[] } } } } : {}),
    ...(country ? { points: { some: { country: { equals: country, mode: "insensitive" }, type: { in: ["PICKUP", "DELIVERY"] } } } } : {}),
  };

  const orderBy = this.parseSort(sort); // default { updatedAt: "desc" }; whitelist columns
  const [total, rows] = await this.prisma.$transaction([
    this.prisma.query.count({ where }),
    this.prisma.query.findMany({
      where, orderBy, skip: (page - 1) * pageSize, take: pageSize,
      include: {
        client: { select: { companyName: true } },
        legs: { select: { mode: true } },
        points: { select: { type: true, name: true, city: true, country: true } },
      },
    }),
  ]);
  return { items: rows.map(this.toListRow), total, page, pageSize };
}

private parseSort(sort?: string): Prisma.QueryOrderByWithRelationInput {
  const allowed = new Set(["queryCode", "queryDate", "responseDeadline", "priority", "status", "updatedAt"]);
  if (!sort) return { updatedAt: "desc" };
  const [col, dir] = sort.split(":");
  if (!allowed.has(col)) return { updatedAt: "desc" };
  return { [col]: dir === "asc" ? "asc" : "desc" } as Prisma.QueryOrderByWithRelationInput;
}

private toListRow = (row: /* the include shape above */ any): QueryListRow => {
  const modes = [...new Set(row.legs.map((l) => l.mode).filter(Boolean))]
    .sort((a, b) => ["ROAD", "AIR", "SEA"].indexOf(a) - ["ROAD", "AIR", "SEA"].indexOf(b)) as FreightMode[];
  const label = (p: { name: string | null; city: string | null; country: string | null }) =>
    [p.city, p.country].filter(Boolean).join(", ") || p.name || "";
  const origin = row.points.filter((p) => p.type === "PICKUP").map(label).join(" · ");
  const destination = row.points.filter((p) => p.type === "DELIVERY").map(label).join(" · ");
  return {
    id: row.id, queryCode: row.queryCode, queryDate: row.queryDate.toISOString(),
    customerName: row.client?.companyName ?? null, contactName: row.contactName, shipmentDescription: row.shipmentDescription,
    freightMode: modes, origin, destination,
    responseDeadline: row.responseDeadline?.toISOString() ?? null, priority: row.priority,
    status: row.status, assignedUserId: row.assignedUserId, updatedAt: row.updatedAt.toISOString(),
  };
};
```

Implementer notes: confirm the `Query` model has a `client` relation and a `points`/`legs` relation name (check `schema.prisma`); adjust `include` keys to the real relation names. If `client` relation is absent, add search-by-customer via a separate `Client` lookup or a raw filter — but the relation almost certainly exists (Query has `clientId` FK).

- [ ] **Step 9: Add the controller route**

In `queries.controller.ts`, above `@Get(":id")`:

```ts
@Get()
list(@Query(new ZodValidationPipe(queryListQuerySchema)) params: QueryListParams): Promise<Paginated<QueryListRow>> {
  return this.queries.list(params);
}
```

Ensure `@Get()` is declared **before** `@Get(":id")` so `/queries` doesn't match the `:id` route.

- [ ] **Step 10: Run the e2e suite, confirm pass**

Run: `pnpm --filter @svyft/api test:e2e -- queries-list`
Expected: PASS (all four tests).

- [ ] **Step 11: Full CI gate + commit**

Run: `pnpm run ci` (from repo root). Expected: lint + typecheck + all tests pass.

```bash
git add packages/shared/src/query.ts apps/api/src/modules/queries/queries.service.ts \
        apps/api/src/modules/queries/queries.controller.ts apps/api/test/queries-list.e2e-spec.ts
git commit -m "feat(api): add GET /queries list endpoint (search/filter/sort/paginate + derived fields)"
```

---

## Task 1: Design language + app-wide theme tokens

> **Design-led task.** Invoke `frontend-design`. This produces the visual system every later task derives from, so it has a **user-preview checkpoint** before Task 4. It is not pure TDD — the "test" is a build + a rendered screenshot review.

**Files:**
- Modify: `apps/web/src/index.css` (CSS-variable token block, both light + dark)
- Modify: `apps/web/tailwind.config.ts` (map tokens → Tailwind theme)
- Modify: `apps/web/package.json` (self-hosted fonts via `@fontsource`)
- Create: `apps/web/src/styles/tokens.md` (the written token system — palette/type/layout/signature, for reference)

**Interfaces:**
- Produces: the Tailwind token names all components use — `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-card`, `bg-primary`/`text-primary-foreground`, `bg-accent`, `border-border`, `bg-success`/`bg-warning`/`bg-destructive`, `ring-ring`, radius `rounded-md` (6px); font utilities `font-display`, `font-sans`, `font-mono` (mono = tabular numerals).

**Starting token system** (frontend-design critique pass may refine *within these slots*; final values previewed to the user before Task 4):
- **Direction:** "operations console" — a calm, high-legibility technical instrument for logistics executives. Deliberately **not** the AI-default warm-cream-serif, near-black-acid, or broadsheet-hairline looks.
- **Palette (light):** `--background #F6F8FB` · `--card #FFFFFF` · `--foreground #101828` · `--muted-foreground #5B6472` · `--border #E2E6EC` · `--primary #0B5FBA` (cobalt) · `--accent #F2A413` (marigold — the **signature** accent, used sparingly on the route diagram + key highlights) · `--success #157F5B` · `--warning #B45309` · `--destructive #C02638`. Dark theme = the same slots, flipped (already have `theme: "dark"` in the user's client; ship both).
- **Type:** display/headings **Space Grotesk** (`font-display`); body/UI **Inter** (`font-sans`); data **IBM Plex Mono** with **tabular numerals** (`font-mono`) for query codes, weights, CBM, dims, dates, numeric table columns. Self-host via `@fontsource/space-grotesk`, `@fontsource/inter`, `@fontsource-variable/ibm-plex-mono` (no runtime CDN).
- **Layout:** dense quiet table + single-line toolbar for the list; left-rail stepper + persistent header + right findings/diagram rail (Step 4) for the wizard. Hairline `--border`, 6px radius, disciplined spacing.
- **Signature:** the RouteDiagram (Task 12).

- [ ] **Step 1: Invoke frontend-design, write the token plan**

Invoke the `frontend-design` skill. Produce `apps/web/src/styles/tokens.md` documenting palette (named hex), the three type roles, the layout concept, and the signature element. Run the skill's critique pass: for each choice, confirm it's specific to this brief (a logistics ops instrument), not a generic default; revise and note what changed.

- [ ] **Step 2: Add fonts**

```bash
pnpm --filter @svyft/web add @fontsource/space-grotesk @fontsource/inter @fontsource-variable/ibm-plex-mono
```
Import them in `apps/web/src/main.tsx` (e.g. `import "@fontsource/inter/400.css"` … plus 500/600, Space Grotesk 500/600, Plex Mono variable).

- [ ] **Step 3: Write the token block in `index.css`**

Replace the bare `@tailwind` file with the shadcn `:root` / `.dark` CSS-variable block using the palette above (HSL triplets, shadcn convention: `--background: 210 40% 98%;` etc.), plus `--radius: 0.375rem;`. Keep the three `@tailwind base/components/utilities` directives. Add a `@layer base { body { @apply bg-background text-foreground font-sans; } }` and set `font-feature-settings: "tnum" 1;` on `.font-mono`.

- [ ] **Step 4: Map tokens in `tailwind.config.ts`**

Fill `theme.extend` with the shadcn token mapping (`colors.background: "hsl(var(--background))"`, …, `success`/`warning`/`accent`), `borderRadius.md: "var(--radius)"`, and `fontFamily: { display: ["Space Grotesk", ...], sans: ["Inter", ...], mono: ["IBM Plex Mono", ...] }`. Set `darkMode: ["class"]`.

- [ ] **Step 5: Reconcile the 4 existing primitives**

`badge/button/input/label` currently use literal `slate-*`. Update them to token classes (`bg-primary text-primary-foreground`, `border-border`, `bg-destructive`, etc.) so they inherit the theme. Run the existing web tests to confirm no regression: `pnpm --filter @svyft/web test`.

- [ ] **Step 6: Build + screenshot critique**

Run `pnpm --filter @svyft/web build` (must pass). Then `preview_start` the web app, `preview_screenshot` the login + a masters list, and critique against `tokens.md` (type scale, contrast, focus ring, spacing). Fix drift. **Preview the palette/type to the user and get a thumbs-up before Task 4.**

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/index.css apps/web/tailwind.config.ts apps/web/src/main.tsx \
        apps/web/src/styles/tokens.md apps/web/package.json apps/web/src/components/ui pnpm-lock.yaml
git commit -m "feat(web): app-wide shadcn theme tokens + type system (design language)"
```

---

## Task 2: shadcn primitives, libraries, Stepper, DataTable

**Files:**
- Modify: `apps/web/package.json` (deps)
- Create: `apps/web/src/components/ui/{table,select,checkbox,textarea,form,dialog,dropdown-menu,popover,tooltip,separator,card,calendar,command}.tsx` (via shadcn CLI)
- Create: `apps/web/src/components/ui/stepper.tsx` (bespoke)
- Create: `apps/web/src/components/ui/data-table.tsx` (TanStack wrapper)
- Test: `apps/web/src/components/ui/stepper.test.tsx`, `apps/web/src/components/ui/data-table.test.tsx`

**Interfaces:**
- Produces:
  - shadcn re-exports used everywhere: `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableCell`/`TableHead`, `Select`/`SelectTrigger`/`SelectContent`/`SelectItem`, `Checkbox`, `Textarea`, `Form`/`FormField`/`FormItem`/`FormLabel`/`FormControl`/`FormMessage`, `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter`, `DropdownMenu*`, `Popover*`, `Tooltip*`, `Separator`, `Card*`, `Calendar`, `Command*`.
  - `Stepper` — `<Stepper steps={{key,label}[]} current={string} completed={Set<string>} onStepClick?={(key)=>void} />`.
  - `DataTable` — `<DataTable columns={ColumnDef<T>[]} data={T[]} onRowClick?={(row:T)=>void} isLoading?={boolean} />` (uses `@tanstack/react-table`; pagination/sort are **server-driven**, passed in via props, not internal).

- [ ] **Step 1: Add libraries**

```bash
pnpm --filter @svyft/web add @tanstack/react-table react-day-picker date-fns cmdk \
  @radix-ui/react-select @radix-ui/react-checkbox @radix-ui/react-dialog \
  @radix-ui/react-dropdown-menu @radix-ui/react-popover @radix-ui/react-tooltip \
  @radix-ui/react-separator @radix-ui/react-label @radix-ui/react-slot
```

- [ ] **Step 2: Generate shadcn primitives**

```bash
cd apps/web && npx shadcn@latest add table select checkbox textarea form dialog dropdown-menu popover tooltip separator card calendar command
```
Then reconcile each generated file to the Task 1 tokens (they already reference `hsl(var(--*))`, so they should render correctly once the theme block exists). Add a one-line render smoke test per non-trivial primitive if the reviewer wants, but the CLI output is trusted.

- [ ] **Step 3: Write the failing Stepper test**

```tsx
// stepper.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stepper } from "./stepper";
const steps = [{ key: "a", label: "Client" }, { key: "b", label: "Shipment" }];
it("marks current + completed and fires onStepClick", async () => {
  const onClick = vi.fn();
  render(<Stepper steps={steps} current="b" completed={new Set(["a"])} onStepClick={onClick} />);
  expect(screen.getByRole("button", { name: /Client/ })).toHaveAttribute("data-completed", "true");
  expect(screen.getByRole("button", { name: /Shipment/ })).toHaveAttribute("aria-current", "step");
  await userEvent.click(screen.getByRole("button", { name: /Client/ }));
  expect(onClick).toHaveBeenCalledWith("a");
});
```

- [ ] **Step 4: Run it, confirm fail** — `pnpm --filter @svyft/web test -- stepper` → FAIL (no `Stepper`).

- [ ] **Step 5: Implement `stepper.tsx`**

A horizontal (wizard-top) / vertical (left-rail) list of numbered step buttons using `font-display` labels, token colors (current = `bg-primary`, completed = `bg-success`, upcoming = `bg-muted`), `aria-current="step"` on current, `data-completed` attr, disabled when `onStepClick` absent. Use `cn()` + CVA like `button.tsx`.

- [ ] **Step 6: Run it, confirm pass.**

- [ ] **Step 7: Write the failing DataTable test**

```tsx
// data-table.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable } from "./data-table";
const columns = [{ accessorKey: "code", header: "Code" }];
it("renders rows and fires onRowClick", async () => {
  const onRowClick = vi.fn();
  render(<DataTable columns={columns} data={[{ code: "YAL26-0001" }]} onRowClick={onRowClick} />);
  await userEvent.click(screen.getByText("YAL26-0001"));
  expect(onRowClick).toHaveBeenCalledWith({ code: "YAL26-0001" });
});
it("shows an empty state", () => {
  render(<DataTable columns={columns} data={[]} />);
  expect(screen.getByText(/No queries/i)).toBeInTheDocument();
});
```

- [ ] **Step 8: Run it, confirm fail.**

- [ ] **Step 9: Implement `data-table.tsx`** using `useReactTable` + `getCoreRowModel` over the shadcn `Table` primitives; a clickable `<TableRow>` (keyboard-accessible: `role="button"` semantics or a focusable row), an `isLoading` skeleton, and an empty-state row ("No queries match your filters."). Sorting/pagination are controlled by the parent (Task 4).

- [ ] **Step 10: Run tests, confirm pass. Commit.**

```bash
git add apps/web/src/components/ui apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): shadcn primitives + Stepper + DataTable"
```

---

## Task 3: api-client errors, dates, findings dedup, FindingsPanel, test harness

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add `del`, `ApiError`)
- Create: `apps/web/src/lib/dates.ts`
- Modify: `packages/shared/src/findings.ts` (add `dedupeFindings`) + `packages/shared/src/findings.test.ts`
- Create: `apps/web/src/components/FindingsPanel.tsx` + `FindingsPanel.test.tsx`
- Create: `apps/web/src/test/renderWithProviders.tsx`
- Test: `apps/web/src/lib/api.test.ts`, `apps/web/src/lib/dates.test.ts`

**Interfaces:**
- Produces (imported by all feature tasks):
  - `class ApiError extends Error { status: number; findings?: Finding[]; issues?: ZodIssue[]; body?: unknown }` — thrown by `fetchJson/postJson/patchJson/del` on `!res.ok`, parsing the body: 422 → `findings`, 400 → `issues`.
  - `del(url: string): Promise<void>` in `@/lib/api`.
  - `formatDateTime(iso: string | null): string` ("DD-MM-YYYY HH:mm"), `formatDate(iso)`, `toIsoOffset(local: string): string` (datetime-local → offset ISO) in `@/lib/dates`.
  - `dedupeFindings(findings: Finding[]): Finding[]` in `@svyft/shared` — dedup by `rule|severity|scope.type|scope.id|message`.
  - `<FindingsPanel findings={Finding[]} phase={"draft"|"create"} onFindingClick?={(f)=>void} />` — groups by severity; draft renders warnings (amber), create renders blocking (red) prominently; empty renders nothing.
  - `renderWithProviders(ui, { route?, user? })` — wraps in `QueryClientProvider`(retry:false) + `AuthProvider` (auth mocked via the `/api/auth/me` fetch stub) + `MemoryRouter`.

- [ ] **Step 1: Write the failing `ApiError` test**

```ts
// api.test.ts
import { postJson, ApiError } from "./api";
it("throws ApiError with findings on 422", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false, status: 422,
    json: async () => ({ findings: [{ rule: "R1", severity: "blocking", scope: { type: "leg" }, message: "broken" }] }),
    text: async () => "",
  }));
  await expect(postJson("/api/queries/x/create")).rejects.toMatchObject({
    status: 422, findings: [{ rule: "R1" }],
  });
});
it("throws ApiError with issues on 400", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false, status: 400, json: async () => ({ message: "Validation failed", issues: [{ path: ["email"], message: "bad" }] }), text: async () => "",
  }));
  await expect(postJson("/api/x")).rejects.toMatchObject({ status: 400, issues: [{ path: ["email"] }] });
});
afterEach(() => vi.unstubAllGlobals());
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `ApiError` + `del` + wire all four helpers**

```ts
export class ApiError extends Error {
  constructor(readonly status: number, message: string,
    readonly findings?: Finding[], readonly issues?: unknown[], readonly body?: unknown) { super(message); this.name = "ApiError"; }
}
async function raise(res: Response): Promise<never> {
  let body: any = undefined;
  try { body = await res.json(); } catch { /* empty */ }
  const findings = body && Array.isArray(body.findings) ? (body.findings as Finding[]) : undefined;
  const issues = body && Array.isArray(body.issues) ? body.issues : undefined;
  throw new ApiError(res.status, body?.message ?? `Request failed: ${res.status}`, findings, issues, body);
}
// in each helper: if (!res.ok) return raise(res);
export async function del(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", credentials: "include" });
  if (!res.ok) return raise(res);
}
```
Also make `patchJson` tolerate a 204/empty response (guard `res.status === 204` → return undefined) since points/legs/cargo DELETE and some writes return no body.

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: `dates.ts` + test** — `formatDateTime`/`formatDate` via `date-fns` `format(parseISO(iso), "dd-MM-yyyy HH:mm")`; `toIsoOffset` turns a `datetime-local` value into an offset ISO string. Test the round-trip and the null guard. Run, confirm pass.

- [ ] **Step 6: `dedupeFindings` in shared + test**

```ts
// findings.ts
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>(); const out: Finding[] = [];
  for (const f of findings) {
    const k = `${f.rule}|${f.severity}|${f.scope.type}|${f.scope.id ?? ""}|${f.message}`;
    if (!seen.has(k)) { seen.add(k); out.push(f); }
  }
  return out;
}
```
Test: duplicate T1 findings collapse to one; distinct scopes stay. Run: `pnpm --filter @svyft/shared test -- findings`.

- [ ] **Step 7: `renderWithProviders` helper** — extract the provider tree currently inlined in the masters tests (`QueryClientProvider` with `retry:false` + `AuthProvider` + `MemoryRouter initialEntries=[route]`), accepting `{ route = "/", user }`; the caller still stubs `fetch` (including `/api/auth/me` → `{ user }`). No test of its own; it's exercised by every feature test.

- [ ] **Step 8: Write the failing FindingsPanel test**

```tsx
it("renders blocking findings prominently in create phase", () => {
  render(<FindingsPanel phase="create" findings={[
    { rule: "R2", severity: "blocking", scope: { type: "cargo", id: "c1" }, message: "Chain must end at a delivery" },
  ]} />);
  expect(screen.getByText(/must end at a delivery/)).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(/R2/);
});
it("renders nothing when empty", () => {
  const { container } = render(<FindingsPanel phase="draft" findings={[]} />);
  expect(container).toBeEmptyDOMElement();
});
```

- [ ] **Step 9: Run, confirm fail.**

- [ ] **Step 10: Implement `FindingsPanel`** — dedupe via `dedupeFindings`, group by severity, blocking → `bg-destructive/10 text-destructive` with `role="alert"`, warning → `bg-warning/10 text-warning`; each row shows the rule tag (`font-mono`) + message + an optional clickable scope chip (`onFindingClick`). Empty → `return null`.

- [ ] **Step 11: Run tests, confirm pass. Commit.**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/lib/dates.ts apps/web/src/lib/dates.test.ts \
        packages/shared/src/findings.ts packages/shared/src/findings.test.ts \
        apps/web/src/components/FindingsPanel.tsx apps/web/src/components/FindingsPanel.test.tsx \
        apps/web/src/test/renderWithProviders.tsx
git commit -m "feat(web): ApiError + findings dedup + FindingsPanel + test harness"
```

---

## Task 4: Query List page (`/queries`) + landing route

**Files:**
- Create: `apps/web/src/features/query-list/useQueries.ts` + `useQueries.test.ts`
- Create: `apps/web/src/features/query-list/columns.tsx`
- Create: `apps/web/src/features/query-list/QueriesToolbar.tsx`
- Create: `apps/web/src/features/query-list/QueriesListPage.tsx` + `QueriesListPage.test.tsx`
- Modify: `apps/web/src/App.tsx` (routes + `/` → `/queries` redirect)
- Modify: `apps/web/src/components/AppLayout.tsx` (nav link; widen `<main>`)

**Interfaces:**
- Consumes: `QueryListRow`, `QueryListParams`, `Paginated`, `Priority`/`PRIORITIES`, `QueryStatus`/`QUERY_STATUSES`, `FreightMode`/`FREIGHT_MODES` (`@svyft/shared`); `fetchJson` (`@/lib/api`); `DataTable` (Task 2); `formatDateTime`/`formatDate` (Task 3); `Select`, `Input`, `Button`, `Badge`, `Popover`, `Calendar`.
- Produces: `useQueries(params): UseQueryResult<Paginated<QueryListRow>>` keyed `["queries", params]`; `queryColumns: ColumnDef<QueryListRow>[]`.

- [ ] **Step 1: Failing hook test** — assert `useQueries` requests `/api/queries?...` with the params encoded and returns the paginated body. Follow `useMasters` + the mock-fetch pattern via `renderWithProviders` (or `renderHook` with the provider wrapper).

```ts
it("requests /api/queries with encoded params", async () => {
  const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }), text: async () => "" });
  vi.stubGlobal("fetch", spy);
  const { result } = renderHook(() => useQueries({ q: "YAL", status: "DRAFT", page: 1, pageSize: 20 }), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(spy.mock.calls[0][0]).toContain("/api/queries?");
  expect(spy.mock.calls[0][0]).toContain("q=YAL");
  expect(spy.mock.calls[0][0]).toContain("status=DRAFT");
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `useQueries.ts`**

```ts
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { Paginated, QueryListRow, QueryListParams } from "@svyft/shared";

function toSearch(p: QueryListParams): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "" && v !== null) sp.set(k, String(v));
  return sp.toString();
}
export function useQueries(params: QueryListParams) {
  return useQuery({
    queryKey: ["queries", params],
    queryFn: () => fetchJson<Paginated<QueryListRow>>(`/api/queries?${toSearch(params)}`),
    placeholderData: keepPreviousData,
  });
}
```

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Implement `columns.tsx`** — `ColumnDef<QueryListRow>[]` for the spec §6.2 columns:
  - `queryCode` → `font-mono` clickable text (row click handles nav; render as a link-styled span).
  - `queryDate` → `formatDateTime`.
  - `customerName`, `contactName`, `shipmentDescription` (truncate to ~40 chars, `title` full).
  - `freightMode` → map to `<Badge>` chips per mode (empty → "—").
  - `origin`, `destination` → text (already display strings).
  - `responseDeadline` → `formatDate`.
  - `priority` → `<Badge>` variant by value.
  - `status` → `<Badge>` variant by value (map DRAFT/CREATED/RFQ_READY to token colors).
  - `assignedUserName` → text or "—" (see self-review note: list row includes the resolved name).
  - `updatedAt` → `formatDateTime`.
  Numeric/code columns use `font-mono tabular-nums`.

- [ ] **Step 6: Implement `QueriesToolbar.tsx`** — a controlled toolbar: debounced search `<Input>` (300ms), `<Select>` filters for status/priority/freightMode, an `assignedUser` select (options from a small `useUsers` fetch if the endpoint is available to the role, else "Me / All"), a `country` `<Input>`, and a date-range `<Popover>` with `<Calendar mode="range">` + a `dateField` toggle (Query Date / Last Updated). Emits a partial `QueryListParams` up via `onChange`. Include a "Clear filters" button.

- [ ] **Step 7: Failing page test**

```tsx
it("renders rows and navigates on row click; shows + Create Query", async () => {
  vi.stubGlobal("fetch", mockFetch((url) => {
    if (url.includes("/api/auth/me")) return { status: 200, body: { user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } } };
    if (url.includes("/api/queries")) return { status: 200, body: { items: [{ id: "q1", queryCode: "YAL26-0001", queryDate: new Date().toISOString(), customerName: "Acme", contactName: "Al", shipmentDescription: "steel", freightMode: ["SEA"], origin: "Mumbai, IN", destination: "Rotterdam, NL", responseDeadline: null, priority: "HIGH", status: "DRAFT", assignedUserName: "Exec", updatedAt: new Date().toISOString() }], total: 1, page: 1, pageSize: 20 } };
    return { status: 200, body: {} };
  }));
  renderWithProviders(<Routes><Route path="/queries" element={<QueriesListPage />} /><Route path="/queries/:id" element={<div>wizard {"q1"}</div>} /></Routes>, { route: "/queries", user: { role: "EXECUTIVE" } });
  expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Create Query/i })).toHaveAttribute("href", "/queries/new");
  await userEvent.click(screen.getByText("YAL26-0001"));
  expect(await screen.findByText(/wizard/)).toBeInTheDocument();
});
```

- [ ] **Step 8: Run, confirm fail.**

- [ ] **Step 9: Implement `QueriesListPage.tsx`** — holds `QueryListParams` state (default `{ page: 1, pageSize: 20, sort: "updatedAt:desc" }`), renders `<QueriesToolbar onChange=...>`, `<DataTable columns={queryColumns} data={data?.items ?? []} isLoading onRowClick={(r)=>navigate(\`/queries/${r.id}\`)} />`, pagination controls (`page`/`pageSize`, `total`), and a `+ Create Query` `<Button asChild><Link to="/queries/new">`. Server-driven sort: clicking a sortable header sets `sort` param. Page title "Queries" in `font-display`.

- [ ] **Step 10: Run, confirm pass.**

- [ ] **Step 11: Routes + nav**

In `App.tsx`: add `<Route path="/queries" element={<Protected><QueriesListPage/></Protected>} />`, `/queries/new` and `/queries/:id` (Task 5), and change `/` to `<Navigate to="/queries" replace />`. In `AppLayout.tsx`: add a `Queries` nav `<Link>` (first item) and widen `<main>` from `max-w-4xl` to `max-w-7xl` (the table + wizard need width).

- [ ] **Step 12: Run full web tests + build. Commit.**

```bash
git add apps/web/src/features/query-list apps/web/src/App.tsx apps/web/src/components/AppLayout.tsx
git commit -m "feat(web): Query List (All Records) page with search/filters/sort + landing route"
```

---

## Task 5: WizardShell + save model + routing + wizard context

**Files:**
- Create: `apps/web/src/features/query-wizard/useQueryDetail.ts` + `useQueryDetail.test.ts`
- Create: `apps/web/src/features/query-wizard/WizardContext.tsx`
- Create: `apps/web/src/features/query-wizard/WizardShell.tsx`
- Create: `apps/web/src/features/query-wizard/QueryWizardPage.tsx` + `QueryWizardPage.test.tsx`
- Modify: `apps/web/src/App.tsx` (register `/queries/new`, `/queries/:id`)

**Interfaces:**
- Consumes: `QueryDetail`, `QuerySaveInput`, `querySaveSchema`, `Priority`/`PRIORITIES`, `QueryStatus` (`@svyft/shared`); `fetchJson`/`postJson`/`patchJson`/`ApiError` (`@/lib/api`); `Stepper`, `Button`, `Badge`, `Select`; `FindingsPanel`; `formatDateTime` (`@/lib/dates`).
- Produces (all step tasks consume these):
  - `useQueryDetail(id?: string): UseQueryResult<QueryDetail>` keyed `["query", id]`, `enabled: !!id`.
  - `useSaveQuery()` → `{ create(input): Promise<QueryDetail>, patch(id, input): Promise<QueryDetail> }` (invalidate `["query", id]` + `["queries"]`).
  - `useCreateQuery()` → `mutateAsync(id): Promise<{ id; status }>` (on success invalidate `["query", id]`; throws `ApiError` with `findings` on 422).
  - `useWizard(): { detail?: QueryDetail; queryId?: string; isNew: boolean; step: number; setStep(n): void; goNext(): void; goBack(): void; refresh(): Promise<void> }` from `WizardContext`.
  - `const STEPS = [{ key:"client", label:"Client & Query" }, { key:"shipment", label:"Shipment" }, { key:"cargo", label:"Cargo" }, { key:"legs", label:"Legs / Route" }, { key:"notes", label:"Notes & Checklist" }]` (order O2).

- [ ] **Step 1: Failing `useQueryDetail`/`useSaveQuery` test** — mock `GET /api/queries/:id` → a `QueryDetail`; assert the hook loads it; mock `PATCH` → assert `patch()` calls `PATCH /api/queries/:id` and invalidates. Mock `POST /api/queries` for `create()` returning `{ id: "q1", ... }`.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `useQueryDetail.ts`**

```ts
export function useQueryDetail(id?: string) {
  return useQuery({ queryKey: ["query", id], queryFn: () => fetchJson<QueryDetail>(`/api/queries/${id}`), enabled: !!id });
}
export function useSaveQuery() {
  const qc = useQueryClient();
  return {
    create: async (input: QuerySaveInput) => {
      const d = await postJson<QueryDetail>("/api/queries", input);
      qc.setQueryData(["query", d.id], d); qc.invalidateQueries({ queryKey: ["queries"] });
      return d;
    },
    patch: async (id: string, input: QuerySaveInput) => {
      const d = await patchJson<QueryDetail>(`/api/queries/${id}`, input);
      qc.setQueryData(["query", id], d); qc.invalidateQueries({ queryKey: ["queries"] });
      return d;
    },
  };
}
export function useCreateQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postJson<{ id: string; status: string }>(`/api/queries/${id}/create`),
    onSuccess: (_r, id) => qc.invalidateQueries({ queryKey: ["query", id] }),
  });
}
```

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Implement `WizardContext.tsx`** — a context provider taking `id?` and exposing `useWizard()`. It calls `useQueryDetail(id)`, holds `step` state (synced to a `?step=` search param), computes `isNew = !id`, `goNext/goBack` clamp to `[0, STEPS.length-1]`, `refresh()` = `qc.invalidateQueries(["query", id])`. Jump-to (`setStep`) allowed only when `detail` exists.

- [ ] **Step 6: Implement `WizardShell.tsx`** — layout:
  - **Header** (`font-display`): Query ID (`detail?.queryCode ?? "New Query"`, `font-mono`), a status `<Badge>` (`detail?.status ?? "DRAFT"`), and an **inline Priority `<Select>`** that on change calls `patch(id, { priority })` (only enabled once `queryId` exists; for a new query the priority is part of Step 1's form).
  - **Stepper** (`<Stepper steps={STEPS} current=... completed=... onStepClick=...>`), jump-to enabled once `detail` exists.
  - **Body slot** — renders `children` (the current step component).
  - **Action bar** (sticky bottom): `Cancel` (confirm → discard/navigate), `Back` (steps 2–5), `Save` (every step — delegates to the current step's save via a ref/callback), `Next` (steps 1–4), and on the final step **`Create Query`**. Buttons disabled while saving.
  - **Findings slot** — `<FindingsPanel>` (fed by Step 4 / Create).
  Save/validation wiring: the shell exposes a `registerStepSave(fn)` so each step registers its save handler; `Save`/`Next` call it. `Next` runs the step's light client validation (warnings, non-blocking).

- [ ] **Step 7: Failing `QueryWizardPage` test — the save/mint flow**

```tsx
it("mints the Query ID on first Save of a new query and switches to edit", async () => {
  const posts: any[] = [];
  vi.stubGlobal("fetch", mockFetch((url, init) => {
    if (url.includes("/api/auth/me")) return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
    if (url.endsWith("/api/queries") && init?.method === "POST") { posts.push(JSON.parse(init.body)); return { status: 201, body: { id: "q9", queryCode: "YAL26-0009", status: "DRAFT", priority: "MEDIUM", cargo: [], checklist: [], files: [], points: [], legs: [], freightMode: [], origin: [], destination: [] } }; }
    if (url.includes("/api/queries/q9")) return { status: 200, body: { id: "q9", queryCode: "YAL26-0009", status: "DRAFT", priority: "MEDIUM", cargo: [], checklist: [], files: [], points: [], legs: [], freightMode: [], origin: [], destination: [] } };
    return { status: 200, body: {} };
  }));
  renderWithProviders(<Routes><Route path="/queries/new" element={<QueryWizardPage/>} /><Route path="/queries/:id" element={<QueryWizardPage/>} /></Routes>, { route: "/queries/new", user: { role: "EXECUTIVE" } });
  // fill the minimum Step 1 field(s), click Save
  await userEvent.click(await screen.findByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(posts.length).toBe(1));
  expect(await screen.findByText("YAL26-0009")).toBeInTheDocument();
});
```

- [ ] **Step 8: Run, confirm fail.**

- [ ] **Step 9: Implement `QueryWizardPage.tsx`** — reads `useParams().id`; wraps `WizardContext`; renders `WizardShell` + the step component for `step`. Save model:
  - **New (`/queries/new`):** Step 1 holds a local RHF form; on first `Save` (or first leg save in Step 4) call `create(formValues)` → on success `navigate(\`/queries/${d.id}?step=0\`, { replace: true })`. Until then, later steps are disabled/greyed with "Save to continue".
  - **Existing:** each step's Save calls the right endpoint (`patch` for steps 1/2, checklist endpoint for step 5, cargo/points/legs endpoints for steps 3/4) then `refresh()`.
  - **Create Query:** final-step button → `useCreateQuery().mutateAsync(id)`; catch `ApiError` → `setFindings(err.findings)` (blocking, shown in `FindingsPanel`); on success → `refresh()`, toast/banner "Query {code} created successfully.", status flips to `RFQ_READY`.
  - **Cancel:** confirm dialog → new+unsaved: `navigate("/queries")`; existing: `refresh()` (revert to last saved) and stay.

- [ ] **Step 10: Run, confirm pass.**

- [ ] **Step 11: Register routes**

In `App.tsx`: `<Route path="/queries/new" element={<Protected><QueryWizardPage/></Protected>} />` and `<Route path="/queries/:id" element={<Protected><QueryWizardPage/></Protected>} />`.

- [ ] **Step 12: Run web tests + build. Commit.**

```bash
git add apps/web/src/features/query-wizard/useQueryDetail.ts apps/web/src/features/query-wizard/useQueryDetail.test.ts \
        apps/web/src/features/query-wizard/WizardContext.tsx apps/web/src/features/query-wizard/WizardShell.tsx \
        apps/web/src/features/query-wizard/QueryWizardPage.tsx apps/web/src/features/query-wizard/QueryWizardPage.test.tsx apps/web/src/App.tsx
git commit -m "feat(web): wizard shell + stepper + save model (first-save mints Query ID)"
```

---

## Task 6: Step 1 — Client & Query Details (+ client/vessel pickers)

**Files:**
- Create: `apps/web/src/features/query-wizard/pickers/ClientPicker.tsx`, `VesselPicker.tsx`
- Create: `apps/web/src/features/query-wizard/steps/Step1Client.tsx` + `Step1Client.test.tsx`

**Interfaces:**
- Consumes: `querySaveSchema`/`QuerySaveInput`, `ClientDto`, `ContactDto`, `VesselDto`, `Paginated`, `PRIORITIES`, `Role` (`@svyft/shared`); `Command*`, `Popover*`, `Select`, `Input`, `Checkbox`, `Form*`; `fetchJson` (`@/lib/api`); `useWizard`, `useSaveQuery` (Task 5); `useAuth` (existing).
- Produces: `<Step1Client registerSave={(fn)=>void} />` — registers its RHF submit as the shell's Save handler.

- [ ] **Step 1: Failing picker test** — `ClientPicker` searches `/api/clients?q=` on type, lists results, calls `onSelect(client)` on click. `VesselPicker` analogous over `/api/vessels`.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `ClientPicker.tsx`**

```tsx
export function ClientPicker({ value, onSelect }: { value?: { id: string; companyName: string } | null; onSelect: (c: ClientDto) => void }) {
  const [q, setQ] = useState("");
  const { data } = useQuery({ queryKey: ["clients", q], queryFn: () => fetchJson<Paginated<ClientDto>>(`/api/clients?q=${encodeURIComponent(q)}&status=ACTIVE`), enabled: q.length > 0 });
  // <Popover> + <Command>: CommandInput bound to q, CommandItem per data.items → onSelect(c). Trigger shows value?.companyName ?? "Select client…".
}
```
`VesselPicker.tsx` is the same shape over `/api/vessels` returning `VesselDto`.

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Failing Step1 test** — renders the form; selecting a client fetches its contacts (`/api/clients/:id/contacts`) and fills the Contact select; on Save, calls `create`/`patch` with the mapped `QuerySaveInput` (clientId, contactName, contactEmail, contactPhone, priority, readyDate, targetDelivery, …). Assert the POST body contains the selected `clientId` and `contactEmail`.

- [ ] **Step 6: Run, confirm fail.**

- [ ] **Step 7: Implement `Step1Client.tsx`** — `useForm<QuerySaveInput>({ resolver: zodResolver(querySaveSchema), defaultValues: fromDetail(detail) })`. Fields (spec §7.1), each via the `Form*` primitives (`FormField`/`FormItem`/`FormLabel`/`FormControl`/`FormMessage`) — the shadcn Controller layer:
  - Query ID (read-only, `font-mono`), Query Date (read-only unless `user.role === Role.ADMINISTRATOR` — then a `datetime-local`).
  - **Priority** `<Select>` (PRIORITIES, default MEDIUM), **Response Deadline** date + remarks.
  - **Company / Client** → `<ClientPicker>` sets `clientId`; on select, `useQuery(["client-contacts", clientId])` fills the **Contact Person** `<Select>` (from `ContactDto[]`); choosing a contact prefills `contactName`/`contactDesignation`/`contactEmail`/`contactPhone` (snapshot — editable).
  - Email, Phone (E.164), WhatsApp checkbox, Fax.
  - **Vessel** → `<VesselPicker>` sets `vesselName`/`imoNumber`; ETA/ETB/ETD (`datetime-local` → `toIsoOffset`), Port of Call.
  - **Ready Date**, **Target Delivery** (mandatory markers).
  - `registerSave` = `handleSubmit(async (values) => isNew ? create(values) : patch(queryId, values))`.
  Reuse the field-markup idiom from `ClientFormPage.tsx` (Label + control + `<FormMessage>`); do **not** re-invent error rendering.

- [ ] **Step 8: Run, confirm pass. Commit.**

```bash
git add apps/web/src/features/query-wizard/pickers apps/web/src/features/query-wizard/steps/Step1Client.tsx apps/web/src/features/query-wizard/steps/Step1Client.test.tsx
git commit -m "feat(web): wizard Step 1 (Client & Query Details) + client/vessel pickers"
```

---

## Task 7: Step 2 — Shipment Details

**Files:**
- Create: `apps/web/src/features/query-wizard/steps/Step2Shipment.tsx` + `Step2Shipment.test.tsx`

**Interfaces:**
- Consumes: `querySaveSchema`/`QuerySaveInput`, `INCOTERMS` (`@svyft/shared`); `Form*`, `Select`, `Textarea`, `Checkbox`; `useWizard`, `useSaveQuery`.
- Produces: `<Step2Shipment registerSave />`.

- [ ] **Step 1: Failing test** — renders Incoterms select + description + DG checkbox; on Save patches `{ incoterms, shipmentDescription, dgIndicator }`. Assert the DG checkbox reflects `detail.dgIndicator` (auto-set true when any cargo is DG — read from detail).

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `Step2Shipment.tsx`** — small RHF form: **Incoterms** `<Select>` (INCOTERMS, mandatory marker), **Shipment Description** `<Textarea>` (200-char counter), **DG Indicator** `<Checkbox>` (note: auto-true when any cargo DG — show a hint "Set automatically when a cargo row is dangerous; you can also set it manually"). `registerSave` patches these three fields. Guard: only patch when `queryId` exists (Step 2 is unreachable before first Save per the shell's new-query gating).

- [ ] **Step 4: Run, confirm pass. Commit.**

```bash
git add apps/web/src/features/query-wizard/steps/Step2Shipment.tsx apps/web/src/features/query-wizard/steps/Step2Shipment.test.tsx
git commit -m "feat(web): wizard Step 2 (Shipment Details)"
```

---

## Task 8: Step 3 — Cargo Details (dynamic table + MSDS + Export)

**Files:**
- Create: `apps/web/src/features/query-wizard/steps/cargo/useCargo.ts` (mutations) + `useCargo.test.ts`
- Create: `apps/web/src/features/query-wizard/steps/cargo/CargoRowForm.tsx`
- Create: `apps/web/src/features/query-wizard/steps/Step3Cargo.tsx` + `Step3Cargo.test.tsx`

**Interfaces:**
- Consumes: `cargoCreateSchema`/`CargoCreateInput`, `cargoUpdateSchema`/`CargoUpdateInput`, `CargoDto`, `REFERENCE_TAGS` (`@svyft/shared`); `postJson`/`patchJson`/`del`/`raise`/`ApiError` (`@/lib/api`); `Table*`, `Checkbox`, `Input`, `Select`, `Button`; `useWizard`.
- Produces: `useCargo(queryId)` → `{ add(input), update(cid, input), remove(cid), uploadMsds(cid, file), exportXlsx() }` (each invalidates `["query", queryId]`); `<Step3Cargo />`.

- [ ] **Step 1: Failing `useCargo` test** — `add()` POSTs `/api/queries/:id/cargo`; `remove()` DELETEs; `uploadMsds()` POSTs multipart to `/cargo/:cid/msds` with a `file` field; `exportXlsx()` POSTs `/cargo/export` and triggers a download (assert `fetch` called with method POST + blob path). Use a `File`/`Blob` stub.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `useCargo.ts`**

```ts
export function useCargo(queryId: string) {
  const qc = useQueryClient();
  const bust = () => qc.invalidateQueries({ queryKey: ["query", queryId] });
  return {
    add: async (input: CargoCreateInput) => { const r = await postJson<CargoDto>(`/api/queries/${queryId}/cargo`, input); await bust(); return r; },
    update: async (cid: string, input: CargoUpdateInput) => { const r = await patchJson<CargoDto>(`/api/queries/${queryId}/cargo/${cid}`, input); await bust(); return r; },
    remove: async (cid: string) => { await del(`/api/queries/${queryId}/cargo/${cid}`); await bust(); },
    uploadMsds: async (cid: string, file: File) => {
      const fd = new FormData(); fd.append("file", file);   // field name MUST be "file"; do NOT set Content-Type
      const res = await fetch(`/api/queries/${queryId}/cargo/${cid}/msds`, { method: "POST", credentials: "include", body: fd });
      if (!res.ok) { let b: any; try { b = await res.json(); } catch {} throw new ApiError(res.status, b?.message ?? "Upload failed", b?.findings, b?.issues, b); }
      await bust(); return res.json();
    },
    exportXlsx: async () => {
      const res = await fetch(`/api/queries/${queryId}/cargo/export`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new ApiError(res.status, "Export failed");
      const blob = await res.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `query-${queryId}-cargo.xlsx`; a.click(); URL.revokeObjectURL(url);
    },
  };
}
```

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Implement `CargoRowForm.tsx`** — RHF form (add: `cargoCreateSchema`; edit: `cargoUpdateSchema`) with the spec §7.3 columns: PO/Reference, Product Name, Reference Tags (multi via `REFERENCE_TAGS` checkboxes/toggles), HS/HSN, Package Type, **DG** `<Checkbox>` (reveals MSDS `<input type="file" accept="application/pdf">` → `uploadMsds`), Qty, Dims L×W×H (three inputs), Net Wt, Gross Wt, and a **read-only Volume (CBM)** that previews `(L*W*H*Qty)/1e6` live for the add-form and shows `Number(row.volumeCbm)` for a saved row. Freight Density + Chargeable Wt columns render **read-only, empty**, with a "Stage 4" hint. Submit → `add`/`update`.

- [ ] **Step 6: Failing Step3 test** — add a row (POST body has `poReference`+`grossWt`+dims), tick DG (MSDS input appears), click Export (download fired), remove a row (DELETE). Mock the endpoints.

- [ ] **Step 7: Run, confirm fail.**

- [ ] **Step 8: Implement `Step3Cargo.tsx`** — renders a `<Table>` of `detail.cargo` (read cells; numeric cells `font-mono tabular-nums`; Volume from `Number(volumeCbm)`), each row expandable/editable via `CargoRowForm`, an **+ Add row** button (opens an empty `CargoRowForm`), a **× remove** per row (confirm → `remove`), and an **Export to Excel** button (`exportXlsx`). Rows persist immediately (add/edit/remove hit the server + refresh) so Step 4 legs can reference real cargo ids.

- [ ] **Step 9: Run, confirm pass. Commit.**

```bash
git add apps/web/src/features/query-wizard/steps/cargo apps/web/src/features/query-wizard/steps/Step3Cargo.tsx apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx
git commit -m "feat(web): wizard Step 3 (Cargo table + MSDS upload + Excel export)"
```

---

## Task 9: Step 5 — Internal Notes & Checklist

**Files:**
- Create: `apps/web/src/features/query-wizard/steps/Step5Notes.tsx` + `Step5Notes.test.tsx`

**Interfaces:**
- Consumes: `checklistPatchSchema`/`ChecklistItemStateDto`, `querySaveSchema` (`@svyft/shared`); `patchJson` (`@/lib/api`); `Textarea`, `Checkbox`; `useWizard`, `useSaveQuery`.
- Produces: `<Step5Notes registerSave />`.

- [ ] **Step 1: Failing test** — renders the 9 checklist rows from `detail.checklist` + the notes textarea; toggling a box + Save PATCHes `/api/queries/:id/checklist` with `{ items: [{ itemKey, checked }] }`; notes Save PATCHes `/api/queries/:id` with `{ internalNotes }`.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `Step5Notes.tsx`** — **Internal Notes** `<Textarea>` (500-char counter) → `patch(queryId, { internalNotes })`. **Checklist**: render `detail.checklist` (9 items; label from the item key via `ChecklistItemDto` from `GET /config/checklist-definition`, or a static label map keyed by the seeded item keys `weight-confirmed`/`dimensions-confirmed`/`hs-code-received`/`dg-confirmed`/`msds-received`/`commercial-invoice`/`packing-list`/`pickup-address`/`delivery-address`) with a `<Checkbox>` each. `registerSave` sends the checklist PATCH (all items) + the notes patch. Note: `msds-received` is `dgConditional` — visually mark it applicable only when `detail.dgIndicator`. **Send Follow-up / Send Acknowledgement buttons are intentionally omitted (Plan 7).**

- [ ] **Step 4: Run, confirm pass. Commit.**

```bash
git add apps/web/src/features/query-wizard/steps/Step5Notes.tsx apps/web/src/features/query-wizard/steps/Step5Notes.test.tsx
git commit -m "feat(web): wizard Step 5 (Internal Notes & Checklist)"
```

---

## Task 10: Step 4a — PointEditor (5 types) + CargoAssignmentControl

**Files:**
- Create: `apps/web/src/features/query-wizard/steps/legs/usePoints.ts` + `usePoints.test.ts`
- Create: `apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx` + `PointEditor.test.tsx`
- Create: `apps/web/src/features/query-wizard/steps/legs/CargoAssignmentControl.tsx` + `CargoAssignmentControl.test.tsx`

**Interfaces:**
- Consumes: `pointSaveSchema`/`PointSaveInput`, `pointUpdateSchema`/`PointUpdateInput`, `PointType`/`POINT_TYPES`, `WarehouseType`/`WAREHOUSE_TYPES`, `POINT_REQUIRED_FIELDS`, `CargoDto` (`@svyft/shared`); `postJson`/`patchJson`/`del` (`@/lib/api`); `Dialog*`, `Select`, `Input`, `Checkbox`, `Form*`; `useWizard`.
- Produces:
  - `usePoints(queryId)` → `{ add(input): Promise<Point>, update(pid, input), remove(pid) }` (invalidate `["query", queryId]`).
  - `<PointEditor open type? point? onSaved={(p)=>void} onClose />` — type-aware create/edit dialog.
  - `<CargoAssignmentControl cargo={CargoDto[]} value={string[]} onChange={(ids)=>void} />` — the D7 tick list.

- [ ] **Step 1: Failing `CargoAssignmentControl` test** — renders a checkbox per cargo row (label = `poReference` + productName), reflects `value`, and calls `onChange` with the toggled id set. (Pure controlled component — easiest to TDD first.)

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `CargoAssignmentControl.tsx`** — a list of `<Checkbox>` rows (`cargo.map`), `checked={value.includes(c.id)}`, `onCheckedChange` adds/removes `c.id` and calls `onChange(next)`. Show a "no cargo yet — add rows in Step 3" empty state. Mandatory hint: "Assign at least one cargo row (D7)."

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Failing `usePoints` test** — `add()` POSTs `/api/queries/:id/points` (body has `type`); `update()` PATCHes; `remove()` DELETEs. Mock + assert.

- [ ] **Step 6: Run, confirm fail.**

- [ ] **Step 7: Implement `usePoints.ts`** — same shape as `useCargo` (POST/PATCH/DELETE + invalidate `["query", queryId]`).

- [ ] **Step 8: Failing `PointEditor` test** — choosing type AIRPORT shows the IATA field and hides street address; saving posts `{ type: "AIRPORT", name, iataCode, city, country }`; an invalid IATA (`"XX"`) shows the schema error and does not POST (zodResolver(pointSaveSchema) enforces `^[A-Z]{3}$`).

- [ ] **Step 9: Run, confirm fail.**

- [ ] **Step 10: Implement `PointEditor.tsx`** — a `<Dialog>` with:
  - a **Type** `<Select>` (`POINT_TYPES`), disabled when editing an existing point's fundamental type (allow change on create only).
  - **type-aware fields**, driven by a per-type field list (derive visible fields from the union of `POINT_REQUIRED_FIELDS[type]` + the optional ones for that type per spec §7.4.1):
    - PICKUP/DELIVERY → name (Company), streetAddress, city, postalCode, country, contactName, contactPhone, contactEmail (email required for PICKUP only — mark accordingly).
    - WAREHOUSE → name, streetAddress, city, postalCode, country, warehouseType (`WAREHOUSE_TYPES`), optional contacts.
    - AIRPORT → name (Airport), iataCode, icaoCode (optional), terminal (optional), city, postalCode, country, optional contacts.
    - SEAPORT → name (Port), unLocode, terminal (optional), city, postalCode, country, optional contacts.
  - `useForm({ resolver: zodResolver(point ? pointUpdateSchema : pointSaveSchema) })` — **the shared schema already enforces the IATA/ICAO/UN-LOCODE/phone/email formats**, so no re-declared regexes. Required markers come from `POINT_REQUIRED_FIELDS[type]`, but Save does **not** hard-block on missing per-type fields (partial points are allowed, D8; R8 blocks at Create).
  - Save → `add`/`update` → `onSaved(point)` → close.

- [ ] **Step 11: Run, confirm pass. Commit.**

```bash
git add apps/web/src/features/query-wizard/steps/legs/usePoints.ts apps/web/src/features/query-wizard/steps/legs/usePoints.test.ts \
        apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx \
        apps/web/src/features/query-wizard/steps/legs/CargoAssignmentControl.tsx apps/web/src/features/query-wizard/steps/legs/CargoAssignmentControl.test.tsx
git commit -m "feat(web): Step 4 PointEditor (5 types) + CargoAssignmentControl (D7)"
```

---

## Task 11: Step 4b — LegEditor + leg list + save (V-M1)

**Files:**
- Create: `apps/web/src/features/query-wizard/steps/legs/useLegs.ts` + `useLegs.test.ts`
- Create: `apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx` + `LegEditor.test.tsx`
- Create: `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx` (list + add; diagram added in Task 12) + `LegsStep.test.tsx`

**Interfaces:**
- Consumes: `legSaveSchema`/`LegSaveInput`, `FreightMode`/`FREIGHT_MODES`, `PointType`, `checkModeEndpoints`, `formatLegCode`, `Finding`, `ApiError` (`@svyft/shared` + `@/lib/api`); `usePoints`, `PointEditor`, `CargoAssignmentControl` (Task 10); `Dialog*`, `Select`, `Input`, `Button`; `useWizard`.
- Produces:
  - `useLegs(queryId)` → `{ add(input): Promise<Leg>, update(legId, input), remove(legId) }` (invalidate `["query", queryId]`; on 422 throw `ApiError` with `findings` — the V-M1).
  - `<LegEditor open leg? onSaved onClose />` — origin/destination point pickers (existing point or “+ new” → `PointEditor`), mode, cargo assignment, dates.
  - `<LegsStep />` — the Step-4 body (leg list + add + editor + findings; diagram slot filled in Task 12).

- [ ] **Step 1: Failing `useLegs` test** — `add()` POSTs `/api/queries/:id/legs` with `assignedCargoIds`; a 422 response surfaces as `ApiError` with `findings[0].rule === "V-M1"`.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `useLegs.ts`** — POST/PATCH/DELETE `/api/queries/:id/legs[/:legId]`, body validated by `legSaveSchema` at the form; invalidate `["query", queryId]`. The helpers already throw `ApiError` (Task 3) so the V-M1 422 propagates with `findings`.

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Failing `LegEditor` test** — with an origin=street-address point and destination=street-address point, selecting mode **SEA** shows an inline V-M1 warning (client `checkModeEndpoints(SEA, PICKUP, DELIVERY) === false`) before save; selecting **ROAD** clears it; Save posts `{ originPointId, destinationPointId, mode, assignedCargoIds, readyDate, targetDelivery }`.

- [ ] **Step 6: Run, confirm fail.**

- [ ] **Step 7: Implement `LegEditor.tsx`** — a `<Dialog>`:
  - **Origin / Destination**: each a `<Select>` over `detail.points` (label = `type` + name/city) **plus** a “+ New point” action opening `<PointEditor>`; on save the new point is selected.
  - **Mode** `<Select>` (`FREIGHT_MODES`). **Live V-M1**: when origin+destination+mode are chosen, compute `checkModeEndpoints(mode, originPoint.type, destPoint.type)`; if false, show an inline warning ("A Sea leg needs seaport endpoints") — non-blocking client-side (the server hard-blocks at save with the 422).
  - **Assigned Cargo**: `<CargoAssignmentControl cargo={detail.cargo} value={assignedCargoIds} onChange=…>` (≥1 required marker).
  - **Ready Date / Target Delivery** (`datetime-local` → `toIsoOffset`).
  - `useForm({ resolver: zodResolver(legSaveSchema) })`; Save → `add`/`update`; catch `ApiError` (422) → surface `err.findings` in the dialog (the V-M1 message) and keep it open.
  - **First leg save on a new query**: if `isNew` (no `queryId` yet), the shell first creates the query (mint) then saves the leg — per the spec "first leg save can mint the Query ID". Implement by calling `create({})` (empty draft) if `!queryId` before the leg POST.

- [ ] **Step 8: Failing `LegsStep` test** — lists saved legs from `detail.legs` (legCode `font-mono`, mode badge, origin→destination, assigned cargo count, rollup totals); "+ Add leg" opens `LegEditor`; deleting a leg confirms + DELETEs.

- [ ] **Step 9: Run, confirm fail.**

- [ ] **Step 10: Implement `LegsStep.tsx`** — a leg list (`detail.legs`: `legCode`, mode `<Badge>`, `origin → destination` point names, assigned-cargo count, `rollup.totalPackages/totalCbm/totalGrossWt` in `font-mono tabular-nums`, `status` badge), each with edit/remove; **+ Add leg** → `<LegEditor>`; a placeholder `<div data-slot="route-diagram">` and a draft `<FindingsPanel>` (wired in Task 12). Empty state: "Add the first leg to build the route."

- [ ] **Step 11: Run, confirm pass. Commit.**

```bash
git add apps/web/src/features/query-wizard/steps/legs/useLegs.ts apps/web/src/features/query-wizard/steps/legs/useLegs.test.ts \
        apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx apps/web/src/features/query-wizard/steps/legs/LegEditor.test.tsx \
        apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx apps/web/src/features/query-wizard/steps/legs/LegsStep.test.tsx
git commit -m "feat(web): Step 4 LegEditor + leg list (assignedCargoIds, live V-M1)"
```

---

## Task 12: Step 4c — RouteDiagram (bespoke SVG) + live isomorphic validation

> The **signature** element (Task 1). Invoke `frontend-design` for its visual treatment.

**Files:**
- Create: `apps/web/src/features/query-wizard/steps/legs/routeGraph.ts` + `routeGraph.test.ts`
- Create: `apps/web/src/features/query-wizard/steps/legs/useRouteFindings.ts`
- Create: `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx` + `RouteDiagram.test.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx` (mount the diagram + findings)

**Interfaces:**
- Consumes: `validateRoute`, `RouteGraph`, `RoutePhase`, `Finding`, `dedupeFindings`, `FreightMode`, `PointType` (`@svyft/shared`); `QueryDetail` (`@svyft/shared`); `postJson` (`@/lib/api`); `FindingsPanel` (Task 3); `useWizard`.
- Produces:
  - `toRouteGraph(detail: QueryDetail): RouteGraph` — pure mapper.
  - `useRouteFindings(detail)` → `{ clientFindings: Finding[]; validateOnServer(): Promise<Finding[]>; serverFindings: Finding[]; all: Finding[] }` (client = `validateRoute(toRouteGraph(detail),"draft")`, deduped; `validateOnServer` POSTs `/api/queries/:id/validate?phase=draft`).
  - `<RouteDiagram detail={QueryDetail} findings={Finding[]} onSelect?={(scope)=>void} />` — SVG node-graph, edges by mode, highlights per finding scope.

- [ ] **Step 1: Failing `toRouteGraph` test**

```ts
it("assembles a RouteGraph with legCargo edges from assignedCargoIds", () => {
  const detail = makeDetail({
    points: [{ id: "p1", type: "PICKUP" }, { id: "p2", type: "DELIVERY" }],
    cargo: [{ id: "c1", poReference: "PO1", isDangerous: false, msdsFileId: null, grossWt: "10", volumeCbm: "1" }],
    legs: [{ id: "l1", legCode: "L1", mode: "ROAD", originPointId: "p1", destinationPointId: "p2", readyDate: null, targetDelivery: null, assignedCargoIds: ["c1"] }],
  });
  const g = toRouteGraph(detail);
  expect(g.legCargo).toEqual([{ legId: "l1", cargoItemId: "c1" }]);
  expect(g.legs[0]).toMatchObject({ legCode: "L1", originPointId: "p1", destinationPointId: "p2" });
});
it("validateRoute flags a broken chain (R2) on this graph in create phase", () => {
  // a chain that ends at a WAREHOUSE, not a delivery → R2 blocking at create
  const findings = validateRoute(toRouteGraph(brokenDetail), "create");
  expect(findings.some((f) => f.rule === "R2")).toBe(true);
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `routeGraph.ts`** — map `detail` → `RouteGraph` exactly per the shared `RouteGraph` field shape (points with all endpoint fields; legs with `legCode`/`mode`/endpoints/dates; cargo with `poReference`/`isDangerous`/`msdsFileId`/`grossWt`/`volumeCbm`; `legCargo` flat-mapped from `legs[].assignedCargoIds`). Pass `Decimal` strings through as-is (the engine coerces).

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Implement `useRouteFindings.ts`** — `clientFindings = useMemo(() => dedupeFindings(validateRoute(toRouteGraph(detail), "draft")), [detail])`; `validateOnServer` = `postJson<{findings:Finding[]}>(\`/api/queries/${detail.id}/validate?phase=draft\`).then(r => dedupeFindings(r.findings))` stored in state; `all = dedupeFindings([...clientFindings, ...serverFindings])`.

- [ ] **Step 6: Failing `RouteDiagram` test** — given a graph with a leg whose destination isn't the next leg's origin (broken chain), and a matching `Finding{rule:"R1",scope:{type:"leg",id:"l2"}}`, the diagram renders that edge with `data-finding="blocking"` (or `data-broken`); an unused point (R3 orphan) renders with `data-orphan`. Assert via `container.querySelector`.

- [ ] **Step 7: Run, confirm fail.**

- [ ] **Step 8: Implement `RouteDiagram.tsx`** (bespoke SVG):
  - **Layout:** compute a column (depth) per point — pickups at depth 0, each leg pushes its destination to `max(depth)+1`; stack points sharing a depth vertically. (Simple longest-path layering; Stage-3 graphs are small.) Map depth→x, index-in-column→y with fixed spacing; keep an SVG `viewBox` sized to the extents.
  - **Nodes:** a rounded rect per point, `font-mono` code + `font-sans` name + city/country; a small type glyph (PICKUP/DELIVERY/WAREHOUSE/AIRPORT/SEAPORT). Highlight: if any finding `scope.type==="point" && scope.id===point.id` → `data-finding` + destructive/warning stroke; if the point is an orphan (no leg touches it) → `data-orphan` + dimmed.
  - **Edges:** a directed line/arrow per leg from origin→destination node, **colored by mode** (ROAD/AIR/SEA tokens), labeled with `legCode`. Highlight: finding `scope.type==="leg" && scope.id===leg.id` → `data-finding="blocking|warning"` + accent/destructive stroke; V-M1 mode-mismatch → destructive.
  - **Legend** (mode colors) + a subtle marigold (`--accent`) treatment on the active/selected leg. Respect `prefers-reduced-motion` (no transition animation when set). `onSelect(scope)` fires on node/edge click (drives the `FindingsPanel` cross-highlight).
  - Redraws automatically because it's a pure function of `detail` (which refreshes after each mutation).

- [ ] **Step 9: Run, confirm pass.**

- [ ] **Step 10: Wire into `LegsStep.tsx`** — replace the placeholder slot with `<RouteDiagram detail={detail} findings={all} onSelect=… />` and a draft `<FindingsPanel phase="draft" findings={all} onFindingClick=… />`; add a **"Validate route"** button calling `validateOnServer()`. The diagram + panel update on every leg/point/cargo add/edit/remove (via the refreshed `detail`).

- [ ] **Step 11: Screenshot critique** — `preview_start`, build a 3-leg route (Road→Sea→Road), screenshot the diagram, critique the signature against `tokens.md` (node legibility, mode colors, broken-chain clarity), refine.

- [ ] **Step 12: Run all web tests + build. Commit.**

```bash
git add apps/web/src/features/query-wizard/steps/legs/routeGraph.ts apps/web/src/features/query-wizard/steps/legs/routeGraph.test.ts \
        apps/web/src/features/query-wizard/steps/legs/useRouteFindings.ts \
        apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx apps/web/src/features/query-wizard/steps/legs/RouteDiagram.test.tsx \
        apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx
git commit -m "feat(web): RouteDiagram (bespoke SVG) + live isomorphic route validation"
```

---

## Task 13: Create Query flow (422 block → RFQ_READY) + end-to-end wizard test

**Files:**
- Modify: `apps/web/src/features/query-wizard/QueryWizardPage.tsx` (finalize Create flow + the optional-gaps prompt)
- Create: `apps/web/src/features/query-wizard/CreateQueryDialog.tsx` (the Cancel / Save Draft / Send Anyway prompt)
- Create: `apps/web/src/features/query-wizard/QueryWizard.e2e.test.tsx` (full-flow component test)

**Interfaces:**
- Consumes: `useCreateQuery`, `useWizard` (Task 5); `collectCreateFindings`, `validateRoute`, `toRouteGraph`, `dedupeFindings`, `ApiError` (`@svyft/shared` + `@/lib/api`); `FindingsPanel`, `Dialog*`.
- Produces: the wired Create Query behavior + a success banner.

- [ ] **Step 1: Failing e2e-style test** — mock the whole API; drive: open `/queries/new` → fill Step 1 minimum (client/contact/email/phone/readyDate/targetDelivery) → **Save** (mints `YAL26-00XX`) → Step 2 set Incoterms → Step 3 add a cargo row → Step 4 create pickup+delivery points + one ROAD leg with the cargo ticked → **Create Query** → assert `POST /api/queries/:id/create` fired and, on `{id,status:"RFQ_READY"}`, the header badge shows **RFQ_READY** and a success banner "created successfully" appears. Then a second run where `create` returns **422** `{findings:[{rule:"R2",severity:"blocking",…}]}` → assert the blocking finding renders and the status stays DRAFT.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `CreateQueryDialog.tsx`** — a confirm dialog for the spec §13 "optional gaps" case: title "Create query with missing optional info?", body lists unchecked checklist items, actions **Cancel · Save Draft · Send Anyway**.

- [ ] **Step 4: Finalize the Create flow in `QueryWizardPage.tsx`**

```ts
async function onCreate() {
  // client preview: block on blocking findings; prompt on optional-only gaps
  const graph = toRouteGraph(detail);
  const preview = dedupeFindings([
    ...collectCreateFindings(toQueryForValidation(detail), detail.cargo.map(toCargoForValidation)),
    ...validateRoute(graph, "create"),
  ]);
  const blocking = preview.filter((f) => f.severity === "blocking");
  if (blocking.length) { setFindings(blocking); setFindingsPhase("create"); return; }         // hard block, inline
  const uncheckedOptional = detail.checklist.filter((c) => !c.checked);
  if (uncheckedOptional.length) { const ok = await confirmCreateDialog(uncheckedOptional); if (ok === "cancel") return; if (ok === "draft") { /* just Save */ return; } }
  try {
    const res = await createQuery.mutateAsync(detail.id);   // POST /create
    await refresh();                                        // re-GET → RFQ_READY graph
    banner.success(`Query ${detail.queryCode} created successfully.`);
  } catch (e) {
    if (e instanceof ApiError && e.findings) { setFindings(e.findings); setFindingsPhase("create"); }
    else throw e;
  }
}
```
Wire `FindingsPanel` in `WizardShell` to `{ findings, phase }`. On success the re-GET flips the header status badge to `RFQ_READY`.

- [ ] **Step 5: Run, confirm pass.**

- [ ] **Step 6: Run full web suite + build. Commit.**

```bash
git add apps/web/src/features/query-wizard/QueryWizardPage.tsx apps/web/src/features/query-wizard/CreateQueryDialog.tsx apps/web/src/features/query-wizard/QueryWizard.e2e.test.tsx
git commit -m "feat(web): Create Query flow (blocking findings → RFQ_READY) + end-to-end wizard test"
```

---

## Task 14: App-wide polish + whole-app design critique

> Design-led. Invoke `frontend-design`. Existing tests must stay green.

**Files:**
- Modify: `apps/web/src/features/auth/LoginPage.tsx`, `features/home/HomePage.tsx`, `features/masters/**/*.tsx`, `features/admin/ConfigPage.tsx`, `components/AppLayout.tsx`

- [ ] **Step 1: Light-polish the earlier screens to the tokens** — replace literal `slate-*`/`red-600` with token classes (`text-foreground`, `text-muted-foreground`, `border-border`, `bg-card`, `text-destructive`), apply `font-display` to page titles, `font-mono tabular-nums` to codes/IMO/dates, and consistent spacing. Do **not** restructure the screens — this is a reskin, not a redesign. Run `pnpm --filter @svyft/web test` after each file to confirm no regression.

- [ ] **Step 2: Whole-app design critique** — `preview_start`; screenshot Login, Query List, each wizard step, the RouteDiagram, and a masters screen. Against `tokens.md`, check: type scale + hierarchy, contrast (WCAG AA), visible keyboard focus ring on every interactive element, empty states (list, cargo, legs), error states (findings, 400 field errors), responsive down to mobile (toolbar wraps, table scrolls, wizard stacks), and `prefers-reduced-motion` respected. Fix drift. Apply the "remove one accessory" pass.

- [ ] **Step 3: Final full CI + commit**

Run: `pnpm run ci` (lint + typecheck + all web + api + shared tests) and `pnpm --filter @svyft/web build`.

```bash
git add apps/web/src
git commit -m "feat(web): app-wide token polish + design critique pass"
```

---

## Plan Self-Review

- **Spec coverage:** §6 list (T4) · §7.1 Step 1 (T6) · §7.2 Step 2 (T7) · §7.3 Cargo + export + MSDS (T8) · §7.4 points/legs/route builder (T10–T12) · §7.5 notes+checklist (T9) · §9 status badges + RFQ_READY (T5/T13) · §10 validation via `validateRoute` + `FindingsPanel` (T3/T12/T13) · §13 form actions incl. optional-gaps prompt (T5/T13) · tech-design §9.2 routes (T4/T5) · §9.4 shell+save model (T5) · §9.5 component decomposition (T10–T12) · §9.6 shared client validation (T3/T12). **§14 escalation/notifications + §15 emails = Plan 7 (out of scope, buttons omitted).** Backend `GET /queries` gap closed (T0).
- **Type consistency fix:** `QueryListRow` (T0) must include **`assignedUserName: string | null`** — the list column (T4 Step 5) reads it. Update T0: add `assignedUserName` to the `QueryListRow` type, and in `QueriesService.list` resolve names via a batched `prisma.user.findMany({ where: { id: { in: [...assignedUserIds] } }, select: { id, name } })` (assignedUserId is a soft ref, no relation) → map into each row. (This is the one cross-task inconsistency found; apply it when executing T0.)
- **Placeholder scan:** all code steps carry real code or an exact pattern reference to a named existing file; no "TBD"/"add validation"/"similar to Task N" left.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/stage-3/2026-07-19-plan-6-wizard-ui.md`.**

Recommended: **subagent-driven** (superpowers:subagent-driven-development) — fresh sonnet implementer per task, per-task spec + quality review, opus whole-branch review at the end — on a fresh `feat/plan-6-wizard-ui` branch, matching the Plan 1–5 flow. **Restart Claude Code first** so the implementer subagents can invoke `frontend-design` by name (Task 1, 12, 14 rely on it).

**Task order:** T0 (backend) → T1–T3 (platform) → T4 (list) → T5 (shell) → T6–T9 (steps 1/2/3/5) → T10–T12 (step 4) → T13 (create) → T14 (polish) → opus review → PR → prod-verify.

