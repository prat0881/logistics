# Stage 3 & 4 — UI/UX Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a batch of UI/UX polish + two bug fixes on the already-built Stage 3 (Create Query wizard, Query List) and Stage 4 (RFQ / Send-to-Freight-Forwarder) screens — no schema change, no new subsystem.

**Architecture:** Mostly frontend (`apps/web/src`), with one backend search change (`apps/api` queries list) and message/label edits in `@svyft/shared`. A single shared presentational component (`ReferenceTagIcons`) is introduced and reused by both the cargo table (Stage 3) and the RFQ header (Stage 4). Validation signalling on the legs page is simplified: page banners + pre-Create live checks are removed; the shell-level top-of-screen `ValidationSummary` (Create-gate findings) is preserved verbatim.

**Tech Stack:** React 18 + TypeScript, TanStack Query, Tailwind + shadcn-style UI, lucide-react, Vitest + React Testing Library (web + shared), Jest + supertest (api e2e), Prisma (read-only here — no migration), pnpm workspaces.

## Global Constraints

- **No Prisma migration, no new dependency.** Do not add a toast library — S4.3 uses a transient in-button confirmation + `aria-live` (there is no toast infra in the app).
- **TDD RED→GREEN** per task; **run `tsc` (typecheck) every task** — vitest/esbuild does NOT type-check, so type errors otherwise pile up silently.
- **`@svyft/shared` is consumed as a BUILT package by web + api.** After any edit under `packages/shared/src`, run `pnpm --filter @svyft/shared build` before running web/api typechecks or tests that depend on it.
- **Commands:**
  - Web test (one file): `pnpm --filter @svyft/web exec vitest run <Pattern>` · Web all: `pnpm --filter @svyft/web test` · Web types: `pnpm --filter @svyft/web typecheck`
  - Shared test: `pnpm --filter @svyft/shared test` · build: `pnpm --filter @svyft/shared build` · types: `pnpm --filter @svyft/shared typecheck`
  - API e2e (runs on CI; needs a DB — may not run locally): `pnpm --filter @svyft/api test <pattern>` · types: `pnpm --filter @svyft/api typecheck`
- **Commit messages** are conventional (`fix(web):`, `feat(rfq):`, `feat(shared):`, …) and END with the trailer line: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **`ReferenceTagIcons` contract (FIXED — Task 1 defines it; Tasks 6 & 10 consume it):** `apps/web/src/components/ReferenceTagIcons.tsx`, `({ tags, isDangerous = false, className }: { tags: readonly ReferenceTag[]; isDangerous?: boolean; className?: string }): React.ReactElement | null`. Icons: HEAVY→`Weight`, FRAGILE→`Wine`, NON_STACKABLE→`Layers`, OUT_OF_GAUGE→`Ruler`; DG→`TriangleAlert` (`text-warning`) appended when `isDangerous`. Labels via `referenceTagLabel(tag)`; DG label literal `"Dangerous goods"`. Returns `null` when nothing to show.
- **Design decisions carried in verbatim:** S3.2 country becomes substring (`contains`, case-insensitive) — was exact. S3.5 is message-string-only (`readyDate` id/column unchanged). S3.6/S3.8 remove ONLY legs-page banners + pre-Create live checks; the shell `ValidationSummary` is untouched. S4.2 is country-only (no backend/schema). **S3.7 is deferred** (rail keeps today's positional behaviour — no task here).

## File structure

| File | Responsibility | Task(s) |
|------|----------------|---------|
| `apps/web/src/components/ReferenceTagIcons.tsx` *(new)* | Shared reference-tag + DG icon row | 1 |
| `packages/shared/src/query.ts`, `legs.ts` | Validation message strings (Target Pickup) | 2 |
| `apps/web/src/features/query-wizard/QueryWizardPage.tsx` | Create-saves-first (S3.3), one-click Next (S3.4) | 3, 4 |
| `apps/web/src/features/query-wizard/WizardContext.tsx` | `localStep`-authoritative step (S3.4) | 4 |
| `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx` | Remove banners + live validation | 5 |
| `…/steps/legs/useRouteFindings.ts` *(delete)* | Retired (sole consumer removed) | 5 |
| `apps/web/src/features/query-wizard/steps/Step3Cargo.tsx` | DG col → Reference Tags icon col | 6 |
| `apps/api/src/modules/queries/queries.service.ts` | Fold country into `q` search | 7 |
| `apps/web/src/features/query-list/QueriesToolbar.tsx` | Remove Country input | 8 |
| `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx` | Default table (S4.4), Regenerate last col (S4.3) | 9, 12 |
| `…/rfq-workspace/CargoTagIcons.tsx`, `QueryOverviewHeader.tsx` | Reference Tags own field (S4.1) | 10 |
| `…/rfq-workspace/LegPanel.tsx` | Origin/dest country scope chip (S4.2) | 11 |
| `…/rfq-workspace/RegeneratePortalLink.tsx` | Auto-copy + transient confirm (S4.3) | 12 |

## Sequencing (dependency order)

`1 (C1 shared icons)` → `2 (msgs)` → `3 (create-saves)` → `4 (one-click Next)` → `5 (legs cleanup)` → `6 (cargo icons — needs 1)` → `7 (country API+shared)` → `8 (country web — needs 7)` → `9 (default table)` → `10 (ref-tag field — needs 1)` → `11 (country scope chip)` → `12 (regenerate — needs 9)`.

Hard deps: **1 before 6 & 10** (imports the shared component); **7 before 8** (removes `country` from the shared `QueryListParams`, so the web typecheck only passes once 8 lands); **9 before 12** (D4's last-column test assumes table is the default). Tasks 3 & 4 both edit `QueryWizardPage.tsx` but in non-overlapping functions — apply either order.

---

### Task 1: Create shared `ReferenceTagIcons` component

**Files:**
- Create — `apps/web/src/components/ReferenceTagIcons.tsx`
- Test — `apps/web/src/components/ReferenceTagIcons.test.tsx`

**Interfaces:**
- Consumes: `REFERENCE_TAGS`, `referenceTagLabel`, `type ReferenceTag` from `@svyft/shared`; `cn` from `@/lib/utils`; lucide `Weight`, `Wine`, `Layers`, `Ruler`, `TriangleAlert`.
- Produces: `ReferenceTagIcons({ tags: readonly ReferenceTag[]; isDangerous?: boolean; className?: string }): React.ReactElement | null` at `@/components/ReferenceTagIcons`.

- [ ] **Step 1: Write the failing test** — create `apps/web/src/components/ReferenceTagIcons.test.tsx` (mirrors the `render`/`screen`/`getByLabelText`/`toBeEmptyDOMElement` idiom from `apps/web/src/features/rfq-workspace/CargoTagIcons.test.tsx`; jest-dom matchers are global via the vitest setup):

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReferenceTagIcons } from "./ReferenceTagIcons";

describe("ReferenceTagIcons", () => {
  it("renders an icon (by aria-label) for each reference tag incl. OUT_OF_GAUGE", () => {
    render(<ReferenceTagIcons tags={["HEAVY", "FRAGILE", "NON_STACKABLE", "OUT_OF_GAUGE"]} />);
    expect(screen.getByLabelText("Heavy")).toBeInTheDocument();
    expect(screen.getByLabelText("Fragile")).toBeInTheDocument();
    expect(screen.getByLabelText("Non Stackable")).toBeInTheDocument();
    expect(screen.getByLabelText("Out of Gauge Cargo")).toBeInTheDocument();
    expect(screen.queryByLabelText("Dangerous goods")).toBeNull();
  });

  it("renders the DG icon when isDangerous is true", () => {
    render(<ReferenceTagIcons tags={[]} isDangerous />);
    expect(screen.getByLabelText("Dangerous goods")).toBeInTheDocument();
  });

  it("returns null (empty) when tags=[] and not dangerous", () => {
    const { container } = render(<ReferenceTagIcons tags={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run src/components/ReferenceTagIcons.test.tsx` · Expected: FAIL (module `./ReferenceTagIcons` not found).

- [ ] **Step 3: Implement** — create `apps/web/src/components/ReferenceTagIcons.tsx`:

```tsx
import { Weight, Wine, Layers, Ruler, TriangleAlert } from "lucide-react";
import { REFERENCE_TAGS, referenceTagLabel, type ReferenceTag } from "@svyft/shared";
import { cn } from "@/lib/utils";

const TAG_ICON: Record<ReferenceTag, React.ReactElement> = {
  HEAVY: <Weight className="h-4 w-4" />,
  FRAGILE: <Wine className="h-4 w-4" />,
  NON_STACKABLE: <Layers className="h-4 w-4" />,
  OUT_OF_GAUGE: <Ruler className="h-4 w-4" />,
};

export function ReferenceTagIcons({
  tags,
  isDangerous = false,
  className,
}: {
  tags: readonly ReferenceTag[];
  isDangerous?: boolean;
  className?: string;
}): React.ReactElement | null {
  const items: { key: string; label: string; icon: React.ReactElement }[] = [];
  for (const tag of REFERENCE_TAGS) {
    if (tags.includes(tag))
      items.push({ key: tag, label: referenceTagLabel(tag), icon: TAG_ICON[tag] });
  }
  if (isDangerous)
    items.push({ key: "DG", label: "Dangerous goods", icon: <TriangleAlert className="h-4 w-4 text-warning" /> });

  if (items.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {items.map((it) => (
        <span key={it.key} title={it.label} aria-label={it.label} className="text-muted-foreground">
          {it.icon}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run src/components/ReferenceTagIcons.test.tsx && pnpm --filter @svyft/web typecheck` · Expected: PASS (3 green), no type errors. (`REFERENCE_TAGS`/`referenceTagLabel` are pre-existing built exports — no shared rebuild needed.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ReferenceTagIcons.tsx apps/web/src/components/ReferenceTagIcons.test.tsx
git commit -m "feat(web): add shared ReferenceTagIcons component (S3.1/S4.1)

Shared presentation for reference-tag icons incl. OUT_OF_GAUGE (Ruler) plus a
distinct DG (TriangleAlert) indicator. Consumed by the cargo table + RFQ header.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Rename "Ready Date" → "Target Pickup" in validation messages (S3.5)

**Files:**
- Modify — `packages/shared/src/query.ts` (G10 refine comment+message ~lines 125–131; `collectCreateFindings` message ~line 187)
- Modify — `packages/shared/src/legs.ts` (G10 refine comment+message ~lines 32–38)
- Test — `packages/shared/src/query.test.ts` (G10 block + `collectCreateFindings` block); `packages/shared/src/legs.test.ts` (`legSaveSchema` block)

**Interfaces:** Consumes `querySaveSchema`/`legSaveSchema`/`collectCreateFindings`. Produces messages `"Target Pickup must be on or before Target Delivery"` and `"Target Pickup is required"`. Field id `readyDate` and DB column unchanged.

- [ ] **Step 1: Write the failing test** — in `packages/shared/src/query.test.ts`, add inside `describe("readyDate ≤ targetDelivery (G10)")`:

```ts
    it("pins the G10 message to the 'Target Pickup' label (S3.5)", () => {
      const res = querySaveSchema.safeParse({
        readyDate: "2026-08-10T00:00:00.000Z",
        targetDelivery: "2026-08-01T00:00:00.000Z",
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toBe("Target Pickup must be on or before Target Delivery");
      }
    });
```

add inside `describe("collectCreateFindings …")`:

```ts
  it("labels the missing readyDate finding 'Target Pickup is required' (S3.5)", () => {
    const f = collectCreateFindings({ ...ready, readyDate: null }, []);
    expect(f.map((x) => x.message)).toContain("Target Pickup is required");
    expect(f.map((x) => x.message)).not.toContain("Ready Date is required");
  });
```

in `packages/shared/src/legs.test.ts`, add inside `describe("legSaveSchema")`:

```ts
  it("pins the G10 message to the 'Target Pickup' label (S3.5)", () => {
    const res = legSaveSchema.safeParse({
      readyDate: "2026-08-10T00:00:00.000Z",
      targetDelivery: "2026-08-01T00:00:00.000Z",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toBe("Target Pickup must be on or before Target Delivery");
    }
  });
```

> Note: `ready` is the existing fixture in the `collectCreateFindings` describe block — confirm its name when adding (it is the valid `QueryForValidation` object those tests spread).

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/shared test` · Expected: FAIL — current strings are `"Ready Date …"`; the three new assertions expect `"Target Pickup …"`.

- [ ] **Step 3: Implement** — in `packages/shared/src/query.ts` G10 refine (~125–131):

```ts
  // G10: Target Pickup must be on or before Target Delivery (when both are present).
  .refine(
    (q) =>
      !(q.readyDate && q.targetDelivery) ||
      new Date(q.readyDate).getTime() <= new Date(q.targetDelivery).getTime(),
    { message: "Target Pickup must be on or before Target Delivery", path: ["targetDelivery"] },
  );
```

`collectCreateFindings` presence check (~line 187): `need(q.readyDate, "Target Pickup is required");`

in `packages/shared/src/legs.ts` G10 refine (~32–38):

```ts
  // G10: Target Pickup must be on or before Target Delivery (when both are present).
  .refine(
    (l) =>
      !(l.readyDate && l.targetDelivery) ||
      new Date(l.readyDate).getTime() <= new Date(l.targetDelivery).getTime(),
    { message: "Target Pickup must be on or before Target Delivery", path: ["targetDelivery"] },
  )
```

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/shared test && pnpm --filter @svyft/shared typecheck` · Expected: PASS, no type errors. No web test asserts these strings (verified — the exact old strings live only in `query.ts`/`legs.ts`), so no `@svyft/shared` build is required for other tasks on account of B1.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/query.ts packages/shared/src/legs.ts packages/shared/src/query.test.ts packages/shared/src/legs.test.ts
git commit -m "feat(shared): rename validation message 'Ready Date' -> 'Target Pickup' (S3.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Create Query saves the current step before the gate (S3.3)

**Files:**
- Modify — `apps/web/src/features/query-wizard/QueryWizardPage.tsx`: imports (lines 1–10); `WizardInner` (add `qc` after line 77); `handleCreateQuery` (lines 128–169). Does NOT touch `handleSave` (Task 4's region).
- Test — `apps/web/src/features/query-wizard/QueryWizardPage.test.tsx`: append one `it` inside `describe("QueryWizardPage", …)`.

**Interfaces:** Consumes `handleSave: () => Promise<void>`, `refresh: () => Promise<void>`, `useQueryClient().getQueryData<QueryDetail>(["query", id])`, `createQuery.mutateAsync(id): Promise<{ id; status }>`. Produces `handleCreateQuery: () => Promise<void>` (unchanged signature).

> **Verify before implementing:** confirm the react-query cache key for the detail (`["query", id]`) and the `QueryDetail` type name by reading `apps/web/src/features/query-wizard/useQueryDetail.ts` / `WizardContext.tsx`. `getQueryData` with a wrong key returns `undefined` and the code falls back to the stale closure `detail` — silently defeating the fix. Also confirm `refresh()` awaits the refetch (it invalidates `["query", queryId]`); if it does not settle the refetch, the freshly-saved checklist may not be in cache yet — in that case await the save's own settled cache or read from the mutation result instead.

- [ ] **Step 1: Write the failing test** — append inside `describe("QueryWizardPage", …)`:

```tsx
  it("Create Query saves the current step (checklist) before running the gate (S3.3)", async () => {
    let checklistPersisted = false;
    const events: string[] = [];
    const baseChecklist = [
      { id: "c1", itemKey: "weight-confirmed", checked: false },
      { id: "c2", itemKey: "dimensions-confirmed", checked: false },
    ];
    const detailFor = () => ({
      ...fullDraftDetail,
      internalNotes: "Ready for RFQ",
      checklist: baseChecklist.map((c) => ({ ...c, checked: checklistPersisted })),
    });

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9/checklist") && init?.method === "PATCH") {
          events.push("checklist");
          checklistPersisted = true;
          return { status: 200, body: {} };
        }
        if (url.includes("/api/queries/q9/create") && init?.method === "POST") {
          events.push("create");
          return { status: 201, body: { id: "q9", status: "RFQ_READY" } };
        }
        if (url.includes("/api/queries/q9")) return { status: 200, body: detailFor() };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/q9?step=4", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    const weight = await screen.findByRole("checkbox", { name: /Weight confirmed/i });
    const dims = screen.getByRole("checkbox", { name: /Dimensions confirmed/i });
    await userEvent.click(weight);
    await userEvent.click(dims);

    await userEvent.click(screen.getByRole("button", { name: /Create Query/i }));

    expect(await screen.findByText(/created successfully/i)).toBeInTheDocument();
    expect(events).toEqual(["checklist", "create"]);
  });
```

> Match `fullDraftDetail`/checklist label wiring to the existing fixtures in this test file (the surrounding Create tests deep-link `?step=4` and drive the Notes step). Adjust the checklist `itemKey`s/labels to whatever the file's fixtures + `CHECKLIST_LABELS` already use so the boxes are found by role name.

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run QueryWizardPage` · Expected: FAIL — current `handleCreateQuery` never runs the step save, so no `PATCH /checklist` fires; the gate reads stale (unchecked) `detail`, `collectChecklistFindings` blocks, and it returns before `/create`. `events` is `[]` and no success banner appears.

- [ ] **Step 3: Implement** — in the import block, add `useQueryClient` and the `QueryDetail` type:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import type { Finding, QueryForValidation, CargoForValidation, QuerySaveInput, QueryDetail } from "@svyft/shared";
```

in `WizardInner`, after `const createQuery = useCreateQuery();` (line 77):

```tsx
  const qc = useQueryClient();
```

replace the whole `handleCreateQuery` (lines 128–169) with (save current step → refresh → gate against FRESH detail → create):

```tsx
  const handleCreateQuery = useCallback(async () => {
    if (!id || !detail) return;
    setFindings([]);
    setSuccessBanner(null);

    // ── 0. S3.3 — save the current step first (same as the Save button), then
    //        re-fetch, so the gate reads freshly-persisted state. Checklist ticks
    //        live in Step5Notes' local state and only reach the server via the
    //        step's save (PATCH /checklist); without this the gate reads a stale
    //        `detail` and blocks Create even though the boxes are ticked. ───────
    try {
      await handleSave();
    } catch {
      /* best-effort: inline field errors already surface any format issue */
    }
    await refresh();
    const fresh = qc.getQueryData<QueryDetail>(["query", id]) ?? detail;

    // ── 1. Client-side preview (against the FRESH detail) ────────────────────
    const graph = toRouteGraph(fresh);
    const checklistItems = fresh.checklist.map((c) => ({
      key: c.itemKey,
      checked: c.checked,
      label: CHECKLIST_LABELS[c.itemKey] ?? c.itemKey,
    }));
    const preview = dedupeFindings([
      ...collectCreateFindings(toQueryForValidation(fresh), fresh.cargo.map(toCargoForValidation)),
      ...validateRoute(graph, "create"),
      ...collectChecklistFindings(checklistItems, fresh.internalNotes),
    ]);
    const blocking = preview.filter((f) => f.severity === "blocking");
    if (blocking.length) {
      setFindings(blocking);
      return; // Create is the single gate — abort before the server call
    }

    // ── 2. POST /create ──────────────────────────────────────────────────────
    try {
      await createQuery.mutateAsync(id);
      await refresh();
      const code = fresh.queryCode ?? id;
      setSuccessBanner(`Query ${code} created successfully.`);
    } catch (err) {
      if (err instanceof ApiError && err.findings) {
        setFindings(err.findings);
      } else {
        throw err;
      }
    }
  }, [id, detail, createQuery, refresh, handleSave, qc]);
```

(`handleSave` is declared above at line 93. For the Notes step, its existing-query branch runs the Notes save fn — which PATCHes notes + `PATCH /checklist` and awaits its own cache invalidation — returning `undefined`, so no extra `patch` fires.)

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run QueryWizardPage && pnpm --filter @svyft/web typecheck` · Expected: PASS (new test green; the four existing `?step=4` Create tests still gate correctly — the Notes `handleSave` only persists, and "client preview blocks" / "MSDS unchecked" / "incomplete checklist" cases still abort with no `/create`). No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/QueryWizardPage.tsx apps/web/src/features/query-wizard/QueryWizardPage.test.tsx
git commit -m "fix(web): save current step before Create Query gate (S3.3)

Create Query now runs the same per-step save as the Save button (persisting the
Step5Notes checklist via PATCH /checklist), refreshes, and gates against the fresh
detail — so freshly ticked checklist items are no longer lost and Create is no
longer wrongly blocked.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: First "Next" advances a new query in one click (S3.4)

**Files:**
- Modify — `apps/web/src/features/query-wizard/QueryWizardPage.tsx`: `handleSave` doc comment (lines 88–92) + the new-query navigate (line 106) only.
- Modify — `apps/web/src/features/query-wizard/WizardContext.tsx`: import (line 1); step derivation + a new sync effect (lines 41–48); `setStep` (50–66); `goNext` (68–79); `goBack` (81–92).
- Test — `apps/web/src/features/query-wizard/QueryWizardPage.test.tsx`: append one `it`.

**Interfaces:** Consumes `create: (input: QuerySaveInput) => Promise<QueryDetail>`, `useNavigate`, `useSearchParams`. Produces `step` (derived from `localStep`); `goNext`/`goBack`/`setStep` (update `localStep` + URL `?step` when `queryId` present) — signatures unchanged.

> **Deviation from the design doc (intentional):** the doc says "navigate to `?step=1`". That would make the **Save** button also advance a new query (Save and Next share `handleSave`). Instead we drop the step param on mint (`/queries/:id`) and make `localStep` authoritative: Next advances via `goNext`, Save stays put. Net effect matches the doc's intent (one-click Next, non-blocking). **Assumption (verified):** `/queries/new` and `/queries/:id` render the same `<QueryWizardPage/>` element type with no `key` (App.tsx + both test files), so React does NOT remount across the mint nav and `localStep` survives. If a future `key={id}` is added, this regresses — flag for reviewers.

- [ ] **Step 1: Write the failing test** — append inside `describe("QueryWizardPage", …)`:

```tsx
  it("first Next on a new query advances to Shipment in a single click (S3.4)", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.endsWith("/api/queries") && init?.method === "POST") {
          posts.push(JSON.parse(init.body as string));
          return { status: 201, body: draftDetail };
        }
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/new" element={<QueryWizardPage />} />
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    expect(await screen.findByRole("heading", { name: /Query Details/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    expect(await screen.findByRole("heading", { name: /Shipment Details/i })).toBeInTheDocument();
    await waitFor(() => expect(posts.length).toBe(1));
    expect(screen.queryByRole("heading", { name: /Query Details/i })).not.toBeInTheDocument();
  });
```

> Match `draftDetail` + the step headings (`/Query Details/i`, `/Shipment Details/i`) to the file's existing fixtures/markup.

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run QueryWizardPage` · Expected: FAIL — after one Next the current code mints then `navigate('/queries/q9?step=0')`; with `queryId` defined the provider reads `step = clampedStep = 0`, discarding `goNext`'s `localStep = 1`. Stays on "Client & Query", so the "Shipment Details" heading times out.

- [ ] **Step 3: Implement**

**(a) `WizardContext.tsx`** — line 1, add `useEffect`:

```tsx
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
```

lines 41–48 — make `localStep` authoritative, sync an explicit `?step=` in only when present:

```tsx
  const stepParam = parseInt(searchParams.get("step") ?? "0", 10);
  const clampedStep = Number.isNaN(stepParam) ? 0 : Math.max(0, Math.min(stepParam, STEPS.length - 1));
  const [localStep, setLocalStep] = useState<number>(clampedStep);

  const { data: detail } = useQueryDetail(queryId);

  // `localStep` is the single source of truth for the active step (S3.4). For an
  // existing query we still honour an explicit ?step= (deep-link, back/forward) by
  // syncing it in — but ONLY when the param is present, so a freshly-minted query
  // (navigated to /queries/:id with no ?step) keeps the step goNext just advanced
  // to instead of being forced back to 0.
  useEffect(() => {
    if (!queryId) return;
    if (!searchParams.has("step")) return;
    setLocalStep(clampedStep);
  }, [queryId, searchParams, clampedStep]);

  const step = localStep;
```

`setStep` (50–66) — set `localStep`, plus URL when `queryId`:

```tsx
      if (!detail) return;
      setLocalStep(clamped);
      if (queryId) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("step", String(clamped));
          return next;
        });
      }
```

`goNext` (68–79):

```tsx
  const goNext = useCallback(() => {
    const next = Math.min(step + 1, STEPS.length - 1);
    setLocalStep(next);
    if (queryId) {
      setSearchParams((prev) => {
        const ns = new URLSearchParams(prev);
        ns.set("step", String(next));
        return ns;
      });
    }
  }, [step, queryId, setSearchParams]);
```

`goBack` (81–92):

```tsx
  const goBack = useCallback(() => {
    const prev = Math.max(step - 1, 0);
    setLocalStep(prev);
    if (queryId) {
      setSearchParams((sp) => {
        const ns = new URLSearchParams(sp);
        ns.set("step", String(prev));
        return ns;
      });
    }
  }, [step, queryId, setSearchParams]);
```

**(b) `QueryWizardPage.tsx`** — `handleSave` new-query branch: update the doc comment (88–92) and change the navigate (line 106) from `navigate(\`/queries/${d.id}?step=0\`, { replace: true });` to:

```tsx
        const d = await create(input ?? {});
        navigate(`/queries/${d.id}`, { replace: true });
        return;
```

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run QueryWizardPage && pnpm --filter @svyft/web typecheck` · Expected: PASS. New test green. Existing tests stay green: "Next advances to Step 2…" (existing `q9`, no `?step`) → `goNext` sets `localStep=1` + `?step=1`; the four `?step=4` Create tests → `localStep` inits to 4 and the effect syncs 4; the e2e happy path → Save mints to `/queries/q9`, then stepper `setStep(4)` lands on the final step. No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/QueryWizardPage.tsx apps/web/src/features/query-wizard/WizardContext.tsx apps/web/src/features/query-wizard/QueryWizardPage.test.tsx
git commit -m "fix(web): first Next advances a new query in one click (S3.4)

Mint navigates to /queries/:id without a hardcoded ?step=0, and the wizard derives
the active step from localStep (syncing an explicit ?step= in only when present).
goNext's advance is no longer discarded when queryId appears.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Remove legs-page banners + pre-Create live validation (S3.6 + S3.8)

**Files:**
- Modify — `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx` (remove `RouteNoticesStrip` def; `useRouteFindings` call; `incompleteLegs`; both strips; `findings={all}` → `findings={[]}`)
- Delete (retire) — `…/steps/legs/useRouteFindings.ts` and `…/steps/legs/useRouteFindings.test.ts` (LegsStep is the sole runtime consumer — verified)
- Test — `…/steps/legs/LegsStep.test.tsx` (add 2 tests; delete 3 obsolete tests)
- Do NOT modify — `apps/web/src/features/query-wizard/WizardShell.tsx` or `apps/web/src/components/ValidationSummary.tsx`

**Interfaces:** Consumes `QueryDetail` (via `useWizard`); `RouteDiagram` keeps its required `findings: Finding[]` prop — now always `[]` here. Produces a legs step with no page banners and no pre-Create validation. Route/leg findings come ONLY from the Create gate and render in the shell `ValidationSummary` (unchanged).

- [ ] **Step 1: Write the failing test** — in `…/legs/LegsStep.test.tsx`, add inside `describe("LegsStep", …)` (reuses module-level `detailWithDangling`, `detailWithLeg`, `LEG_ID`, `testUser`, `QUERY_ID`, `navigateToStep4`, `mockFetch`):

```tsx
  it("shows no legs-page validation banners and fires no /validate request while editing (S3.6/S3.8)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: detailWithDangling };
        return { status: 200, body: {} };
      }),
    );
    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );
    await navigateToStep4();
    await waitFor(() => expect(document.querySelector('[data-slot="route-diagram"]')).toBeInTheDocument());
    expect(screen.queryByText(/hover the highlighted boxes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/issues? to resolve/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /incomplete legs/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/can't be shown on the route/i)).not.toBeInTheDocument();
    const calls: unknown[][] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((args) => String(args[0]).includes("/validate"))).toBe(false);
  });

  it("does not paint live inline route-validation highlights on the diagram (S3.6)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: detailWithLeg };
        return { status: 200, body: {} };
      }),
    );
    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );
    await navigateToStep4();
    await waitFor(() => expect(document.querySelector(`[data-leg-id="${LEG_ID}"]`)).toBeInTheDocument());
    expect(document.querySelector("[data-leg-id][data-finding]")).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run LegsStep` · Expected: FAIL — `detailWithDangling` currently renders `RouteNoticesStrip` ("hover the highlighted boxes") + the incomplete-legs `role="group"` strip; `detailWithLeg` produces a live blocking finding so the edge carries `data-finding`.

- [ ] **Step 3: Implement** — replace `…/legs/LegsStep.tsx` in full (banners + live validation removed, `findings={[]}`):

```tsx
import { useEffect, useState, type ComponentProps } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useWizard } from "../../WizardContext";
import { useSaveQuery } from "../../useQueryDetail";
import type { StepSaveFn } from "../Step1Client";
import { LegEditor } from "./LegEditor";
import { PointEditor } from "./PointEditor";
import { RouteDiagram } from "./RouteDiagram";
import type { QueryDetail, QueryLegDto, QueryPointDto } from "@svyft/shared";

// Legs step index (0-based): client=0, shipment=1, cargo=2, legs=3, notes=4
const LEGS_STEP_INDEX = 3;

/**
 * LegsStepBody — Step 4 content once the query exists.
 * Route/leg validation is Create-only (S3.6/S3.8): no page banners, no pre-Create
 * live checks here. The Create Query gate runs `validateRoute`, and its findings
 * render in the shell-level ValidationSummary at the top of every step
 * (WizardShell) — that behaviour is untouched.
 */
function LegsStepBody({
  detail,
  queryId,
  registerSave,
}: {
  detail: QueryDetail;
  queryId: string;
  registerSave: (fn: StepSaveFn) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Legs/points persist eagerly; nothing to save here, and validation is Create-only.
  useEffect(() => {
    registerSave(() => Promise.resolve(undefined));
  }, [registerSave]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingLeg, setEditingLeg] = useState<QueryLegDto | undefined>(undefined);
  const [pointEditorOpen, setPointEditorOpen] = useState(false);
  const [editingPoint, setEditingPoint] = useState<QueryPointDto | undefined>(undefined);

  const handleAddLeg = () => {
    setEditingLeg(undefined);
    setEditorOpen(true);
  };
  const handleEdit = (leg: QueryLegDto) => {
    setEditingLeg(leg);
    setEditorOpen(true);
  };
  const closeLegEditor = () => {
    setEditorOpen(false);
    setEditingLeg(undefined);
  };

  const handleAddPoint = () => {
    setEditingPoint(undefined);
    setPointEditorOpen(true);
  };
  const handleEditPoint = (pt: QueryPointDto) => {
    setEditingPoint(pt);
    setPointEditorOpen(true);
  };
  const closePointEditor = () => {
    setPointEditorOpen(false);
    setEditingPoint(undefined);
  };

  // Consume the ?add= param minted by the pre-mint wrapper. Mount-only.
  useEffect(() => {
    const add = searchParams.get("add");
    if (add === "point") handleAddPoint();
    else if (add === "leg") handleAddLeg();
    if (add) {
      const next = new URLSearchParams(searchParams);
      next.delete("add");
      setSearchParams(next, { replace: true });
    }
  }, []); // intentional: mount-only

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-base font-semibold">Leg & Route</h2>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleAddPoint}>
          + Add point
        </Button>
        <Button size="sm" onClick={handleAddLeg}>
          + Add leg
        </Button>
      </div>

      {/* Route diagram — the primary editing surface. No live findings passed:
          route validation runs only at Create Query (shell ValidationSummary). */}
      <RouteDiagram
        detail={detail}
        findings={[]}
        onEditPoint={(id) => {
          const pt = detail.points.find((p) => p.id === id);
          if (pt) handleEditPoint(pt);
        }}
        onEditLeg={(id) => {
          const leg = detail.legs.find((l) => l.id === id);
          if (leg) handleEdit(leg);
        }}
      />

      <LegEditor
        open={editorOpen}
        leg={editingLeg}
        detail={detail}
        queryId={queryId}
        onSaved={closeLegEditor}
        onClose={closeLegEditor}
      />

      <PointEditor
        key={editingPoint?.id ?? "new-point"}
        queryId={queryId}
        open={pointEditorOpen}
        point={editingPoint as unknown as ComponentProps<typeof PointEditor>["point"]}
        legs={detail.legs}
        onSaved={closePointEditor}
        onClose={closePointEditor}
      />
    </div>
  );
}

/**
 * LegsStep — Step 4. Thin wrapper: before the query is minted it shows the same
 * "+ Add point" / "+ Add leg" toolbar; each button mints the query then navigates
 * with `?add=point|leg` so `LegsStepBody` opens the right editor on load.
 */
export function LegsStep({ registerSave }: { registerSave: (fn: StepSaveFn) => void }) {
  const { detail, queryId } = useWizard();
  const navigate = useNavigate();
  const { create } = useSaveQuery();
  const [minting, setMinting] = useState(false);

  const hasBody = Boolean(detail && queryId);
  useEffect(() => {
    if (!hasBody) registerSave(() => Promise.resolve());
  }, [hasBody, registerSave]);

  if (detail && queryId) {
    return <LegsStepBody detail={detail} queryId={queryId} registerSave={registerSave} />;
  }

  const handleMintAdd = async (what: "point" | "leg") => {
    setMinting(true);
    try {
      const d = await create({});
      navigate(`/queries/${d.id}?step=${LEGS_STEP_INDEX}&add=${what}`, { replace: true });
    } finally {
      setMinting(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-base font-semibold">Leg & Route</h2>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => handleMintAdd("point")} disabled={minting}>
          {minting ? "Saving…" : "+ Add point"}
        </Button>
        <Button size="sm" onClick={() => handleMintAdd("leg")} disabled={minting}>
          {minting ? "Saving…" : "+ Add leg"}
        </Button>
      </div>
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        Add the first leg to build the route.
      </div>
    </div>
  );
}
```

> **Verify before replacing:** diff this against the current `LegsStep.tsx` and preserve any behaviour not explicitly targeted for removal (the above reproduces the file with ONLY the banners + `useRouteFindings` + `incompleteLegs` removed and `findings={[]}`). If the current file has extra props/handlers on `RouteDiagram`/`LegEditor`/`PointEditor`, keep them.

Then retire the now-unused hook (LegsStep was its only runtime consumer):

```bash
git rm apps/web/src/features/query-wizard/steps/legs/useRouteFindings.ts \
       apps/web/src/features/query-wizard/steps/legs/useRouteFindings.test.ts
```

Then delete the three obsolete `LegsStep.test.tsx` tests (keep their `detailWithLeg`/`detailWithDangling` fixtures — the new tests use them):
1. `"shows route findings notices strip and canvas (Legs rework)"`,
2. `"shows route findings as a hover tooltip on the diagram edge (Legs rework step 4)"`,
3. `"lists an incomplete (dangling-endpoint) leg in the escape strip and opens the editor on click"`.

> **Regression (do NOT modify `WizardShell.tsx`):** the shell `ValidationSummary` (~WizardShell.tsx 211–231) renders from `QueryWizardPage`'s create-gate `findings` state — independent of `useRouteFindings`. After Create on an invalid route, `validateRoute` findings show under the "Leg & Route" heading at the top of every step, incl. the legs step and after navigating to it. The existing test `"Next advances from Step 4 even when the route has errors"` stays green (Next is non-blocking; no `/validate` required).

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run LegsStep && pnpm --filter @svyft/web typecheck` · Expected: PASS — two new tests pass; retained LegsStep tests (toolbar/canvas, point-click, add-leg dialog, mint, Next-advances, empty-state, `?add=leg`, `?add=point`) pass; no dangling `./useRouteFindings` import; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx apps/web/src/features/query-wizard/steps/legs/LegsStep.test.tsx
git commit -m "feat(web): remove legs-page banners + pre-Create live route validation (S3.6/S3.8)

Route validation is now Create-only; the shell top-of-screen ValidationSummary is
unchanged and still shows Leg & Route findings on every step after Create. Retire
useRouteFindings (sole consumer removed).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Cargo table DG column → "Reference Tags" icon column (S3.1)

**Files:**
- Modify — `apps/web/src/features/query-wizard/steps/Step3Cargo.tsx` (import block; header `<TableHead>DG</TableHead>` line 150; body cell `{row.isDangerous ? "Yes" : "No"}` line 179)
- Test — `apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx` (add one `it` inside `describe("Step3Cargo")`)

**Interfaces:** Consumes `ReferenceTagIcons` from `@/components/ReferenceTagIcons` (Task 1); rows are `CargoDto[]` (`Step3Cargo.tsx:54` `const cargoRows: CargoDto[] = detail?.cargo ?? []`), so `row.referenceTags: ReferenceTag[]` + `row.isDangerous: boolean`. Produces renamed header + per-row `<ReferenceTagIcons tags={row.referenceTags} isDangerous={row.isDangerous} />`.

- [ ] **Step 1: Write the failing test** — add to `Step3Cargo.test.tsx` inside `describe("Step3Cargo", …)` (uses existing `baseDetail`, `cargoRowDto`, `navigateToStep3`, `within`):

```tsx
  it("S3.1: renders a Reference Tags icon column (tags + DG) and drops the DG Yes/No text", async () => {
    const heavyRow = { ...cargoRowDto, id: "aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa", rowIndex: 0, poReference: "PO-HEAVY", referenceTags: ["HEAVY"], isDangerous: false };
    const dgRow = { ...cargoRowDto, id: "bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb", rowIndex: 1, poReference: "PO-DG", referenceTags: [], isDangerous: true };
    const detailWithTagged = { ...baseDetail, cargo: [heavyRow, dgRow] };

    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } }), text: () => Promise.resolve(""), blob: () => Promise.resolve(new Blob()) } as Response);
      if (url === `/api/queries/${QUERY_ID}`)
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(detailWithTagged), text: () => Promise.resolve(JSON.stringify(detailWithTagged)), blob: () => Promise.resolve(new Blob()) } as Response);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve(""), blob: () => Promise.resolve(new Blob()) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=2` },
    );

    await navigateToStep3();
    await screen.findByText("PO-HEAVY");

    expect(screen.getByRole("columnheader", { name: /reference tags/i })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "DG" })).toBeNull();

    const heavyRowEl = screen.getByText("PO-HEAVY").closest("tr")!;
    expect(within(heavyRowEl).getByLabelText("Heavy")).toBeInTheDocument();
    expect(within(heavyRowEl).queryByText("No")).toBeNull();

    const dgRowEl = screen.getByText("PO-DG").closest("tr")!;
    expect(within(dgRowEl).getByLabelText("Dangerous goods")).toBeInTheDocument();
    expect(within(dgRowEl).queryByText("Yes")).toBeNull();
  });
```

> Match `baseDetail`/`cargoRowDto`/`navigateToStep3`/`QUERY_ID` to the file's existing fixtures.

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run src/features/query-wizard/steps/Step3Cargo.test.tsx -t "Reference Tags icon column"` · Expected: FAIL — header is still "DG", cell renders "Yes"/"No", no icons.

- [ ] **Step 3: Implement** — in `Step3Cargo.tsx`:
  1. Add near the `@/components/ui/*` imports: `import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";`
  2. Replace header line 150 `<TableHead>DG</TableHead>` → `<TableHead>Reference Tags</TableHead>`
  3. Replace body cell line 179 `<TableCell>{row.isDangerous ? "Yes" : "No"}</TableCell>` →
     ```tsx
     <TableCell>
       <ReferenceTagIcons tags={row.referenceTags} isDangerous={row.isDangerous} />
     </TableCell>
     ```

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run src/features/query-wizard/steps/Step3Cargo.test.tsx && pnpm --filter @svyft/web typecheck` · Expected: PASS — pre-existing Step3Cargo tests stay green (their fixture rows have `referenceTags: []` + `isDangerous:false` → cell renders `null`). No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/Step3Cargo.tsx apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx
git commit -m "feat(web): cargo table DG column -> Reference Tags icons (S3.1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Fold Country into the combined `q` search — API + shared (S3.2)

**Files:**
- Modify — `apps/api/src/modules/queries/queries.service.ts` (`list()` destructure line 75; `q` OR-clause lines 87–96; standalone `country` block lines 108–117)
- Modify — `packages/shared/src/query.ts` (`queryListQuerySchema` `country` field, line 284)
- Test — `apps/api/test/queries-list.e2e-spec.ts` (promote `q2Id` to suite scope; add two `it` blocks after line 153)

**Interfaces:** Consumes `Prisma.QueryWhereInput`, `Prisma.EnumPointTypeFilter` (already imported). Produces a `points`-country branch inside the `q` OR-clause (`contains`, `insensitive`, `type in [PICKUP, DELIVERY]`); `QueryListParams` no longer carries `country`.

- [ ] **Step 1: Write the failing test** — in `queries-list.e2e-spec.ts`: promote `q2Id` to suite scope (add `let q2Id: string;` after line 24; change line 83 to `q2Id = resQ2.body.id as string;`), then add after line 153:

```ts
  it("S3.2: q matches PICKUP/DELIVERY point country (contains, case-insensitive)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/queries?q=in&pageSize=100")
      .set("Cookie", authCookie)
      .expect(200);
    expect(res.body.items.some((r: { id: string }) => r.id === q2Id)).toBe(true);
  });

  it("S3.2: the standalone country param is gone (folded into q, so it no longer filters)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/queries?q=${PFX}&country=ZZ`)
      .set("Cookie", authCookie)
      .expect(200);
    expect(res.body.total).toBe(3);
  });
```

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/api test queries-list` · Expected: FAIL — `?q=in` doesn't return Q2 (country not in the `q` OR yet); `?q=<PFX>&country=ZZ` returns `total: 0` (standalone country block still applies ZZ).

- [ ] **Step 3: Implement**
  1. `packages/shared/src/query.ts` — delete the `country` field from `queryListQuerySchema` (line 284: `country: z.string().trim().min(1).optional(),`). Leave `country` on `PointRef` (line 322) and line 363 untouched (unrelated).
  2. `queries.service.ts` — remove `country` from the destructure (lines 74–77).
  3. `queries.service.ts` — replace the `q` OR-clause (lines 87–96) with (adds the country branch):

```ts
      ...(q
        ? {
            OR: [
              { queryCode: { contains: q, mode: "insensitive" } },
              { contactName: { contains: q, mode: "insensitive" } },
              { shipmentDescription: { contains: q, mode: "insensitive" } },
              { client: { companyName: { contains: q, mode: "insensitive" } } },
              {
                points: {
                  some: {
                    country: { contains: q, mode: "insensitive" },
                    type: { in: ["PICKUP", "DELIVERY"] as Prisma.EnumPointTypeFilter["in"] },
                  },
                },
              },
            ],
          }
        : {}),
```

  and delete the standalone country block (lines 108–117):

```ts
      ...(country
        ? {
            points: {
              some: {
                country: { equals: country, mode: "insensitive" },
                type: { in: ["PICKUP", "DELIVERY"] as Prisma.EnumPointTypeFilter["in"] },
              },
            },
          }
        : {}),
```

  > Intended behaviour change (design doc S3.2): country moves from exact `equals` to substring `contains` (case-insensitive), consistent with the other search columns.

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/api test queries-list && pnpm --filter @svyft/api typecheck && pnpm --filter @svyft/shared test` · Expected: PASS — both new e2e tests green; existing list tests green (no PICKUP/DELIVERY country contains those terms); shared unit tests green. **Do NOT run the web typecheck here** — it reports `country` errors in `QueriesToolbar.tsx` until Task 8.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/queries/queries.service.ts packages/shared/src/query.ts apps/api/test/queries-list.e2e-spec.ts
git commit -m "feat(api): fold country into the combined query search (S3.2)

Country now matches as a substring (contains, insensitive) inside the q OR-clause
over PICKUP/DELIVERY point country, replacing the exact standalone filter. Drops
country from queryListQuerySchema.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Remove the Country input, route country through the search box — web (S3.2)

**Files:**
- Modify — `apps/web/src/features/query-list/QueriesToolbar.tsx` (state line 33; `emitFilters` override type line 64, `c` var line 72, `country` param line 83, deps line 95; `handleCountry` lines 115–118; `clearFilters` line 161; `hasFilters` line 167; placeholder line 178; Country `<Input>` lines 236–242)
- Test — `apps/web/src/features/query-list/QueriesToolbar.test.tsx` (add a new `describe`)

**Interfaces:** Consumes `QueryListParams` (post-Task 7, no `country`); existing search box (`aria-label="Search"`). Produces a toolbar with no Country input; placeholder mentions country. **Depends on Task 7** (rebuild `@svyft/shared` first).

- [ ] **Step 1: Write the failing test** — append to `QueriesToolbar.test.tsx` (reuses `authMockFetch`, `renderWithProviders`, `waitFor`):

```tsx
describe("QueriesToolbar — country folded into search (S3.2)", () => {
  it("has no separate Country input and routes a country term through the single search box", async () => {
    vi.stubGlobal("fetch", authMockFetch());
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup();

    expect(screen.queryByLabelText("Country filter")).toBeNull();
    expect(screen.getByLabelText("Search").getAttribute("placeholder")).toMatch(/country/i);

    await user.type(screen.getByLabelText("Search"), "IN");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ q: "IN" })));
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run src/features/query-list/QueriesToolbar.test.tsx -t "country folded into search"` · Expected: FAIL — "Country filter" input still exists; placeholder has no "country".

- [ ] **Step 3: Implement** — in `QueriesToolbar.tsx`:
  1. Delete state (33): `const [country, setCountry] = useState("");`
  2. Delete `country: string;` from the `emitFilters` `overrides` type (64).
  3. Delete `const c = overrides.country !== undefined ? overrides.country : country;` (72) and `country: c || undefined,` from `params` (83).
  4. Remove `country` from the `emitFilters` deps (95): `[status, priority, freightMode, assignedToMe, dateField, dateRange, user, onChange]`.
  5. Delete `handleCountry` (115–118).
  6. Delete `setCountry("");` in `clearFilters` (161).
  7. `hasFilters` (167): `const hasFilters = search || status || priority || freightMode || assignedToMe || dateRange;`
  8. Placeholder (178): `placeholder="Search query code, customer, country…"`
  9. Delete the Country `<Input aria-label="Country filter">` block (236–242).

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web exec vitest run src/features/query-list/QueriesToolbar.test.tsx && pnpm --filter @svyft/web typecheck` · Expected: PASS — new test green; date-range/status tests green; web typecheck clean (relies on Task 7's rebuilt `@svyft/shared`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-list/QueriesToolbar.tsx apps/web/src/features/query-list/QueriesToolbar.test.tsx
git commit -m "feat(web): remove Country filter, fold it into the search box (S3.2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Default the FF selection view to Table (S4.4)

**Files:**
- Modify — `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx` (line 32)
- Test — `apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx` (rewrite the "defaults to Cards…" test lines 122–137; fix the cards-only assertion line 98)

**Interfaces:** No signature change — flips initial `view` from `"cards"` to `"table"`.

- [ ] **Step 1: Write the failing test** — in `FfSelectionGrid.test.tsx`, replace the whole `it("defaults to Cards and toggles to Table (with column headers)", …)` (lines 122–137) with:

```tsx
  it("defaults to the Table view (column headers visible on mount), toggles to Cards", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("a", "Alpha FF"), ff("b", "Beta FF")] };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    expect(await screen.findByText("Alpha FF")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /forwarder/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /country/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /modes/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /status/i })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /terms|lead/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^cards$/i }));
    expect(screen.queryByRole("columnheader", { name: /forwarder/i })).toBeNull();
  });
```

Also replace line 98 of the `it("shows full country names, hides payment terms/lead time, and offers regenerate …")` test:

```tsx
    // FROM: expect(await screen.findByText(/India · AIR/)).toBeInTheDocument();
    expect(await screen.findByText("India")).toBeInTheDocument();
    expect(screen.getByText("AIR")).toBeInTheDocument();
```

(Leave lines 99–103 — `/\bIN\b/`, `/NET30|Lead/`, regenerate assertion — unchanged; note Task 12 relaxes the regenerate matcher.)

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run FfSelectionGrid` · Expected: FAIL — component still inits `view="cards"`; on mount the cards grid renders (no `columnheader` roles), so the header query throws; frozen India FF renders as a card (`India · AIR`).

- [ ] **Step 3: Implement** — `FfSelectionGrid.tsx` line 32: `const [view, setView] = useState<"cards" | "table">("table");`

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run FfSelectionGrid && pnpm --filter @svyft/web typecheck` · Expected: PASS (pagination/sort tests that click `{ name: /^table$/i }` on an already-table view still pass harmlessly). No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx
git commit -m "feat(rfq): default FF selection grid to table view (S4.4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Reference tags in a dedicated field via shared icons (S4.1)

**Files:**
- Modify — `apps/web/src/features/rfq-workspace/CargoTagIcons.tsx` (full rewrite: delegate to shared component; adds OUT_OF_GAUGE)
- Modify — `apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx` (lines 56–61: move `<CargoTagIcons>` out of the Totals `<Field>` into its own `<Field label="Reference Tags">`)
- Test — `apps/web/src/features/rfq-workspace/CargoTagIcons.test.tsx` (NON_STACKABLE label now "Non Stackable"; add OUT_OF_GAUGE case); `apps/web/src/features/rfq-workspace/QueryOverviewHeader.test.tsx` (add "field separate from Totals" case; add `within` import)

**Interfaces:** Consumes `ReferenceTagIcons` (Task 1); `REFERENCE_TAGS`, `CargoDto` from `@svyft/shared`. Produces `CargoTagIcons({ cargo }: { cargo: CargoDto[] })` (unchanged signature). **Depends on Task 1** — `@/components/ReferenceTagIcons` must exist.

- [ ] **Step 1: Write the failing test** — in `CargoTagIcons.test.tsx`, change the NON_STACKABLE case and add OUT_OF_GAUGE:

```tsx
  it("renders Non stackable icon when cargo has NON_STACKABLE tag", () => {
    render(<CargoTagIcons cargo={[cargo({ referenceTags: ["NON_STACKABLE"] })]} />);
    expect(screen.getByLabelText(/non stackable/i)).toBeInTheDocument(); // "Non Stackable"
  });

  it("renders the Out of Gauge icon when cargo has OUT_OF_GAUGE tag", () => {
    render(<CargoTagIcons cargo={[cargo({ referenceTags: ["OUT_OF_GAUGE"] })]} />);
    expect(screen.getByLabelText(/out of gauge/i)).toBeInTheDocument();
  });
```

in `QueryOverviewHeader.test.tsx`, change line 2 import to `import { render, screen, within } from "@testing-library/react";` and add inside the `describe`:

```tsx
  it("renders reference-tag icons under their own 'Reference Tags' field, not under Totals", () => {
    const queryWithTag = { ...query, cargo: [makeCargo({ referenceTags: ["OUT_OF_GAUGE"] })] } as unknown as QueryDetail;
    render(<QueryOverviewHeader query={queryWithTag} />);
    const label = screen.getByText("Reference Tags");
    const field = label.closest("div")!;
    expect(within(field).getByLabelText(/out of gauge/i)).toBeInTheDocument();
    const totals = screen.getByText("Totals").closest("div")!;
    expect(within(totals).queryByLabelText(/out of gauge/i)).toBeNull();
  });
```

> Match `query`/`makeCargo`/`QueryDetail` to the file's existing fixtures/imports.

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run CargoTagIcons QueryOverviewHeader` · Expected: FAIL — current `CargoTagIcons` labels NON_STACKABLE "Non-stackable" (hyphen fails `/non stackable/i`), has no OUT_OF_GAUGE icon, and the header has no "Reference Tags" field.

- [ ] **Step 3: Implement** — rewrite `CargoTagIcons.tsx`:

```tsx
import type { CargoDto } from "@svyft/shared";
import { REFERENCE_TAGS } from "@svyft/shared";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";

/** Aggregate the reference tags present across a query's cargo + whether any row
 *  is dangerous, then render the shared icon set. */
export function CargoTagIcons({ cargo }: { cargo: CargoDto[] }) {
  const presentTags = REFERENCE_TAGS.filter((tag) => cargo.some((c) => c.referenceTags.includes(tag)));
  const anyDg = cargo.some((c) => c.isDangerous);
  return <ReferenceTagIcons tags={presentTags} isDangerous={anyDg} />;
}
```

in `QueryOverviewHeader.tsx`, replace the Totals field block (lines 56–61):

```tsx
          <Field label="Totals">
            <div>{totals.pkg} pkg · {totals.cbm} CBM · {totals.gross} kg</div>
          </Field>
          <Field label="Reference Tags">
            <CargoTagIcons cargo={query.cargo} />
          </Field>
```

> Match the Totals inner markup (`{totals.pkg} pkg · …`) to the file's current expression. `CargoTagIcons` returns `null` when nothing present, so the field renders empty in that case (the existing "renders nothing" test still passes).

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run CargoTagIcons QueryOverviewHeader && pnpm --filter @svyft/web typecheck` · Expected: PASS (existing dedupe/heavy/fragile/DG + "renders nothing" cases green; new OUT_OF_GAUGE + field-separation cases green). No type errors. *(If Step 3 can't resolve `@/components/ReferenceTagIcons`, Task 1 isn't merged — pull it first.)*

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/rfq-workspace/CargoTagIcons.tsx apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx apps/web/src/features/rfq-workspace/CargoTagIcons.test.tsx apps/web/src/features/rfq-workspace/QueryOverviewHeader.test.tsx
git commit -m "feat(rfq): reference tags in a dedicated header field via shared icons (S4.1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Surface origin/destination country scope on each leg's FF list (S4.2)

**Files:**
- Modify — `apps/web/src/features/rfq-workspace/LegPanel.tsx` (import `getCountryName`; add a `pointCountryName` helper; compute `originCountry`/`destCountry`; wrap `<FfSelectionGrid>` with a scope chip)
- Test — `apps/web/src/features/rfq-workspace/LegPanel.test.tsx` (add one case)

**Interfaces:** Consumes `getCountryName(code: string): string` from `@svyft/shared` (exists — `packages/shared/src/reference.ts:61`); the leg's `originPointId`/`destinationPointId` and `QueryPointDto.country`. Produces a presentational chip only. **No backend/schema change.**

- [ ] **Step 1: Write the failing test** — in `LegPanel.test.tsx`, add inside `describe("LegPanel", …)` (fixtures set `p1.country="CN"`, `p2.country="AE"`):

```tsx
  it("shows the FF country-scope chip derived from the leg's origin/destination points", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={() => {}} />);
    const scope = await screen.findByText(/forwarders covering/i);
    expect(scope).toHaveTextContent("China");                // getCountryName("CN")
    expect(scope).toHaveTextContent("United Arab Emirates");  // getCountryName("AE")
  });
```

> Match the `LegPanel` prop names (`leg`, `points`, `legQuotes`, `referencedFfs`, `cargo`, `open`, `onToggle`) + `wrap`/`mockFetch` to the file's existing harness.

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run LegPanel` · Expected: FAIL — no "forwarders covering" element.

- [ ] **Step 3: Implement** — in `LegPanel.tsx`, add the value import after the existing type import:

```tsx
import { getCountryName } from "@svyft/shared";
```

add the helper after the existing `pointName` helper:

```tsx
function pointCountryName(points: QueryPointDto[], id: string | null): string {
  const code = id ? (points.find((x) => x.id === id)?.country ?? null) : null;
  return code ? getCountryName(code) : "—";
}
```

inside the component (after `const route = …`):

```tsx
  const originCountry = pointCountryName(points, leg.originPointId);
  const destCountry = pointCountryName(points, leg.destinationPointId);
```

replace the bare `<FfSelectionGrid …/>` with a chip + grid wrapper (keep the exact props the current `<FfSelectionGrid>` receives):

```tsx
          <div className="space-y-2">
            <div className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
              Forwarders covering {originCountry} → {destCountry}
            </div>
            <FfSelectionGrid
              queryId={queryId}
              legId={leg.id}
              legQuotes={legQuotes.map((q) => ({ freightForwarderId: q.freightForwarderId, status: q.status }))}
              referencedFfs={referencedFfs}
            />
          </div>
```

> Preserve whatever props/mapping the current `<FfSelectionGrid>` call passes — the wrapper only adds the chip.

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run LegPanel && pnpm --filter @svyft/web typecheck` · Expected: PASS (existing route-text/net-gross/toggle cases unaffected; new chip case green). No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/rfq-workspace/LegPanel.tsx apps/web/src/features/rfq-workspace/LegPanel.test.tsx
git commit -m "feat(rfq): surface origin/destination country scope on each leg's FF list (S4.2)

Country-only per resolved decisions; no backend/schema change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Regenerate as its own last table column + auto-copy + transient confirmation (S4.3)

**Files:**
- Modify — `apps/web/src/features/rfq-workspace/RegeneratePortalLink.tsx` (full rewrite: compact button, reissue → `copyToClipboard` → transient "Link copied ✓" + `aria-live`; drop inline `PortalLinkRow`)
- Modify — `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx` (table `<thead>` ~line 198: trailing `Actions` `<th>`; forwarder `<td>` 215–220: remove inline regenerate; after Status `<td>` ~223: trailing Actions `<td>`; cards branch line 177 unchanged)
- Test — `RegeneratePortalLink.test.tsx` (rewrite); `FfSelectionGrid.test.tsx` (add last-column + auto-copy case; `import * as clip from "@/lib/clipboard"`; extend `afterEach` with `vi.restoreAllMocks()`; relax the two `/regenerate portal link/i` matchers at lines 103 & 119 to `/regenerate/i`)

**Interfaces:** Consumes `useReissueToken(queryId)` (mutation; `mutate(ffId, { onSuccess })`; `ReissueTokenResult = { rfqId; rfqNumber; freightForwarderId; accessToken }`); `copyToClipboard(text): Promise<boolean>` from `@/lib/clipboard`. Portal URL = `` `${window.location.origin}/ff/rfq/${accessToken}` ``. Produces `RegeneratePortalLink({ queryId, freightForwarderId })` (unchanged props). **Depends on Task 9** (table default). **Note:** `PortalLinkRow` is still used by `DistributeLegAction.tsx` — do NOT delete it.

- [ ] **Step 1: Write the failing test** — rewrite `RegeneratePortalLink.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import * as clip from "@/lib/clipboard";
import { RegeneratePortalLink } from "./RegeneratePortalLink";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
};

describe("RegeneratePortalLink", () => {
  it("regenerates, auto-copies the new link, shows a transient confirmation, and shows no inline link field", async () => {
    const copySpy = vi.spyOn(clip, "copyToClipboard").mockResolvedValue(true);
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/reissue-token") && init?.method === "POST")
        return { status: 200, body: { rfqId: "r", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: "NEWTOK" } };
      return { status: 404 };
    }));
    render(wrap(<RegeneratePortalLink queryId="q1" freightForwarderId="ff1" />));
    await userEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(expect.stringContaining("/ff/rfq/NEWTOK")));
    expect(await screen.findByText(/link copied/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/portal link/i)).toBeNull();
  });
});
```

then in `FfSelectionGrid.test.tsx`: add `import * as clip from "@/lib/clipboard";`; change `afterEach(() => vi.unstubAllGlobals());` to also call `vi.restoreAllMocks();`; relax the two `{ name: /regenerate portal link/i }` matchers (lines 103, 119) to `{ name: /regenerate/i }`; add:

```tsx
  it("puts Regenerate in the last table column and auto-copies the new link on click", async () => {
    const copySpy = vi.spyOn(clip, "copyToClipboard").mockResolvedValue(true);
    const frozenFf = ff("ff1", "Frozen FF");
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [frozenFf] };
      if (url.includes("/reissue-token") && init?.method === "POST")
        return { status: 200, body: { rfqId: "r", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: "NEWTOK" } };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[{ freightForwarderId: "ff1", status: "RFQ_SENT" }]} referencedFfs={[frozenFf]} />);
    const headers = await screen.findAllByRole("columnheader");
    expect(headers[headers.length - 1]).toHaveTextContent(/actions/i);
    const row = screen.getByText("Frozen FF").closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    const regenBtn = within(cells[cells.length - 1]).getByRole("button", { name: /regenerate/i });
    await userEvent.click(regenBtn);
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(expect.stringContaining("/ff/rfq/NEWTOK")));
    expect(await within(cells[cells.length - 1]).findByText(/link copied/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/portal link/i)).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails** — Run: `pnpm --filter @svyft/web exec vitest run RegeneratePortalLink FfSelectionGrid` · Expected: FAIL — current `RegeneratePortalLink` renders `PortalLinkRow` (input labeled "Portal link") and never calls `copyToClipboard`; the table has no `Actions` column, so `headers[last]` is "Status" and the last cell has no Regenerate button.

- [ ] **Step 3: Implement** — rewrite `RegeneratePortalLink.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { useReissueToken } from "./useRfq";

/**
 * Compact "Regenerate" control for a frozen (distributed) FF. On success it rotates
 * the RFQ access token, copies the new portal link to the clipboard, and shows a
 * transient ~2s confirmation (plus an aria-live status). NOTE (S4.3 tradeoff,
 * user-accepted): the regenerated link is NOT rendered as selectable text here —
 * only copied. The full link is still shown at distribution time in
 * DistributeLegAction (PortalLinkRow), so discoverability is preserved there.
 */
export function RegeneratePortalLink({ queryId, freightForwarderId }: { queryId: string; freightForwarderId: string }) {
  const reissue = useReissueToken(queryId);
  const [copied, setCopied] = useState(false);

  function regenerate() {
    reissue.mutate(freightForwarderId, {
      onSuccess: async (res) => {
        await copyToClipboard(`${window.location.origin}/ff/rfq/${res.accessToken}`);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={reissue.isPending} onClick={regenerate}>
        {reissue.isPending ? "Regenerating…" : copied ? "Link copied ✓" : "Regenerate"}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "New portal link copied to clipboard. The previous link is now invalid." : ""}
      </span>
      {reissue.isError && <span className="text-xs text-destructive">Couldn't regenerate. Try again.</span>}
    </div>
  );
}
```

in `FfSelectionGrid.tsx`: add the trailing header after the Status `<th>` (~line 198): `<th scope="col" className="px-4 py-2 font-medium">Actions</th>`. Replace the forwarder `<td>` (215–220) so it holds only the name:

```tsx
                      <td className="px-4 py-2">
                        <span className="font-medium">{f.companyName}</span>
                      </td>
```

add the trailing Actions `<td>` after the Status `<td>` (~223):

```tsx
                      <td className="px-4 py-2 text-right">
                        {isFrozen ? (
                          <RegeneratePortalLink queryId={queryId} freightForwarderId={f.id} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
```

> Match `f.companyName`/`f.id`/`isFrozen` to the current row variable names. The cards branch (line 177) keeps `{isFrozen && <RegeneratePortalLink … />}` unchanged — it now shows the same compact button. Keep `PortalLinkRow` imported/used by `DistributeLegAction.tsx`.

- [ ] **Step 4: Run test + typecheck** — Run: `pnpm --filter @svyft/web exec vitest run RegeneratePortalLink FfSelectionGrid && pnpm --filter @svyft/web typecheck` · Expected: PASS (new last-column/auto-copy cases green; relaxed `/regenerate/i` matchers keep the two existing cases green). No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/rfq-workspace/RegeneratePortalLink.tsx apps/web/src/features/rfq-workspace/RegeneratePortalLink.test.tsx apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx
git commit -m "feat(rfq): move Regenerate to its own last column with auto-copy + transient confirm (S4.3)

Reissue the token, copy the new portal link to the clipboard, and show a ~2s
in-button 'Link copied' confirmation (aria-live). Drop the inline portal-link
output so the table row stays one line.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: Finalize — full verification + docs alignment

**Files:**
- Modify — `docs/Stage 3 & 4 - UI-UX Improvements - Design.md` (mark status implemented; note S3.4's `localStep`-authoritative approach vs the doc's literal `?step=1`)
- Modify — `docs/Stage 3 - Session Handoff.md` and/or `docs/Stage 4 - Session Handoff.md` (record this batch)

- [ ] **Step 1: Full test + typecheck sweep** — Run (in order, since web/api consume built shared):
  ```bash
  pnpm --filter @svyft/shared build
  pnpm --filter @svyft/shared test && pnpm --filter @svyft/shared typecheck
  pnpm --filter @svyft/web test && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint
  pnpm --filter @svyft/api typecheck
  ```
  Expected: all green. (API e2e — `pnpm --filter @svyft/api test` — runs on CI where a DB is available; run locally only if a DB is configured.)
- [ ] **Step 2: Align docs** — update the design doc status + Session Handoff with the delivered items and the S3.4 deviation note.
- [ ] **Step 3: Commit**
  ```bash
  git add "docs/Stage 3 & 4 - UI-UX Improvements - Design.md" "docs/Stage 3 - Session Handoff.md"
  git commit -m "docs(stage-3-4): mark UI/UX improvements delivered; note S3.4 approach

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```
- [ ] **Step 4: Whole-branch review** — use superpowers:requesting-code-review before opening the PR.

---

## Risks & assumptions (verified by the drafting pass; re-confirm during execution)

- **Task 3 (S3.3):** `handleCreateQuery` re-reads fresh detail via `qc.getQueryData<QueryDetail>(["query", id])` after `await handleSave()` + `await refresh()`. Confirm the cache key + that `refresh()` settles the refetch (see the verify note in Task 3). The `?? detail` fallback means a wrong key silently keeps the bug — the RED test guards against this.
- **Task 4 (S3.4):** relies on React NOT remounting `QueryWizardPage` across `/queries/new → /queries/:id` (same element type, no `key`). Verified in App.tsx + both test files. A future `key={id}` would regress. Minor untested behaviour change: browser Back to a bare `/queries/:id` (no `?step`) no longer resets to step 0.
- **Task 5 (S3.6/S3.8):** `useRouteFindings` has no other consumers (grep-verified) → safe to retire. `RouteDiagram` is pure and highlights only from its `findings` prop → `findings={[]}` removes live highlights. The shell `ValidationSummary` is independent (renders from create-gate `findings` state) and is explicitly not modified. Leg-field LABEL "Ready Date" in `LegEditor.tsx` is OUT of S3.5 scope — the leg G10 message will read "Target Pickup …" while that field label still says "Ready Date"; relabel is a separate change if desired.
- **Task 7 (S3.2):** country match changes exact→substring (intended). e2e determinism relies on `PFX` scoping + asserting on `q2Id`; query codes never contain "in", so Q2's only "in" source is its PICKUP point country "IN".
- **Task 12 (S4.3):** the regenerated link becomes clipboard-only; the full link is still shown at distribution time via `DistributeLegAction`'s `PortalLinkRow`, so `PortalLinkRow` stays (not dead code).
- **Test fixtures:** each web test references existing fixtures in its target test file (`fullDraftDetail`, `draftDetail`, `baseDetail`, `cargoRowDto`, `detailWithLeg`, `detailWithDangling`, `leg`, `points`, `query`, `makeCargo`, `navigateToStep3/4`, `mockFetch`, `authMockFetch`, `wrap`, `ff`). Confirm exact names when implementing; adjust to match.
