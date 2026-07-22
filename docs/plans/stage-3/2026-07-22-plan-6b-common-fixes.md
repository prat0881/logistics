# Plan 6b — Req & Issues Round 1 — Common Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first Round-1 "Req & Issues" increment — the 10 Common Rules + small per-screen fixes: Query List ("All" filters, date-range popup, paginate @10), Masters paginate @10, strict E.164 everywhere, remove ALL Save/Next validation gating (validate at Create only), "Leg & Route" rename, Incoterms "N/A", remove the DG-indicator field, Response-Deadline default-by-priority, standardize popups to Save/Cancel (cargo → modal), dropdown defaults, and a compact-layout pass.

**Architecture:** Frontend-heavy increment on the existing `apps/web` wizard + Query List + Masters, plus pure `@svyft/shared` zod-schema changes (E.164, Incoterms, list page-size, a deadline helper) that the API inherits automatically via `ZodValidationPipe`. No Prisma migration (timezone/migration work is the separate increment 4). Validation philosophy flips: mandatory/business rules run **only at Create Query**; Save and Next never block; format errors show inline (no block); mandatory-empty shows no inline message (the schema is already `.partial()`, so removing the client-side gates achieves this for free).

**Tech Stack:** pnpm monorepo · React 18 + Vite + Tailwind + shadcn/ui (Radix) + TanStack Query/Table + React Hook Form + `zodResolver` · `@svyft/shared` isomorphic zod · Vitest + `renderWithProviders` + `mockFetch` (web), Vitest (shared), Jest e2e (api).

## Global Constraints

- **`pnpm run ci` MUST be green before finishing** (shared + web + api). Baseline at branch start: web 177 · shared 125 · api 105.
- **Web CI gotcha:** `vite build`/esbuild SKIPS type errors — always run `pnpm --filter @svyft/web typecheck` (or `pnpm run ci`) before claiming green.
- **API CI gotcha:** CI runs a fresh migrated-but-UNSEEDED Postgres — every test seed-independent + self-cleaning. Verify vs `prisma migrate reset --force --skip-seed` + `pnpm run ci`.
- **Shared enums:** `const` object + `Object.values(...) as [X,...X[]]`, pinned by a `toEqual` test. Never a TS `enum`.
- **Web forms:** RHF + `zodResolver(@svyft/shared schema)` + shadcn `Form*`; `FormItem`/`FormLabel` throw outside `<FormField>`. Datetime fields use the `toIsoOffset`/`isoToLocalInput` floating-wall-clock pair.
- **Web tests:** Vitest + `renderWithProviders` (`@/test/renderWithProviders`) + `mockFetch` (`@/test/mock-fetch`); stub `/api/auth/me` + endpoints; `afterEach(vi.unstubAllGlobals())`. **Radix Select is jsdom-flaky** → drive it via the pattern already used in the sibling test file, or assert values another way. Use valid UUIDs for `.uuid()` fields.
- **Commit per task** with a `fix(web)…` / `feat(shared)…` / `refactor(web)…` message (see each task). Conventional-commit scope: `web`, `shared`, or `api`.
- **Branch:** `feat/plan-6b-req-issues-round1-common-fixes` off `main`.
- **Out of scope (deferred, do NOT build here):** Validation-Summary panel + stepper red-dot badges + Notes/checklist-mandatory gate (increment 2); Route Canvas (increment 3); Timezone + Prisma migration + Response-Deadline **≥ Query-Date real-instant** comparison + date-column zone labels (increment 4); MSDS hold-&-send + delete-MSDS endpoint; full Shipment→"Shipment & Cargo" step merge; G6 (server-400 → field map); D2/D4.

---

## File Structure

**`packages/shared/src/`**
- `query.ts` — MODIFY: tighten `contactPhone` regex (require `+`); add `Incoterms.NA`; lower `queryListQuerySchema.pageSize` default 20→10; add `RESPONSE_DEADLINE_HOURS` + `defaultResponseDeadline()`.
- `points.ts` — MODIFY: tighten the `phone` regex (require `+`).
- `masters.ts` — MODIFY: `contactNo` gains the strict-E.164 regex.
- `query.test.ts`, `masters.test.ts`, `points.test.ts` (NEW) — schema tests.

**`apps/web/src/`**
- `components/PaginationBar.tsx` (NEW) — shared page prev/next + page-size select + result count; reused by Query List + both Masters lists.
- `features/query-list/QueriesToolbar.tsx` — MODIFY: "All"-filter clear; date-range both-before-close + Clear.
- `features/query-list/QueriesListPage.tsx` — MODIFY: default pageSize 10; use `PaginationBar`.
- `features/masters/useMasters.ts` — MODIFY: `useClients`/`useVessels` accept `{q,page,pageSize}`.
- `features/masters/clients/ClientsListPage.tsx`, `features/masters/vessels/VesselsListPage.tsx` — MODIFY: page state + `PaginationBar`.
- `features/query-wizard/steps/Step1Client.tsx` — MODIFY: drop the `StepSaveFn` `enforceRequired` param + STEP1_REQUIRED gate; add Response-Deadline default-by-priority; grid layout.
- `features/query-wizard/WizardShell.tsx` — MODIFY: drop `enforceRequired`; Next always advances (best-effort save).
- `features/query-wizard/QueryWizardPage.tsx` — MODIFY: `handleSave` drops `opts`.
- `features/query-wizard/steps/Step2Shipment.tsx` — MODIFY: drop `enforceRequired` gate; remove DG-indicator field; Incoterms default "Select".
- `features/query-wizard/steps/legs/LegsStep.tsx` (`steps/legs/`) — MODIFY: drop route-findings Next-gate → no-op save; h2 "Leg & Route".
- `features/query-wizard/steps/legs/PointEditor.tsx` — MODIFY: drop hard-block-on-save.
- `features/query-wizard/steps/legs/LegEditor.tsx` — MODIFY: drop hard-block-on-save; "Save Leg"→"Save".
- `features/query-wizard/steps/Step3Cargo.tsx` + `steps/cargo/CargoRowForm.tsx` — MODIFY: cargo Add/Edit → modal Dialog, buttons → Save/Cancel.
- `features/query-wizard/WizardContext.tsx` + `steps/LegsStep.tsx` — MODIFY: "Leg & Route" rename.
- Corresponding `*.test.tsx` — MODIFY where they assert removed behavior.

---

## Task 1: Strict E.164 in shared schemas (`query`, `points`, `masters`)

**Files:**
- Modify: `packages/shared/src/query.ts:55`
- Modify: `packages/shared/src/points.ts:30`
- Modify: `packages/shared/src/masters.ts:34`
- Modify: `packages/shared/src/query.test.ts`
- Create: `packages/shared/src/masters.test.ts` additions (append to existing) + `packages/shared/src/points.test.ts`

**Interfaces:**
- Produces: the strict regex `/^\+[1-9]\d{6,14}$/` (leading `+` REQUIRED) used by `querySaveSchema.contactPhone`, `pointSaveSchema.contactPhone`, `contactCreateSchema.contactNo`. Message stays `"Phone must be E.164"`.

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/query.test.ts`, inside the existing `F2` describe block, add:
```ts
it("rejects a contactPhone without a leading +", () => {
  expect(querySaveSchema.safeParse({ contactPhone: "911234567890" }).success).toBe(false);
});
it("accepts a valid E.164 contactPhone with +", () => {
  expect(querySaveSchema.safeParse({ contactPhone: "+911234567890" }).success).toBe(true);
});
```
Create `packages/shared/src/points.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { pointSaveSchema } from "./points";

describe("pointSaveSchema.contactPhone (strict E.164)", () => {
  it("rejects a phone without a leading +", () => {
    expect(pointSaveSchema.safeParse({ type: "PICKUP", contactPhone: "6591234567" }).success).toBe(false);
  });
  it("accepts a +-prefixed E.164 phone", () => {
    expect(pointSaveSchema.safeParse({ type: "PICKUP", contactPhone: "+6591234567" }).success).toBe(true);
  });
  it("allows contactPhone to be absent (draft)", () => {
    expect(pointSaveSchema.safeParse({ type: "PICKUP" }).success).toBe(true);
  });
});
```
Append to `packages/shared/src/masters.test.ts`:
```ts
import { contactCreateSchema } from "./masters";
describe("contactCreateSchema.contactNo (strict E.164)", () => {
  it("rejects a non-E.164 contactNo", () => {
    expect(contactCreateSchema.safeParse({ name: "A", contactNo: "6591234567" }).success).toBe(false);
  });
  it("accepts a +-prefixed E.164 contactNo", () => {
    expect(contactCreateSchema.safeParse({ name: "A", contactNo: "+6591234567" }).success).toBe(true);
  });
  it("allows contactNo to be omitted", () => {
    expect(contactCreateSchema.safeParse({ name: "A" }).success).toBe(true);
  });
});
```
(Use the existing import style at the top of `masters.test.ts`; add `contactCreateSchema` to its import rather than re-importing if a `./masters` import already exists.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @svyft/shared test`
Expected: the new cases FAIL (current regex `\+?` accepts no-`+`; `contactNo` has no regex).

- [ ] **Step 3: Tighten the three regexes**

`packages/shared/src/query.ts:55` — change the `contactPhone` line to:
```ts
    contactPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164"), // F2 (strict — leading + required)
```
`packages/shared/src/points.ts:30` — change the `phone` const to:
```ts
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164");
```
`packages/shared/src/masters.ts:34` — change `contactNo` to:
```ts
  contactNo: z.string().regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164").optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @svyft/shared test`
Expected: PASS. Also grep for any fixture using a non-`+` phone that now breaks: `grep -rn "contactPhone\|contactNo" packages/shared/src apps/api/test apps/web/src --include="*.ts" --include="*.tsx" | grep -v "+"` — fix any real (non-comment) fixture to a `+`-prefixed value.

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/query.ts packages/shared/src/points.ts packages/shared/src/masters.ts \
  packages/shared/src/query.test.ts packages/shared/src/points.test.ts packages/shared/src/masters.test.ts
git commit -m "feat(shared): require leading + for E.164 phones (query, point, contact)"
```

---

## Task 2: Add "N/A" to the Incoterms enum

**Files:**
- Modify: `packages/shared/src/query.ts:15-29`
- Modify: `packages/shared/src/query.test.ts`

**Interfaces:**
- Produces: `Incoterms.NA = "N/A"`; `INCOTERMS` array gains a trailing `"N/A"`. `querySaveSchema.incoterms` (a `z.enum(INCOTERMS)`) now accepts `"N/A"`.

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/query.test.ts`, update the pinned `INCOTERMS` equality test (find the `expect(INCOTERMS).toEqual([...])` assertion) to include `"N/A"` as the final element, and add:
```ts
it("accepts N/A as a valid incoterms value", () => {
  expect(querySaveSchema.safeParse({ incoterms: "N/A" }).success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared test`
Expected: FAIL (`"N/A"` not in the enum; the pinned `toEqual` now mismatches the source).

- [ ] **Step 3: Add the value**

`packages/shared/src/query.ts` — add to the `Incoterms` const object (after `DDP`):
```ts
  DDP: "DDP",
  NA: "N/A",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/query.ts packages/shared/src/query.test.ts
git commit -m "feat(shared): add N/A to the Incoterms enum"
```

---

## Task 3: Response-Deadline default-by-priority helper (shared)

**Files:**
- Modify: `packages/shared/src/query.ts` (after the `Priority` enum, ~line 12)
- Modify: `packages/shared/src/query.test.ts`

**Interfaces:**
- Produces:
  - `RESPONSE_DEADLINE_HOURS: Record<Priority, number>` = `{ LOW: 48, MEDIUM: 24, HIGH: 18, URGENT: 12 }`.
  - `defaultResponseDeadline(queryDate: string, priority: Priority): string` — returns the ISO instant `queryDate + RESPONSE_DEADLINE_HOURS[priority]` hours. Consumed by Task 12 (Step 1 wiring).

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/query.test.ts` add (import `defaultResponseDeadline`, `RESPONSE_DEADLINE_HOURS` at top):
```ts
describe("defaultResponseDeadline (priority → deadline offset)", () => {
  it("adds 24h for MEDIUM", () => {
    const out = defaultResponseDeadline("2026-07-22T09:00:00.000Z", "MEDIUM");
    expect(new Date(out).getTime()).toBe(new Date("2026-07-23T09:00:00.000Z").getTime());
  });
  it("adds 48/18/12h for LOW/HIGH/URGENT", () => {
    const base = "2026-07-22T00:00:00.000Z";
    const t = (p: "LOW" | "HIGH" | "URGENT") => new Date(defaultResponseDeadline(base, p)).getTime();
    expect(t("LOW")).toBe(new Date("2026-07-24T00:00:00.000Z").getTime());
    expect(t("HIGH")).toBe(new Date("2026-07-22T18:00:00.000Z").getTime());
    expect(t("URGENT")).toBe(new Date("2026-07-22T12:00:00.000Z").getTime());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared test`
Expected: FAIL (`defaultResponseDeadline is not a function`).

- [ ] **Step 3: Implement**

`packages/shared/src/query.ts` — after the `PRIORITIES` line add:
```ts
/**
 * Response-Deadline default by priority (Round-1 Common Rules / Step-1).
 * Deadline = Query Date + N hours. Recompute-until-touched wiring lives in the wizard.
 * NOTE: pure instant math (base + N h). Timezone-anchored display + the "≥ Query Date"
 * real-instant comparison are the separate timezone increment — not here.
 */
export const RESPONSE_DEADLINE_HOURS: Record<Priority, number> = {
  LOW: 48,
  MEDIUM: 24,
  HIGH: 18,
  URGENT: 12,
};
export function defaultResponseDeadline(queryDate: string, priority: Priority): string {
  const ms = new Date(queryDate).getTime() + RESPONSE_DEADLINE_HOURS[priority] * 3_600_000;
  return new Date(ms).toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/query.ts packages/shared/src/query.test.ts
git commit -m "feat(shared): add defaultResponseDeadline(priority) helper + hour map"
```

---

## Task 4: Query List — fix the "All" filters

**Files:**
- Modify: `apps/web/src/features/query-list/QueriesToolbar.tsx:58-90`
- Create: `apps/web/src/features/query-list/QueriesToolbar.test.tsx`

**Root cause:** `emitFilters` only adds a key when truthy (`if (s) params.status = …`), and `QueriesListPage.handleToolbarChange` merges via `{ ...prev, ...partial }`, which never *removes* a stale key. Selecting "All" omits the key → the previous filter persists. Fix: always emit each facet key (value or `undefined`) so the merge overwrites stale values.

- [ ] **Step 1: Write the failing test**
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { QueriesToolbar } from "./QueriesToolbar";

afterEach(() => vi.unstubAllGlobals());

describe("QueriesToolbar — All clears the facet", () => {
  it("emits status: undefined when 'All statuses' is chosen", async () => {
    mockFetch({ "/api/auth/me": { id: "u1", name: "U", role: "ADMINISTRATOR" } });
    const onChange = vi.fn();
    renderWithProviders(<QueriesToolbar onChange={onChange} />);
    const user = userEvent.setup();
    // Open the Status select and choose "All statuses" (mirror the Select-driving
    // pattern in QueriesListPage.test.tsx if Radix is flaky in jsdom).
    await user.click(screen.getByLabelText("Status filter"));
    await user.click(await screen.findByText("All statuses"));
    const last = onChange.mock.calls.at(-1)![0];
    expect(last).toHaveProperty("status", undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test QueriesToolbar`
Expected: FAIL — current `emitFilters` omits `status` entirely, so `toHaveProperty("status", undefined)` fails (key absent).

- [ ] **Step 3: Always emit each facet key**

Replace the `params` construction in `emitFilters` (`QueriesToolbar.tsx`, the block starting `const params: Partial<QueryListParams> = {};`) with:
```ts
      const params: Partial<QueryListParams> = {
        status: (s || undefined) as QueryListParams["status"],
        priority: (p || undefined) as QueryListParams["priority"],
        freightMode: fm || undefined,
        assignedUserId: atm && user?.id ? user.id : undefined,
        country: c || undefined,
        dateField: undefined,
        dateFrom: undefined,
        dateTo: undefined,
      };
      if (dr?.from) {
        params.dateField = df;
        params.dateFrom = toIsoOffset(dr.from.toISOString().slice(0, 16));
        if (dr.to) params.dateTo = toIsoOffset(dr.to.toISOString().slice(0, 16));
      }
      onChange(params);
```
The parent merge (`{ ...prev, ...partial, page: 1 }`) now overwrites stale facet values with `undefined`; `toSearch` already skips `undefined`, so the API param is correctly dropped.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test QueriesToolbar`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-list/QueriesToolbar.tsx apps/web/src/features/query-list/QueriesToolbar.test.tsx
git commit -m "fix(web): clear a Query List facet when 'All' is selected"
```

---

## Task 5: Query List — date-range popup (pick both before it closes)

**Files:**
- Modify: `apps/web/src/features/query-list/QueriesToolbar.tsx:118-122, 226-256`
- Modify: `apps/web/src/features/query-list/QueriesToolbar.test.tsx`

**Change:** while selecting, keep the popover open and do NOT emit a partial (`from`-only) filter. Only emit + auto-close once BOTH `from` and `to` are chosen. Add an explicit **Clear** button inside the popover that resets the range (emits `dateRange: undefined`).

- [ ] **Step 1: Write the failing test**

Add to `QueriesToolbar.test.tsx`:
```tsx
it("does not emit a date filter until both endpoints are picked", async () => {
  mockFetch({ "/api/auth/me": { id: "u1", name: "U", role: "ADMINISTRATOR" } });
  const onChange = vi.fn();
  renderWithProviders(<QueriesToolbar onChange={onChange} />);
  const user = userEvent.setup();
  await user.click(screen.getByText("Date range"));
  const dayButtons = screen.getAllByRole("gridcell").filter((c) => c.getAttribute("data-day"));
  // pick a start day → still open, no dateFrom emitted yet
  await user.click(dayButtons[10]);
  expect(onChange.mock.calls.every(([p]) => p.dateFrom === undefined)).toBe(true);
  // pick an end day → emits both + closes
  await user.click(dayButtons[15]);
  const last = onChange.mock.calls.at(-1)![0];
  expect(last.dateFrom).toBeTruthy();
  expect(last.dateTo).toBeTruthy();
});
```
> Note: react-day-picker's gridcell markup can vary; if `data-day` isn't present, select days by their accessible name (the day number) within the rendered month. Mirror any existing calendar-driving test in the repo. Keep the assertion — "no emit until both picked" — stable regardless of selector.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test QueriesToolbar`
Expected: FAIL — current `handleDateRange` calls `emitFilters` on the first click (emits `dateFrom` immediately).

- [ ] **Step 3: Gate emit + close on both endpoints; add Clear**

Replace `handleDateRange` (`QueriesToolbar.tsx:118-122`) with:
```ts
  function handleDateRange(range: DateRange | undefined) {
    setDateRange(range);
    // Only apply + close once BOTH endpoints are chosen (pick Start and End clearly
    // before it closes). A partial (from-only) selection stays open and un-emitted.
    if (range?.from && range?.to) {
      emitFilters({ dateRange: range });
      setCalendarOpen(false);
    }
  }
  function clearDateRange() {
    setDateRange(undefined);
    emitFilters({ dateRange: undefined });
  }
```
In the `PopoverContent`, add a Clear affordance below the `<Calendar>` (before `</PopoverContent>`):
```tsx
          <div className="flex justify-end border-t p-2">
            <Button size="sm" variant="ghost" onClick={clearDateRange}>
              Clear
            </Button>
          </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test QueriesToolbar`
Expected: PASS. Also run the full query-list suite: `pnpm --filter @svyft/web test query-list`.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-list/QueriesToolbar.tsx apps/web/src/features/query-list/QueriesToolbar.test.tsx
git commit -m "fix(web): date-range popup applies only once both endpoints are picked + Clear"
```

---

## Task 6: `PaginationBar` component + Query List paginate @10 with a page-size control

**Files:**
- Create: `apps/web/src/components/PaginationBar.tsx`
- Create: `apps/web/src/components/PaginationBar.test.tsx`
- Modify: `apps/web/src/features/query-list/QueriesListPage.tsx`
- Modify: `packages/shared/src/query.ts:214` (pageSize default 20 → 10)
- Modify: `packages/shared/src/query.test.ts`
- Modify: `apps/web/src/features/query-list/QueriesListPage.test.tsx` (if it asserts `pageSize=20`)

**Interfaces:**
- Produces: `PaginationBar` — reused by Task 7 (Masters).
```ts
interface PaginationBarProps {
  page: number;          // 1-based
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[]; // default [10, 20, 50]
}
```

- [ ] **Step 1: Write the failing test (component)**
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaginationBar } from "./PaginationBar";

describe("PaginationBar", () => {
  it("shows the result count and page position", () => {
    render(<PaginationBar page={2} pageSize={10} total={25} onPageChange={() => {}} onPageSizeChange={() => {}} />);
    expect(screen.getByText(/25 results/i)).toBeInTheDocument();
    expect(screen.getByText(/Page 2 of 3/i)).toBeInTheDocument();
  });
  it("disables Previous on page 1 and Next on the last page", () => {
    const { rerender } = render(<PaginationBar page={1} pageSize={10} total={25} onPageChange={() => {}} onPageSizeChange={() => {}} />);
    expect(screen.getByLabelText("Previous page")).toBeDisabled();
    rerender(<PaginationBar page={3} pageSize={10} total={25} onPageChange={() => {}} onPageSizeChange={() => {}} />);
    expect(screen.getByLabelText("Next page")).toBeDisabled();
  });
  it("emits the next page", async () => {
    const onPageChange = vi.fn();
    render(<PaginationBar page={1} pageSize={10} total={25} onPageChange={onPageChange} onPageSizeChange={() => {}} />);
    await userEvent.click(screen.getByLabelText("Next page"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test PaginationBar`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `PaginationBar`**
```tsx
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface PaginationBarProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
}

export function PaginationBar({
  page, pageSize, total, onPageChange, onPageSizeChange, pageSizeOptions = [10, 20, 50],
}: PaginationBarProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>{total === 0 ? "No results" : `${total} result${total !== 1 ? "s" : ""}`}</span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
          <SelectTrigger className="h-8 w-[110px]" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((n) => (
              <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPageChange(current - 1)}
          disabled={current <= 1} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span>Page {current} of {pageCount}</span>
        <Button variant="outline" size="sm" onClick={() => onPageChange(current + 1)}
          disabled={current >= pageCount} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test PaginationBar`
Expected: PASS.

- [ ] **Step 5: Lower the shared default + wire Query List**

`packages/shared/src/query.ts:214` — `pageSize: z.coerce.number().int().min(1).max(100).default(10),`. In `query.test.ts`, add/adjust: `expect(queryListQuerySchema.parse({}).pageSize).toBe(10)`.

`QueriesListPage.tsx` — set `DEFAULT_PARAMS.pageSize: 10`; replace the bespoke pagination `<div>` (the block after `{/* Pagination */}`) with:
```tsx
      <PaginationBar
        page={currentPage}
        pageSize={params.pageSize ?? 10}
        total={total}
        onPageChange={(p) => setParams((prev) => ({ ...prev, page: p }))}
        onPageSizeChange={(size) => setParams((prev) => ({ ...prev, pageSize: size, page: 1 }))}
      />
```
Add `import { PaginationBar } from "@/components/PaginationBar";`; remove the now-unused `prevPage`/`nextPage`/`ChevronLeft`/`ChevronRight`/`Button` imports if they become unused (run typecheck to confirm). Keep `pageCount`/`currentPage` derivations only if still referenced.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @svyft/shared test && pnpm --filter @svyft/web test query-list && pnpm --filter @svyft/web typecheck`
Expected: PASS (update `QueriesListPage.test.tsx` if it asserted `pageSize=20` or the old pagination markup).

- [ ] **Step 7: Commit**
```bash
git add apps/web/src/components/PaginationBar.tsx apps/web/src/components/PaginationBar.test.tsx \
  apps/web/src/features/query-list/QueriesListPage.tsx apps/web/src/features/query-list/QueriesListPage.test.tsx \
  packages/shared/src/query.ts packages/shared/src/query.test.ts
git commit -m "feat(web): paginate Query List @10 with a page-size control (shared PaginationBar)"
```

---

## Task 7: Masters lists paginate @10 (server-side)

**Files:**
- Modify: `apps/web/src/features/masters/useMasters.ts`
- Modify: `apps/web/src/features/masters/clients/ClientsListPage.tsx`
- Modify: `apps/web/src/features/masters/vessels/VesselsListPage.tsx`
- Modify: `apps/web/src/features/masters/clients/ClientsListPage.test.tsx`, `.../vessels/VesselsListPage.test.tsx`

**Interfaces:**
- Consumes: `PaginationBar` (Task 6).
- The clients/vessels controllers already accept `q`, `page`, `pageSize` (default 20, cap 100) and return `Paginated<T>` (`{ items, total, page, pageSize }`). We send `page`/`pageSize=10`.
- **Verified:** `useClients`/`useVessels` are consumed ONLY by these two list pages. `ClientPicker`/`VesselPicker` use their own `useQuery` + `fetchJson` (`/api/clients?...&status=ACTIVE`) — do NOT touch the pickers.

- [ ] **Step 1: Write the failing test**

In `ClientsListPage.test.tsx` add (mirror the file's existing mockFetch + render setup):
```tsx
it("requests page size 10 and renders the paginator", async () => {
  const fetchMock = mockFetch({
    "/api/auth/me": { id: "u1", name: "U", role: "ADMINISTRATOR" },
    "/api/clients": { items: [], total: 0, page: 1, pageSize: 10 },
  });
  renderWithProviders(<ClientsListPage />);
  await screen.findByText(/no clients/i);
  const url = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/api/clients"))!;
  expect(url).toMatch(/pageSize=10/);
  expect(screen.getByLabelText("Rows per page")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test ClientsListPage`
Expected: FAIL (hook sends no `pageSize`; no paginator).

- [ ] **Step 3: Extend the hooks**

`useMasters.ts` — change `useClients`/`useVessels` to accept params:
```ts
export function useClients(params: { q: string; page: number; pageSize: number }) {
  const { q, page, pageSize } = params;
  return useQuery({
    queryKey: ["clients", q, page, pageSize],
    queryFn: () =>
      fetchJson<Paginated<ClientDto>>(
        `/api/clients?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
      ),
  });
}
```
(Mirror the same shape for `useVessels`.)

- [ ] **Step 4: Wire the list pages**

`ClientsListPage.tsx` — add page/pageSize state, reset to page 1 when `q` changes, and render `PaginationBar`:
```tsx
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { data, isLoading } = useClients({ q, page, pageSize });

  // search resets to page 1
  function handleSearch(v: string) { setQ(v); setPage(1); }
```
Point the search `Input.onChange` at `handleSearch`, and add below the table:
```tsx
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      />
```
Add `import { PaginationBar } from "@/components/PaginationBar";`. Apply the identical pattern to `VesselsListPage.tsx`.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test masters && pnpm --filter @svyft/web typecheck`
Expected: PASS. Update the vessels test the same way as clients; fix any existing masters test that called `useClients("q")` with a bare string (now an object) or asserted no paginator.

- [ ] **Step 6: Commit**
```bash
git add apps/web/src/features/masters
git commit -m "feat(web): paginate Masters clients/vessels @10 (server-side)"
```

---

## Task 8: Remove ALL Save/Next validation gating (contract + shell + Step 1/2 + route Next-gate)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.tsx:39-41` (contract), `:145-192` (Step-1 gate)
- Modify: `apps/web/src/features/query-wizard/WizardShell.tsx:20-29, 57-82`
- Modify: `apps/web/src/features/query-wizard/QueryWizardPage.tsx:128-141`
- Modify: `apps/web/src/features/query-wizard/steps/Step2Shipment.tsx:58-94`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx:100-115`
- Modify: `apps/web/src/features/query-wizard/QueryWizardPage.test.tsx` (U5 tests 441-505), `steps/legs/LegsStep.test.tsx` (628-679), and `Step1Client.test.tsx`/`Step2Shipment.test.tsx` if they assert the gate.

**Design:** Drop the `enforceRequired` signal end-to-end. Save persists a partial draft; **Next always advances** via a best-effort save (a rejected save no longer blocks navigation — inline field errors already communicate format issues). The schema is `.partial()`, so empty mandatory fields validate → they persist as omitted and surface only at Create Query (Common #4/#5/#6).

**Intentional scope boundary (document for the reviewer):** this task removes ONLY the round-1/round-2 *gating* — the `enforceRequired` mandatory checks, the Step-4 route Next-gate, and (Tasks 9–10) the point/leg hard-blocks. The pre-existing per-field **format** validation (G1: `zodResolver` inline messages on bad email/phone/IMO/incoterms + the ETA<ETB<ETD / deadline-not-past / ready≤target refines) is KEPT — it renders inline and never blocks navigation. Mandatory-**empty** shows no message because the schema is already `.partial()`. This satisfies Common #4/#5/#6 (free travel; Create is the single hard gate; no "≥1 character" nag).

**Interfaces (Produces):** `StepSaveFn = () => Promise<QuerySaveInput | void>` (no args). `WizardShellProps.onSave = () => Promise<void>`.

- [ ] **Step 1: Update the failing tests to the new behavior**

`QueryWizardPage.test.tsx` — replace the two U5 tests (Next-blocks / Next-advances) with a single behavior:
```tsx
it("Next advances to Step 2 even when Step-1 mandatory fields are empty (Round-1 Common #5)", async () => {
  // …existing new-query render setup…
  await user.click(screen.getByRole("button", { name: /next/i }));
  expect(await screen.findByText(/Shipment Details/i)).toBeInTheDocument();
  expect(screen.queryByText(/required fields before continuing/i)).not.toBeInTheDocument();
});
```
`LegsStep.test.tsx` (628-679) — replace "blocks Next when the route has errors" with:
```tsx
it("Next advances from Step 4 even when the route has errors (Round-1 Common #5)", async () => {
  // …render the legs step body with an incomplete route (baseDetail)…
  await user.click(screen.getByRole("button", { name: /next/i }));
  expect(screen.queryByText(/before continuing/i)).not.toBeInTheDocument();
  // Step 5 heading is shown
  expect(await screen.findByText(/Checklist/i)).toBeInTheDocument();
});
```
Adjust `Step1Client.test.tsx`/`Step2Shipment.test.tsx` if they call the registered save with `{ enforceRequired: true }` — those calls become argument-less.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @svyft/web test QueryWizardPage LegsStep`
Expected: FAIL (gates still block; the new assertions don't hold yet).

- [ ] **Step 3: Drop `enforceRequired` from the contract + shell + page**

`Step1Client.tsx:39-41` — the `StepSaveFn` interface becomes:
```ts
export interface StepSaveFn {
  (): Promise<QuerySaveInput | void>;
}
```
`WizardShell.tsx` — `onSave: () => Promise<void>` (drop the opts in the prop type + JSDoc); replace `runSave`/`handleSave`/`handleNext`:
```ts
  const runSave = async (): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      await onSave();
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "unknown error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (await runSave()) setSaveSuccess("Changes saved."); // U3
  };

  const handleNext = async () => {
    // Round-1 Common #5: Next never blocks. Best-effort save, then advance regardless.
    // Swallow a save rejection here (inline field errors already surface format issues
    // on the step) so we don't raise a confusing top-notice on the step we just left.
    setSaveError(null);
    setSaveSuccess(null);
    try {
      await onSave();
    } catch {
      /* never block navigation */
    }
    goNext();
  };
```
`QueryWizardPage.tsx:128-141` — `handleSave` drops `opts`:
```ts
  const handleSave = useCallback(
    async () => {
      const input = stepSaveRef.current ? await stepSaveRef.current() : undefined;
      if (isNew) {
        const d = await create(input ?? {});
        navigate(`/queries/${d.id}?step=0`, { replace: true });
      } else if (id && input) {
        await patch(id, input);
        await refresh();
      }
    },
    [isNew, id, create, patch, navigate, refresh],
  );
```

- [ ] **Step 4: Strip the per-step gate bodies**

`Step1Client.tsx` — delete the `STEP1_REQUIRED` const and, inside `submitRef.current`, delete the `if (opts?.enforceRequired) { … }` block (the whole missing-fields branch). The save fn signature becomes `() =>`; keep the `form.handleSubmit(onValid, onInvalid)` shape (onInvalid still `reject(new Error("Please fix the highlighted fields."))` — that surfaces format issues on explicit Save; Next ignores it). `registerSave(() => submitRef.current ? submitRef.current() : Promise.resolve())`.

`Step2Shipment.tsx` — the save fn becomes argument-less; delete the `if (opts?.enforceRequired && !values.incoterms) { … }` block. Keep the `form.trigger([...])`/throw (format guard for Save; non-blocking for Next).

`legs/LegsStep.tsx:103-115` — replace the route-findings `registerSave` effect body with a no-op (legs/points persist eagerly; nothing to save, and validation is Create-only now):
```ts
  useEffect(() => {
    registerSave(() => Promise.resolve(undefined));
  }, [registerSave]);
```
Remove the now-unused `validateOnServer` from the `useRouteFindings` destructure if it's unused elsewhere in the body (keep `all`, `grouped`); run typecheck to confirm.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test QueryWizardPage LegsStep Step1Client Step2Shipment && pnpm --filter @svyft/web typecheck`
Expected: PASS. The `RouteNoticesStrip` (advisory display) stays; only the *gate* is gone.

- [ ] **Step 6: Commit**
```bash
git add apps/web/src/features/query-wizard
git commit -m "refactor(web): remove Save/Next validation gating (validate at Create only)"
```

---

## Task 9: PointEditor — remove hard-block-on-save

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx:149-171`
- Modify: `apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx:320-353`

**Change:** delete the `POINT_REQUIRED_FIELDS` missing-field early-return in `handleSubmit`. Partial points persist; format validators (IATA/ICAO/UN-LOCODE/phone/email) still surface inline via `zodResolver`. Keep the `RequiredMark` asterisks (display-only). The `POINT_REQUIRED_FIELDS` import stays (used by `RequiredMark`).

- [ ] **Step 1: Rewrite the failing test**

Replace the "blocks Save when a mandatory field for the type is missing (#4)" test with:
```tsx
it("saves a partial point without hard-blocking on missing type fields (Round-1 Common #5)", async () => {
  const add = vi.fn().mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });
  // …render PointEditor (type AIRPORT) with only name filled, usePoints.add mocked to `add`…
  await user.click(screen.getByRole("button", { name: /^save$/i }));
  expect(add).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test PointEditor`
Expected: FAIL (the early-return blocks the `add` call).

- [ ] **Step 3: Delete the hard-block**

In `handleSubmit` (`PointEditor.tsx`), remove the block:
```ts
    const missing = (POINT_REQUIRED_FIELDS[activeType] as (keyof PointSaveInput)[]).filter(…);
    if (missing.length) { missing.forEach((f) => form.setError(…)); return; }
```
so the handler goes straight from `form.handleSubmit(async (data) => {` to the `isEdit ? update : add` branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test PointEditor && pnpm --filter @svyft/web typecheck`
Expected: PASS (fix the unused-var lint if `POINT_REQUIRED_FIELDS`/`PointSaveInput` become unused — they should still be used by `RequiredMark`).

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx
git commit -m "refactor(web): PointEditor saves partial points (no hard-block)"
```

---

## Task 10: LegEditor — remove hard-block-on-save + rename "Save Leg" → "Save"

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx:64-72, 148-165, 413`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegEditor.test.tsx:420-454`

**Change:** delete the `LEG_REQUIRED` const + the missing-field/cargo `hasMissing` early-return in `handleSubmit`; rename the submit button to "Save". `legSaveSchema` is fully optional (draft-lenient) and its G10/G12 refines only fire when both fields are present, so partial legs persist and the server V-M1 422 path is unchanged. Keep the `assignedCargoIds` error display block (it renders schema errors, which no longer include the manual "≥1" rule).

- [ ] **Step 1: Rewrite the failing test**

Replace "blocks Save when mandatory fields are missing (#4)" with:
```tsx
it("saves a partial leg without hard-blocking (Round-1 Common #5)", async () => {
  const add = vi.fn().mockResolvedValue({ id: "…uuid…" });
  // …render LegEditor (add mode) with origin+destination+mode set, cargo/dates empty; useLegs.add mocked…
  await user.click(screen.getByRole("button", { name: /^save$/i }));
  expect(add).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test LegEditor`
Expected: FAIL (the `hasMissing` early-return blocks `add`; the button is "Save Leg" so `/^save$/i` doesn't match).

- [ ] **Step 3: Delete the block + rename the button**

In `handleSubmit`, remove the `LEG_REQUIRED` loop + the `assignedCargoIds` length check + `if (hasMissing) return;` so it goes straight to `setServerFindings([]); try { … add/update … }`. Delete the now-unused `LEG_REQUIRED` const (lines 64-72). Change the footer button (line 413) from `Save Leg` to `Save`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test LegEditor && pnpm --filter @svyft/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx apps/web/src/features/query-wizard/steps/legs/LegEditor.test.tsx
git commit -m "refactor(web): LegEditor saves partial legs; standardize button to Save"
```

---

## Task 11: Shipment (Step 2) — remove the DG-indicator field + Incoterms default "Select" (with "N/A")

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step2Shipment.tsx:31-38, 58-94, 105-186`
- Modify: `apps/web/src/features/query-wizard/steps/Step2Shipment.test.tsx`

**Change:** remove the DG-Indicator checkbox field from the UI (the query's `dgIndicator` stays server-side, derived/synced from cargo). Drop `dgIndicator` from `fromDetail`, the `form.trigger` list, and the PATCH payload. The Incoterms `<Select>` now includes "N/A" automatically (Task 2) and shows the "Select" placeholder when empty (already `value={field.value ?? ""}`, placeholder → "Select"). Depends on Task 8 (this file's save fn is now argument-less).

- [ ] **Step 1: Write/adjust the failing test**

In `Step2Shipment.test.tsx`:
```tsx
it("no longer renders a DG Indicator field", () => {
  // …render Step2 with a detail…
  expect(screen.queryByLabelText(/DG Indicator/i)).not.toBeInTheDocument();
});
it("offers N/A as an incoterm option", async () => {
  // …render, open the Incoterms select…
  await user.click(screen.getByLabelText("Incoterms"));
  expect(await screen.findByText("N/A")).toBeInTheDocument();
});
```
Remove/replace any existing test that toggles the DG checkbox.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test Step2Shipment`
Expected: FAIL (DG field still present).

- [ ] **Step 3: Remove the DG field + payload**

`Step2Shipment.tsx`:
- `fromDetail` (31-38): drop the `dgIndicator: …` line.
- Save fn (58-88): change `form.trigger(["incoterms", "shipmentDescription", "dgIndicator"])` → `form.trigger(["incoterms", "shipmentDescription"])`; drop `dgIndicator` from the `payload` object.
- Delete the entire `{/* DG Indicator */}` `<FormField name="dgIndicator" …>` block (161-186).
- Incoterms `<SelectValue placeholder="Select incoterms" />` → `placeholder="Select"` (Common #10).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test Step2Shipment && pnpm --filter @svyft/web typecheck`
Expected: PASS. (The `Checkbox` import may become unused — remove it.)

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/Step2Shipment.tsx apps/web/src/features/query-wizard/steps/Step2Shipment.test.tsx
git commit -m "feat(web): remove DG-indicator field from Shipment; Incoterms N/A + Select default"
```

---

## Task 12: Step 1 — Response-Deadline default-by-priority (recompute-until-touched)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.test.tsx`

**Interfaces:** Consumes `defaultResponseDeadline`, `RESPONSE_DEADLINE_HOURS` (Task 3). Depends on Task 8 (Step-1 save fn is argument-less).

**Design:** when Query Date + Priority are known and the exec has NOT manually edited Response Deadline, set `responseDeadline = defaultResponseDeadline(queryDate, priority)`. Track "touched" with a ref set on the Response-Deadline input's `onChange` and when the loaded `detail` already has a `responseDeadline`. Recompute on Priority change (Step-1's own Priority select) until touched.

- [ ] **Step 1: Write the failing test**
```tsx
it("defaults Response Deadline to Query Date + 24h for MEDIUM and recomputes on priority change until edited", async () => {
  // …render Step 1 for a saved query whose detail has queryDate=2026-07-22T09:00:00Z,
  //    priority MEDIUM, and responseDeadline=null…
  const deadline = screen.getByLabelText(/Response Deadline/i) as HTMLInputElement;
  await waitFor(() => expect(deadline.value).not.toBe(""));      // auto-filled
  // switch priority to URGENT (Step-1 Priority select) → recompute
  // …select URGENT…
  await waitFor(() => expect(deadline.value).not.toBe(""));       // still filled, changed
  // manual edit marks it touched
  await user.clear(deadline);
  await user.type(deadline, "2026-07-30T10:00");
  // …switch priority again… deadline stays the manual value
  expect(deadline.value).toBe("2026-07-30T10:00");
});
```
> Assert on non-empty / stability rather than exact digits — `isoToLocalInput` renders in the runner's local zone (timezone-exact display is increment 4). Mirror Step1's existing render/detail-mock setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test Step1Client`
Expected: FAIL (no auto-default today).

- [ ] **Step 3: Implement default-until-touched**

`Step1Client.tsx` — import `defaultResponseDeadline` from `@svyft/shared`; add a `deadlineTouchedRef` (`useRef(false)`), initialise it to `true` in the `detail` reset effect when `detail.responseDeadline` is present. Add an effect:
```ts
  const watchedPriority = form.watch("priority");
  const watchedQueryDate = form.watch("queryDate");
  useEffect(() => {
    if (deadlineTouchedRef.current) return;
    if (!watchedQueryDate || !watchedPriority) return;
    form.setValue("responseDeadline", defaultResponseDeadline(watchedQueryDate, watchedPriority));
  }, [watchedPriority, watchedQueryDate, form]);
```
On the Response-Deadline `<Input onChange>` (the `field.onChange` wrapper), set `deadlineTouchedRef.current = true;` before calling `field.onChange(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test Step1Client && pnpm --filter @svyft/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/Step1Client.tsx apps/web/src/features/query-wizard/steps/Step1Client.test.tsx
git commit -m "feat(web): default Response Deadline by priority (recompute-until-touched)"
```

---

## Task 13: Cargo (Step 3) — Add/Edit as a modal Dialog with Save/Cancel

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step3Cargo.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/cargo/CargoRowForm.tsx:375-382, 595-598`
- Modify: `apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx`

**Change:** "+ Add Row" and each row's "Edit" open a shadcn `Dialog` hosting `CargoRowForm` (instead of an inline panel / expandable row). Rename the form submit buttons "Add Row" → "Save" and "Save Changes" → "Save"; Cancel stays. On successful submit, close the dialog (existing `setShowAddForm(false)` / `setEditingId(null)` already do this). Preserve the current MSDS-on-edit `<input type=file>` behavior as-is.

- [ ] **Step 1: Write the failing test**

In `Step3Cargo.test.tsx`:
```tsx
it("opens the Add-cargo dialog with Save + Cancel", async () => {
  // …render Step 3 for a saved query with cargo endpoints mocked…
  await user.click(screen.getByRole("button", { name: /add row/i }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("button", { name: /^save$/i })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
});
```
Update any existing assertion that expected the inline "Add Cargo Row" panel / the "Add Row" or "Save Changes" button text.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test Step3Cargo`
Expected: FAIL (no `dialog` role; buttons are "Add Row"/"Save Changes").

- [ ] **Step 3: Wrap the forms in a Dialog + rename buttons**

`CargoRowForm.tsx` — button text: `Add Row` → `Save` (375-382 area) and `Save Changes` → `Save` (595-598). Remove the inner `<h3>` heading from AddForm/EditForm (the DialogTitle carries it) and drop the outer `border rounded-md p-4 bg-*` wrapper classes on the `<form>` (the DialogContent provides the frame) — keep `className="space-y-4"`.

`Step3Cargo.tsx` — replace the inline `{showAddForm && <CargoRowForm mode="add" …/>}` and the expandable edit `<TableRow>` with a single Dialog. Add imports:
```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
```
Render one Dialog controlled by `showAddForm || editingId !== null`:
```tsx
      <Dialog
        open={showAddForm || editingId !== null}
        onOpenChange={(o) => { if (!o) { setShowAddForm(false); setEditingId(null); } }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Cargo Row" : "Add Cargo Row"}</DialogTitle>
          </DialogHeader>
          {editingId ? (
            (() => {
              const row = cargoRows.find((r) => r.id === editingId);
              return row ? (
                <CargoRowForm mode="edit" row={row} onSubmit={handleUpdate}
                  onCancel={() => setEditingId(null)} uploadMsds={cargo.uploadMsds} />
              ) : null;
            })()
          ) : (
            <CargoRowForm mode="add" onSubmit={handleAdd} onCancel={() => setShowAddForm(false)} />
          )}
        </DialogContent>
      </Dialog>
```
Delete the inline add block (108-114) and the `{editingId === row.id && <TableRow …>}` expandable edit block (185-199); the row "Edit" button keeps `onClick={() => { setEditingId(row.id); setShowAddForm(false); }}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test Step3Cargo && pnpm --filter @svyft/web typecheck`
Expected: PASS. (Remove any now-unused `Fragment` import.)

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/Step3Cargo.tsx apps/web/src/features/query-wizard/steps/cargo/CargoRowForm.tsx apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx
git commit -m "feat(web): cargo Add/Edit as a modal dialog with Save/Cancel"
```

---

## Task 14: Rename "Legs / Route" → "Leg & Route"

**Files:**
- Modify: `apps/web/src/features/query-wizard/WizardContext.tsx:11`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx:372`
- Modify: `apps/web/src/features/query-wizard/steps/LegsStep.tsx:9` (doc comment)
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegsStep.test.tsx:172, 389, 398`

- [ ] **Step 1: Write/adjust the failing test**

`LegsStep.test.tsx` — the step-navigation helper clicks the stepper tab by its label at line 398. Change that query text (and the two comments 172/389) to `Leg & Route`, and add a heading assertion:
```tsx
expect(screen.getByRole("heading", { name: "Leg & Route" })).toBeInTheDocument();
```
in the test that renders `LegsStepBody`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/web test LegsStep`
Expected: FAIL (label is still "Legs / Route").

- [ ] **Step 3: Rename**

- `WizardContext.tsx:11` → `{ key: "legs", label: "Leg & Route" },`
- `steps/legs/LegsStep.tsx:372` → `<h2 className="text-base font-semibold">Leg & Route</h2>`
- `steps/LegsStep.tsx:9` doc comment → "Step 4 — Leg & Route."

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/web test LegsStep QueryWizardPage && pnpm --filter @svyft/web typecheck`
Expected: PASS (grep the repo for any other `Legs / Route` literal a test relies on and update it).

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/WizardContext.tsx apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx apps/web/src/features/query-wizard/steps/LegsStep.tsx apps/web/src/features/query-wizard/steps/legs/LegsStep.test.tsx
git commit -m "feat(web): rename step label + heading to 'Leg & Route'"
```

---

## Task 15: Compact-layout pass (Step 1 grids + Query List density) + dropdown-default polish

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.tsx` (section wrappers)
- Modify: `apps/web/src/features/query-list/QueriesListPage.tsx` (container spacing)
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.test.tsx` (regression only)

**Change (Common #1/#3/#9/#10):** reduce vertical scroll on the longest screen (Step 1) by laying each section's fields into a responsive 2-column grid; tighten section spacing. No logic changes. Confirm dropdown defaults: Priority keeps its business default `MEDIUM`; other wizard dropdowns show a "Select" placeholder (already true after Task 11 for Incoterms). This is a cosmetic/regression task — verify existing render tests still pass; add one light assertion that all Step-1 fields still render.

- [ ] **Step 1: Add a regression assertion**

In `Step1Client.test.tsx`, in an existing "renders the form" test (or add one), assert the key fields all render after the layout change:
```tsx
for (const label of [/Query Date/i, /Priority/i, /Response Deadline/i, /Company \/ Client/i, /Contact Name/i, /Email/i, /Phone/i, /Ready Date/i, /Target Delivery/i]) {
  expect(screen.getByText(label)).toBeInTheDocument();
}
```

- [ ] **Step 2: Run it (should pass pre-change — this is a guardrail)**

Run: `pnpm --filter @svyft/web test Step1Client`
Expected: PASS now; it must still pass after the layout edit.

- [ ] **Step 3: Gridify Step 1 + tighten Query List**

`Step1Client.tsx` — for each section (`Query Details`, `Client & Contact`, `Vessel & Schedule`, `Delivery`), wrap the `FormField`s in a `<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">` (keep the section `<h2>` outside the grid; keep full-width fields like the picker/notes spanning both columns with `sm:col-span-2` where it reads better). Change the outer `form` spacing `space-y-6` → `space-y-5` and section `space-y-4` as-is. Purely structural — do not touch any `FormField` `name`, control, or handler.

`QueriesListPage.tsx` — keep `space-y-4`; ensure the toolbar + table + `PaginationBar` fit without a page scrollbar at desktop widths (no functional change; adjust only container padding/margins if needed).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test Step1Client query-list && pnpm --filter @svyft/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/Step1Client.tsx apps/web/src/features/query-list/QueriesListPage.tsx apps/web/src/features/query-wizard/steps/Step1Client.test.tsx
git commit -m "style(web): compact Step-1 grid layout + Query List density"
```

---

## Definition of Done

- [ ] All 15 tasks committed on `feat/plan-6b-req-issues-round1-common-fixes`.
- [ ] **`pnpm run ci` is green** (shared + web + api) — run it from the repo root and confirm the output before finishing. Web count grows from the added tests; shared grows (E.164/Incoterms/deadline); api unchanged (105) unless a contact fixture needed a `+`.
- [ ] `pnpm --filter @svyft/web typecheck` clean (esbuild hides type errors).
- [ ] Opus **whole-branch review** (per subagent-driven-development) — expect it to probe: the Next-never-blocks best-effort-save (no data loss on advance), the "All"-filter merge (stale keys cleared), the cargo Dialog (MSDS-on-edit still works), and the E.164 tightening (no valid fixture broken).
- [ ] Finish via `superpowers:finishing-a-development-branch` → PR to `main`; update `docs/Stage 3 - Session Handoff.md` (mark increment 1 done; next = `validation-summary`).

## Self-Review notes (spec coverage)

- Common #1/#3 → Task 15 (compact pass). #2 → Tasks 6, 7 (paginate @10 + control, Query List + Masters). #4/#5/#6 → Task 8 (+ 9, 10) (validate at Create; Save/Next never block; no mandatory-empty inline msg — `.partial()` schema). #7 → Task 1 (strict E.164 incl. Masters `contactNo`; fax untouched). #8 → Tasks 10, 13 (+ PointEditor already Save/Cancel) (popups Save/Cancel; cargo → modal). #9/#10 → Tasks 11, 15 (business default kept; "Select" otherwise).
- Query List screen → Tasks 4 (All filters), 5 (date-range), 6 (paginate). Client & Query → Task 12 (deadline default). Shipment → Task 11 (remove DG indicator; Incoterms N/A). Cargo → Task 13 (add-row popup). Leg & Route → Task 14 (rename). Editors → Tasks 9, 10 (+ Save/Cancel). WizardShell → Task 8 (relax Next).
- Deferred (NOT in this plan, by design): Validation-Summary + stepper badges + Notes/checklist-mandatory (increment 2); Route Canvas (increment 3); Timezone + migration + Deadline-≥-QueryDate real-instant + date-column zone labels (increment 4); MSDS hold-&-send + delete endpoint; Shipment-step merge; G6; D2/D4.
