# Task 3 Report: api-client errors, dates, findings dedup, FindingsPanel, test harness

## What Was Built

### 1. `apps/web/src/lib/api.ts` (modified)
- Added `class ApiError extends Error` with `status`, `findings`, `issues`, `body` fields — backward-compatible with existing `catch (e)` sites
- Added internal `raise(res)` helper that parses 422 `{findings}` and 400 `{message, issues}` envelopes
- Updated `fetchJson`, `postJson`, `patchJson` to call `raise(res)` instead of `throw new Error()`
- Added 204 guard to `postJson` and `patchJson` (returns `undefined` instead of trying to parse empty body)
- Added `export async function del(url): Promise<void>` using DELETE + `raise(res)`

### 2. `apps/web/src/lib/dates.ts` (new)
- `formatDateTime(iso: string | null): string` — formats to "DD-MM-YYYY HH:mm" via `date-fns` `format`/`parseISO`, returns `""` for null/empty
- `formatDate(iso: string | null): string` — formats to "DD-MM-YYYY", same null guard
- `toIsoOffset(local: string): string` — converts datetime-local value to offset ISO string using local timezone

### 3. `packages/shared/src/findings.ts` (modified)
- Added `dedupeFindings(findings: Finding[]): Finding[]` — deduplication by `rule|severity|scope.type|scope.id|message` key

### 4. `apps/web/src/components/FindingsPanel.tsx` (new)
- Groups by severity: `blocking` → `bg-destructive/10 text-destructive` with `role="alert"`, `warning` → `bg-warning/10 text-warning`
- Each row: rule tag in `font-mono`, message, optional clickable scope chip
- Deduplicates via `dedupeFindings` before rendering
- Returns `null` when no findings

### 5. `apps/web/src/test/renderWithProviders.tsx` (new)
- Wraps UI in `QueryClientProvider(retry:false)` + `AuthProvider` + `MemoryRouter initialEntries=[route]`
- Accepts `{ route?, user? }` options; caller stubs `fetch` including `/api/auth/me`

## TDD RED/GREEN

| Unit | RED | GREEN |
|------|-----|-------|
| `ApiError` (api.test.ts) | 3 of 4 failed — `ApiError` undefined, no `status` on Error | All 4 pass after implementing class + `raise()` |
| `dates.ts` (dates.test.ts) | File not found / transform error | All 7 pass after implementing `dates.ts` |
| `dedupeFindings` (findings.test.ts) | All 7 failed — `dedupeFindings is not a function` | All 7 pass after adding to `findings.ts` + rebuild |
| `FindingsPanel` (FindingsPanel.test.tsx) | File not found / transform error | All 7 pass after implementing component |

## Existing Masters Tests: Unbroken
- `ClientFormPage.test.tsx` (1 test): PASS
- `ClientsListPage.test.tsx` (2 tests): PASS
- `VesselFormPage.test.tsx` (2 tests): PASS
- `VesselsListPage.test.tsx` (2 tests): PASS

All 7 masters tests pass — `ApiError extends Error` is backward-compatible.

## Full Test Gate
- `pnpm run test`: web 38/38 pass (14 files), shared 7/7 findings pass, API 105/105 pass
- `pnpm run ci`: lint ✓, typecheck pre-existing failures in `calendar.tsx` and `form.tsx` (present on base commit before this task, not introduced here), tests ✓, build ✓

## Files Changed
- Modified: `apps/web/src/lib/api.ts`
- Created: `apps/web/src/lib/api.test.ts`
- Created: `apps/web/src/lib/dates.ts`
- Created: `apps/web/src/lib/dates.test.ts`
- Modified: `packages/shared/src/findings.ts`
- Created: `packages/shared/src/findings.test.ts`
- Created: `apps/web/src/components/FindingsPanel.tsx`
- Created: `apps/web/src/components/FindingsPanel.test.tsx`
- Created: `apps/web/src/test/renderWithProviders.tsx`

## Concerns
- The `calendar.tsx` and `form.tsx` TypeScript errors (pre-existing since Task 1 shadcn install) still fail `typecheck`. They block `pnpm run ci` at the typecheck step. These are not introduced by Task 3 — confirmed by checking the base commit. Recommend fixing in a separate task (likely a React 19 / shadcn version mismatch where `ref` was removed from component props).
- The `renderWithProviders` does not accept a `Routes` wrapper — callers needing route-matched `<Route>` elements must add their own `<Routes>` inside the `ui` argument (same pattern as ClientFormPage.test.tsx).
