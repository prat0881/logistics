## Task 2 Report: shadcn primitives + Stepper + DataTable

### Status: DONE

### Components Added (via shadcn CLI)
- `calendar.tsx`, `command.tsx`, `form.tsx` — newly created by CLI
- `table.tsx`, `select.tsx`, `checkbox.tsx`, `textarea.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `popover.tsx`, `tooltip.tsx`, `separator.tsx`, `card.tsx` — already existed (skipped by CLI, not overwritten)
- `button.tsx`, `label.tsx` — already existed (Task 1 versions preserved)

### Libraries Added
- `@tanstack/react-table`, `react-day-picker`, `date-fns`, `cmdk`
- `@radix-ui/react-select`, `@radix-ui/react-checkbox`, `@radix-ui/react-dialog`
- `@radix-ui/react-dropdown-menu`, `@radix-ui/react-popover`, `@radix-ui/react-tooltip`
- `@radix-ui/react-separator`, `@radix-ui/react-label`, `@radix-ui/react-slot`

### Bespoke Components
- `stepper.tsx` — horizontal/vertical wizard step navigator with `bg-primary` (current), `bg-success` (completed), `bg-muted` (upcoming); CVA + cn(); `aria-current="step"`, `data-completed` attr, keyboard-accessible
- `data-table.tsx` — TanStack `useReactTable` + shadcn Table primitives; controlled sort/pagination (manualSorting/manualPagination); clickable rows with keyboard support (role="button", Enter/Space); loading skeleton; empty state "No queries match your filters."

### TDD Evidence
**Stepper:**
- RED: `pnpm --filter @svyft/web test -- stepper` → FAIL (module not found)
- GREEN: After implementing `stepper.tsx` → 1/1 passed

**DataTable:**
- RED: `pnpm --filter @svyft/web test -- data-table` → FAIL (module not found)
- GREEN: After implementing `data-table.tsx` → 2/2 passed

### Theme Files — Unchanged
- `index.css` md5 before: `92b25198661c26b1a9332c907e5cc302` | after: `92b25198661c26b1a9332c907e5cc302` ✓
- `tailwind.config.ts` md5 before: `3465b833b6ce0c0ecfd295370cdd60d6` | after: `3465b833b6ce0c0ecfd295370cdd60d6` ✓

### Test Results (Full Suite)
```
Test Files  11 passed (11)
Tests       20 passed (20)
```
- 17 pre-existing tests: all green
- Stepper: 1 new test green
- DataTable: 2 new tests green

### Files Changed
- `apps/web/package.json` — new deps
- `pnpm-lock.yaml` — lockfile update
- `apps/web/src/components/ui/stepper.tsx` — new
- `apps/web/src/components/ui/stepper.test.tsx` — new
- `apps/web/src/components/ui/data-table.tsx` — new
- `apps/web/src/components/ui/data-table.test.tsx` — new
- `apps/web/src/components/ui/calendar.tsx` — new (shadcn CLI)
- `apps/web/src/components/ui/command.tsx` — new (shadcn CLI)
- `apps/web/src/components/ui/form.tsx` — new (shadcn CLI)

### Concerns
None. The shadcn CLI declined to overwrite button.tsx and label.tsx (said no to prompt), which preserves Task 1's custom bespoke versions. The 10 other shadcn primitives (table, select, checkbox, etc.) were already present (likely from a prior Task 1 run), so the CLI reported them as skipped.
