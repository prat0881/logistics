# Plan 6b — Req & Issues Round 1 — Validation Summary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make **Create Query the single hard gate** — on Create, run the full validation (mandatory fields + route + a new **Notes + all-9-checklist-boxes** manual gate) and, if anything fails, show a **validation summary grouped by wizard tab** (each line click-to-navigate) plus **red-dot count badges on the stepper tabs**; drop the old "Save Draft / Send Anyway" optional-gaps prompt and the DG-conditional checklist disable.

**Architecture:** Web + shared only (Issue 2 is a client Create-gate UI). Two pure `@svyft/shared` additions — a `findingTabKey(finding)` bucketing function and a `collectChecklistFindings(items, notes)` gate — feed a new `ValidationSummary` component and per-tab stepper badges. Enforcement is **client-side in the Create-preview** (`handleCreateQuery`), which already mirrors the server's F1/F6/route checks and aborts before the server call; the server `createQuery` is unchanged (its authoritative checklist gate is deferred — see Global Constraints). No Prisma migration, no api change.

**Tech Stack:** React 18 + Vite + Tailwind + shadcn/ui (Radix) + TanStack Query + RHF + Zod · `@svyft/shared` isomorphic zod + findings · Vitest + `renderWithProviders`/`mockFetch` (web), Vitest (shared).

## Global Constraints

- **`pnpm run ci` MUST be green before finishing** (shared + web + api). Baseline on `main` after increment 1: **shared 137 · web 188 · api 105**.
- **Build shared first for the LOCAL gate:** web vitest resolves `@svyft/shared` from compiled **dist** (`apps/web/vitest.config.ts` aliases only `@`). Run `pnpm --filter @svyft/shared build` before local web tests / `pnpm run ci`. GitHub CI (`ci.yml`) already builds shared first — it's the authoritative gate.
- **Web CI gotcha:** `vite build` SKIPS type errors — always run `pnpm --filter @svyft/web typecheck` (or `pnpm run ci`).
- **Shared enums/types:** `const` object + `Object.values(...) as [X,...X[]]`, pinned by a `toEqual` test where applicable. Never a TS `enum`.
- **Web tests:** Vitest + `renderWithProviders` (`@/test/renderWithProviders`) + `mockFetch` (`@/test/mock-fetch`); stub `/api/auth/me` + endpoints; `afterEach(vi.unstubAllGlobals())`. **Radix Select is jsdom-flaky** → drive via the sibling test's pattern or assert values another way. Valid UUIDs for `.uuid()` fields.
- **Finding shape (do NOT change the interface):** `Finding { rule: string; severity: "blocking"|"warning"; scope: { type: "query"|"leg"|"cargo"|"point"|"field"; id?: string }; message: string }`. Bucketing uses `scope` + `rule` only — no new Finding fields.
- **Tab keys** are the wizard step keys verbatim: `"client" | "shipment" | "cargo" | "legs" | "notes"` (from `WizardContext.STEPS`).
- **Commit per task**; conventional scope `web`/`shared`. **Branch:** `feat/plan-6b-req-issues-round1-validation-summary` off `main`.
- **Out of scope / deferred (do NOT build here):** Route Canvas (increment 3); Timezone + migration + zone labels (increment 4); MSDS hold-&-send + delete endpoint; Shipment-step merge; G6; D2/D4. **Server-side authoritative checklist/notes gate** (this increment enforces it client-side in the Create-preview, consistent with how F1/route already work; a future hardening task can add it to `queries.service.ts createQuery`).

---

## Design decisions (read before implementing)

- **Finding → tab bucketing** (`findingTabKey`, pure, shared):
  - `scope.type === "cargo"` OR `rule === "F6"` → `"cargo"`
  - `scope.type === "leg"` OR `scope.type === "point"` → `"legs"`
  - `scope.type === "field"` && `scope.id === "incoterms"` → `"shipment"`
  - `scope.type === "field"` && (`scope.id === "notes"` || `scope.id` starts with `"checklist"`) → `"notes"`
  - `scope.type === "query"` → `rule === "F1"` ? `"client"` : `"legs"` (F1 = field-mandatory → Client & Query; every other query-scoped finding is a route rule → Leg & Route)
  - fallback → `"client"`
- To make the **incoterms** mandatory finding land on the **Shipment** tab, `collectCreateFindings` emits it with `scope: { type: "field", id: "incoterms" }` (instead of `{ type: "query" }`). All other F1 field-mandatory findings keep `scope: { type: "query" }`.
- **Checklist/notes gate** (`collectChecklistFindings`, pure, shared): one blocking finding per unchecked box (`scope { type:"field", id:"checklist:<key>" }`) + one for empty/whitespace notes (`scope { type:"field", id:"notes" }`), all `rule: "F7"`. **All 9 boxes are required regardless of DG** (drop the DG-conditional disable) — per the design's "pure manual confirmation" gate.

---

## File Structure

**`packages/shared/src/`**
- `findings.ts` — ADD `FindingTab` type + `findingTabKey(finding): FindingTab`.
- `query.ts` — MODIFY `collectCreateFindings` (incoterms → field scope); ADD `collectChecklistFindings(items, notes)`.
- `findings.test.ts` (NEW) + `query.test.ts` — tests.

**`apps/web/src/`**
- `components/ValidationSummary.tsx` (NEW) + test — findings grouped by tab, click-to-navigate.
- `components/ui/stepper.tsx` — MODIFY: `StepDef.badgeCount?` + red-dot/count render.
- `components/FindingsPanel.tsx` + `FindingsPanel.test.tsx` — DELETE (superseded; only WizardShell used it).
- `features/query-wizard/CreateQueryDialog.tsx` — DELETE (optional-gaps prompt removed).
- `features/query-wizard/steps/Step5Notes.tsx` — MODIFY: all 9 boxes tickable + required markers; drop DG-conditional disable + `DG_CONDITIONAL_KEY`.
- `features/query-wizard/QueryWizardPage.tsx` — MODIFY: `handleCreateQuery` runs the checklist gate; remove the optional-gaps dialog flow.
- `features/query-wizard/WizardShell.tsx` — MODIFY: render `ValidationSummary` (nav → `setStep`) + compute per-tab badge counts → `Stepper`.
- Corresponding `*.test.tsx` + `QueryWizard.e2e.test.tsx` — updated.

---

## Task 1: Shared — `findingTabKey` bucketing + incoterms → field scope

**Files:**
- Modify: `packages/shared/src/findings.ts`
- Modify: `packages/shared/src/query.ts` (`collectCreateFindings` incoterms finding)
- Create: `packages/shared/src/findings.test.ts`
- Modify: `packages/shared/src/query.test.ts`

**Interfaces — Produces:**
- `export type FindingTab = "client" | "shipment" | "cargo" | "legs" | "notes";`
- `export function findingTabKey(f: Finding): FindingTab;`
- `collectCreateFindings` now emits the incoterms finding with `scope: { type: "field", id: "incoterms" }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/findings.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { findingTabKey } from "./findings";
import type { Finding } from "./findings";

const f = (over: Partial<Finding>): Finding => ({
  rule: "F1", severity: "blocking", scope: { type: "query" }, message: "x", ...over,
});

describe("findingTabKey", () => {
  it("F1 query-mandatory → client", () => {
    expect(findingTabKey(f({ rule: "F1", scope: { type: "query", id: "q1" } }))).toBe("client");
  });
  it("incoterms field finding → shipment", () => {
    expect(findingTabKey(f({ rule: "F1", scope: { type: "field", id: "incoterms" } }))).toBe("shipment");
  });
  it("F6 / cargo → cargo", () => {
    expect(findingTabKey(f({ rule: "F6", scope: { type: "cargo", id: "c1" } }))).toBe("cargo");
    expect(findingTabKey(f({ rule: "R2", scope: { type: "cargo", id: "c1" } }))).toBe("cargo");
  });
  it("leg / point / query-scoped route rule → legs", () => {
    expect(findingTabKey(f({ rule: "R1", scope: { type: "leg", id: "l1" } }))).toBe("legs");
    expect(findingTabKey(f({ rule: "R8", scope: { type: "point", id: "p1" } }))).toBe("legs");
    expect(findingTabKey(f({ rule: "R3", scope: { type: "query", id: "q1" } }))).toBe("legs");
  });
  it("checklist / notes field findings → notes", () => {
    expect(findingTabKey(f({ rule: "F7", scope: { type: "field", id: "notes" } }))).toBe("notes");
    expect(findingTabKey(f({ rule: "F7", scope: { type: "field", id: "checklist:weight-confirmed" } }))).toBe("notes");
  });
});
```
In `packages/shared/src/query.test.ts`, add to the `collectCreateFindings` area (import `collectCreateFindings` if not already):
```ts
it("emits the incoterms finding with a field/incoterms scope (buckets to Shipment)", () => {
  const findings = collectCreateFindings(
    { id: "q1", clientId: "c", contactName: "n", contactEmail: "e@x.com", contactPhone: "+6591234567", readyDate: "2026-08-01T00:00:00Z", targetDelivery: "2026-08-02T00:00:00Z", incoterms: null },
    [],
  );
  const inco = findings.find((f) => f.message === "Incoterms is required");
  expect(inco?.scope).toEqual({ type: "field", id: "incoterms" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @svyft/shared test`
Expected: FAIL (`findingTabKey` undefined; incoterms scope is currently `query`).

- [ ] **Step 3: Implement**

`packages/shared/src/findings.ts` — append:
```ts
/** Wizard tab a finding buckets into for the Create-Query Validation Summary. */
export type FindingTab = "client" | "shipment" | "cargo" | "legs" | "notes";

/**
 * Bucket a Finding to a wizard tab (Round-1 Issue 2). Uses scope + rule only.
 * - cargo/F6 → cargo; leg|point → legs; field/incoterms → shipment;
 *   field/notes|checklist → notes; query-scoped: F1 (field-mandatory) → client,
 *   otherwise (route rule) → legs.
 */
export function findingTabKey(f: Finding): FindingTab {
  if (f.scope.type === "cargo" || f.rule === "F6") return "cargo";
  if (f.scope.type === "leg" || f.scope.type === "point") return "legs";
  if (f.scope.type === "field") {
    if (f.scope.id === "incoterms") return "shipment";
    if (f.scope.id === "notes" || f.scope.id?.startsWith("checklist")) return "notes";
  }
  if (f.scope.type === "query") return f.rule === "F1" ? "client" : "legs";
  return "client";
}
```

`packages/shared/src/query.ts` — in `collectCreateFindings`, replace the `need(q.incoterms, "Incoterms is required");` line with a field-scoped push:
```ts
  // Incoterms buckets to the Shipment tab → field-scoped (not the generic query-scoped `need`).
  {
    const v = q.incoterms;
    const missing = v === null || v === undefined || (typeof v === "string" && v.trim() === "");
    if (missing) {
      findings.push({
        rule: "F1",
        severity: "blocking",
        scope: { type: "field", id: "incoterms" },
        message: "Incoterms is required",
      });
    }
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @svyft/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/findings.ts packages/shared/src/findings.test.ts packages/shared/src/query.ts packages/shared/src/query.test.ts
git commit -m "feat(shared): findingTabKey bucketing + incoterms field-scoped finding"
```

---

## Task 2: Shared — `collectChecklistFindings(items, notes)`

**Files:**
- Modify: `packages/shared/src/query.ts`
- Modify: `packages/shared/src/query.test.ts`

**Interfaces — Produces:**
```ts
export interface ChecklistItemForValidation { key: string; checked: boolean; label: string; }
export function collectChecklistFindings(
  items: ChecklistItemForValidation[],
  notes: string | null | undefined,
): Finding[];
```
Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/query.test.ts` add (import `collectChecklistFindings`):
```ts
describe("collectChecklistFindings (Notes + all boxes mandatory, Create-enforced)", () => {
  const items = (checked: boolean) =>
    [{ key: "weight-confirmed", checked, label: "Weight confirmed" }, { key: "packing-list", checked, label: "Packing list received" }];
  it("no findings when all boxes checked + notes present", () => {
    expect(collectChecklistFindings(items(true), "ok").length).toBe(0);
  });
  it("one blocking finding per unchecked box (field/checklist scope)", () => {
    const f = collectChecklistFindings(items(false), "ok");
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ rule: "F7", severity: "blocking", scope: { type: "field", id: "checklist:weight-confirmed" } });
    expect(f[0].message).toMatch(/Weight confirmed/);
  });
  it("blocking finding for empty / whitespace notes (field/notes scope)", () => {
    expect(collectChecklistFindings(items(true), "").some((f) => f.scope.id === "notes")).toBe(true);
    expect(collectChecklistFindings(items(true), "   ").some((f) => f.scope.id === "notes")).toBe(true);
    expect(collectChecklistFindings(items(true), null).some((f) => f.scope.id === "notes")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/shared test`
Expected: FAIL (`collectChecklistFindings` undefined).

- [ ] **Step 3: Implement**

`packages/shared/src/query.ts` — after `collectCreateFindings` add:
```ts
export interface ChecklistItemForValidation {
  key: string;
  checked: boolean;
  label: string;
}

/**
 * Notes + all-checklist-boxes manual gate (Round-1 Issue 2, Notes & Checklist tab).
 * Pure/isomorphic; run in the Create-Query preview. Every provided box must be
 * checked and internalNotes must be non-empty. No DG-conditional exemption — all
 * boxes are required (the DG-conditional disable is dropped).
 */
export function collectChecklistFindings(
  items: ChecklistItemForValidation[],
  notes: string | null | undefined,
): Finding[] {
  const findings: Finding[] = [];
  for (const it of items) {
    if (!it.checked) {
      findings.push({
        rule: "F7",
        severity: "blocking",
        scope: { type: "field", id: `checklist:${it.key}` },
        message: `${it.label} must be confirmed`,
      });
    }
  }
  if (notes === null || notes === undefined || notes.trim() === "") {
    findings.push({
      rule: "F7",
      severity: "blocking",
      scope: { type: "field", id: "notes" },
      message: "Internal notes are required",
    });
  }
  return findings;
}
```
(Ensure `Finding` is imported in `query.ts` — it already imports `import type { Finding } from "./findings";`.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/query.ts packages/shared/src/query.test.ts
git commit -m "feat(shared): collectChecklistFindings (Notes + all-boxes Create gate)"
```

---

## Task 3: Web — `ValidationSummary` component

**Files:**
- Create: `apps/web/src/components/ValidationSummary.tsx`
- Create: `apps/web/src/components/ValidationSummary.test.tsx`

**Interfaces:**
- Consumes: `findingTabKey`, `FindingTab`, `dedupeFindings`, `Finding` (`@svyft/shared`).
- Produces:
```ts
interface ValidationSummaryProps {
  findings: Finding[];
  onNavigate: (tab: FindingTab) => void;
}
export function ValidationSummary(props: ValidationSummaryProps): JSX.Element | null;
```
Consumed by Task 7.

- [ ] **Step 1: Write the failing test**
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding } from "@svyft/shared";
import { ValidationSummary } from "./ValidationSummary";

const findings: Finding[] = [
  { rule: "F1", severity: "blocking", scope: { type: "query", id: "q" }, message: "Client is required" },
  { rule: "F1", severity: "blocking", scope: { type: "field", id: "incoterms" }, message: "Incoterms is required" },
  { rule: "F7", severity: "blocking", scope: { type: "field", id: "notes" }, message: "Internal notes are required" },
];

describe("ValidationSummary", () => {
  it("returns null when there are no findings", () => {
    const { container } = render(<ValidationSummary findings={[]} onNavigate={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
  it("groups findings under their tab and navigates on click", async () => {
    const onNavigate = vi.fn();
    render(<ValidationSummary findings={findings} onNavigate={onNavigate} />);
    expect(screen.getByText("Client is required")).toBeInTheDocument();
    // group headings by tab label
    expect(screen.getByText(/Client & Query/i)).toBeInTheDocument();
    expect(screen.getByText(/Shipment/i)).toBeInTheDocument();
    expect(screen.getByText(/Notes & Checklist/i)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Incoterms is required"));
    expect(onNavigate).toHaveBeenCalledWith("shipment");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/web test ValidationSummary`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**
```tsx
import { dedupeFindings, findingTabKey } from "@svyft/shared";
import type { Finding, FindingTab } from "@svyft/shared";

const TAB_ORDER: FindingTab[] = ["client", "shipment", "cargo", "legs", "notes"];
const TAB_LABEL: Record<FindingTab, string> = {
  client: "Client & Query",
  shipment: "Shipment",
  cargo: "Cargo",
  legs: "Leg & Route",
  notes: "Notes & Checklist",
};

interface ValidationSummaryProps {
  findings: Finding[];
  onNavigate: (tab: FindingTab) => void;
}

export function ValidationSummary({ findings, onNavigate }: ValidationSummaryProps) {
  const deduped = dedupeFindings(findings).filter((f) => f.severity === "blocking");
  if (deduped.length === 0) return null;

  const byTab = new Map<FindingTab, Finding[]>();
  for (const f of deduped) {
    const tab = findingTabKey(f);
    const existing = byTab.get(tab);
    if (existing) existing.push(f);
    else byTab.set(tab, [f]);
  }

  return (
    <div role="alert" className="space-y-3 rounded-md border border-destructive/30 bg-destructive/10 p-4">
      <p className="text-sm font-semibold text-destructive">
        Resolve {deduped.length} issue{deduped.length === 1 ? "" : "s"} to create this query:
      </p>
      {TAB_ORDER.filter((t) => byTab.has(t)).map((tab) => {
        const items = byTab.get(tab)!;
        return (
          <div key={tab} className="space-y-1">
            <button
              type="button"
              onClick={() => onNavigate(tab)}
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm"
            >
              {TAB_LABEL[tab]}
              <span className="rounded-full bg-destructive/20 px-1.5 py-0.5 font-mono text-[10px]">{items.length}</span>
            </button>
            <ul className="space-y-0.5 pl-1">
              {items.map((f, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onNavigate(tab)}
                    className="text-left text-sm text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-background rounded-sm"
                  >
                    {f.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/web test ValidationSummary && pnpm --filter @svyft/web typecheck`
Expected: PASS. (Requires shared built with Task 1 — run `pnpm --filter @svyft/shared build` first if `findingTabKey`/`FindingTab` aren't resolved.)

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/components/ValidationSummary.tsx apps/web/src/components/ValidationSummary.test.tsx
git commit -m "feat(web): ValidationSummary — findings grouped by tab, click-to-navigate"
```

---

## Task 4: Web — Stepper red-dot count badges

**Files:**
- Modify: `apps/web/src/components/ui/stepper.tsx`
- Modify: `apps/web/src/components/ui/stepper.test.tsx` (or create if absent)

**Interfaces — Produces:** `StepDef` gains `badgeCount?: number`. When `badgeCount > 0`, the step renders a red count badge (aria-labelled). Consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Add to the stepper test (mirror the existing render pattern; if no test file, create `stepper.test.tsx`):
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Stepper } from "./stepper";

describe("Stepper badges", () => {
  it("renders a count badge on steps with badgeCount > 0 and none for 0/undefined", () => {
    render(
      <Stepper
        steps={[
          { key: "a", label: "Alpha", badgeCount: 2 },
          { key: "b", label: "Beta", badgeCount: 0 },
          { key: "c", label: "Gamma" },
        ]}
        current="a"
        completed={new Set()}
      />,
    );
    expect(screen.getByLabelText("Alpha: 2 issues")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Beta: .* issue/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Gamma: .* issue/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/web test stepper`
Expected: FAIL (no badge rendered; `badgeCount` not on `StepDef`).

- [ ] **Step 3: Implement**

`stepper.tsx` — add `badgeCount?: number;` to `StepDef`. In the step render, after the `<span>{step.label}</span>`, add:
```tsx
              {step.badgeCount != null && step.badgeCount > 0 && (
                <span
                  aria-label={`${step.label}: ${step.badgeCount} issue${step.badgeCount === 1 ? "" : "s"}`}
                  className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive-foreground"
                >
                  {step.badgeCount}
                </span>
              )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/web test stepper && pnpm --filter @svyft/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/components/ui/stepper.tsx apps/web/src/components/ui/stepper.test.tsx
git commit -m "feat(web): Stepper per-step red-dot count badge"
```

---

## Task 5: Web — Step 5 Notes & Checklist: all 9 boxes required, drop DG-conditional disable

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step5Notes.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/Step5Notes.test.tsx`

**Change:** remove the `disabled = isDgConditional && !dgActive` logic and the "(N/A — not a DG shipment)" hint so **all 9 checklist boxes are always tickable**; add a required `*` marker to the Internal Notes label and the Checklist heading (display only — enforcement is at Create, not per-screen). Remove the now-unused `DG_CONDITIONAL_KEY` export and the `dgActive` derivation. Keep `CHECKLIST_LABELS` (still exported/used).

- [ ] **Step 1: Write/adjust the failing test**

In `Step5Notes.test.tsx`:
```tsx
it("renders all 9 checklist boxes enabled, even for a non-DG query", () => {
  // render Step5 with detail.dgIndicator = false and the 9 checklist items
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes).toHaveLength(9);
  boxes.forEach((b) => expect(b).not.toBeDisabled());
  expect(screen.queryByText(/N\/A — not a DG shipment/i)).not.toBeInTheDocument();
});
```
Remove/replace any existing test asserting the msds-received box is disabled on a non-DG query.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/web test Step5Notes`
Expected: FAIL (msds-received is disabled for non-DG; the N/A hint renders).

- [ ] **Step 3: Implement**

In `Step5Notes.tsx`:
- **Keep** `export const DG_CONDITIONAL_KEY = "msds-received";` for now — its last consumer (`QueryWizardPage`) is removed in Task 6, which then deletes this export. (An exported-but-locally-unused const is NOT a lint error.)
- Delete the `const dgActive = detail?.dgIndicator ?? false;` line (it's only used by the disable logic being removed → would become an unused-var lint error).
- In the checklist `.map`, delete `const isDgConditional = itemKey === DG_CONDITIONAL_KEY;` and `const disabled = isDgConditional && !dgActive;`; render each `Checkbox` with no `disabled` prop and no `if (disabled) return;` guard in `onCheckedChange`; delete the `{isDgConditional && !dgActive && (<span>… N/A …</span>)}` block and the `line-through`/`text-muted-foreground` disabled label classes.
- Add a required marker: Internal Notes `<label>` → `Internal Notes <span className="text-destructive">*</span>`; Checklist `<h2>` → `Checklist <span className="text-destructive">*</span>`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/web test Step5Notes && pnpm --filter @svyft/web typecheck`
Expected: PASS. (Because `DG_CONDITIONAL_KEY` stays exported this task, `QueryWizardPage`'s import still resolves → typecheck stays green. Task 6 removes both together.)

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/steps/Step5Notes.tsx apps/web/src/features/query-wizard/steps/Step5Notes.test.tsx
git commit -m "feat(web): all 9 checklist boxes always tickable + required markers (drop DG-conditional disable)"
```

---

## Task 6: Web — Create-Query gate + remove the optional-gaps dialog

**Files:**
- Modify: `apps/web/src/features/query-wizard/QueryWizardPage.tsx`
- Delete: `apps/web/src/features/query-wizard/CreateQueryDialog.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/Step5Notes.tsx` (delete `DG_CONDITIONAL_KEY` — its last consumer is removed here)
- Modify: `apps/web/src/features/query-wizard/QueryWizardPage.test.tsx`, `apps/web/src/features/query-wizard/QueryWizard.e2e.test.tsx`

**Interfaces — Consumes:** `collectChecklistFindings`, `ChecklistItemForValidation` (Task 2); `CHECKLIST_LABELS` (Step5Notes).

**Change:** `handleCreateQuery` computes the client preview as `collectCreateFindings + validateRoute("create") + collectChecklistFindings(...)`; if any blocking → `setFindings(blocking)` and abort (no server call). **Delete the entire optional-gaps prompt** (the `uncheckedOptional`/`confirmCreateDialog`/`CreateQueryDialog` flow, its state `dialogOpen`/`dialogItems`/`dialogResolveRef`, `handleDialogResult`, the `<CreateQueryDialog>` render, and the `DG_CONDITIONAL_KEY` import). On no-blocking → `createQuery.mutateAsync` (unchanged).

- [ ] **Step 1: Write/adjust the failing tests**

In `QueryWizardPage.test.tsx` (mirror existing detail-mock setup):
```tsx
it("Create Query blocks with a validation summary when the checklist is incomplete", async () => {
  // detail: a fully-valid route + fields, but checklist has an unchecked box and/or empty notes
  // click Create Query
  await user.click(screen.getByRole("button", { name: /Create Query/i }));
  expect(await screen.findByText(/Resolve .* to create this query/i)).toBeInTheDocument();
  expect(screen.getByText(/Internal notes are required|must be confirmed/i)).toBeInTheDocument();
  // server was NOT called
  // (assert the /create endpoint mock was not hit)
});
```
In `QueryWizard.e2e.test.tsx`: (a) DELETE the test "shows CreateQueryDialog when there are unchecked checklist items…" (that flow is gone); (b) update the happy-path fixtures (`checklist: []` → the 9 items all `checked: true`; `internalNotes: null` → a non-empty string) so Create still reaches `POST /create` and yields RFQ_READY.

- [ ] **Step 2: Run to verify (RED)**

Run: `pnpm --filter @svyft/web test QueryWizardPage QueryWizard.e2e`
Expected: FAIL (no checklist gate yet; the CreateQueryDialog test + happy-path assumptions no longer hold).

- [ ] **Step 3: Implement**

`QueryWizardPage.tsx`:
- Imports: drop `CreateQueryDialog` + its types + `DG_CONDITIONAL_KEY`; add `collectChecklistFindings` to the `@svyft/shared` import; keep `CHECKLIST_LABELS`.
- Delete `dialogOpen`, `dialogItems`, `dialogResolveRef`, `confirmCreateDialog`, `handleDialogResult`.
- `handleCreateQuery` preview becomes:
```ts
    const graph = toRouteGraph(detail);
    const checklistItems = detail.checklist.map((c) => ({
      key: c.itemKey,
      checked: c.checked,
      label: CHECKLIST_LABELS[c.itemKey] ?? c.itemKey,
    }));
    const preview = dedupeFindings([
      ...collectCreateFindings(toQueryForValidation(detail), detail.cargo.map(toCargoForValidation)),
      ...validateRoute(graph, "create"),
      ...collectChecklistFindings(checklistItems, detail.internalNotes),
    ]);
    const blocking = preview.filter((f) => f.severity === "blocking");
    if (blocking.length) {
      setFindings(blocking);
      return; // Create is the single gate — abort before the server call
    }
    // (delete the optional-gaps prompt block entirely)
    try {
      await createQuery.mutateAsync(id);
      await refresh();
      const code = detail?.queryCode ?? id;
      setSuccessBanner(`Query ${code} created successfully.`);
    } catch (err) {
      if (err instanceof ApiError && err.findings) setFindings(err.findings);
      else throw err;
    }
```
Update the `useCallback` deps to drop `confirmCreateDialog`/`handleSave` if now unused. Delete the `<CreateQueryDialog … />` JSX + the wrapping fragment if it becomes a single child.
- Delete `apps/web/src/features/query-wizard/CreateQueryDialog.tsx`.
- `Step5Notes.tsx`: delete the `export const DG_CONDITIONAL_KEY = "msds-received";` line (last consumer removed).

- [ ] **Step 4: Run to verify (GREEN)**

Run: `pnpm --filter @svyft/web test QueryWizardPage QueryWizard.e2e && pnpm --filter @svyft/web typecheck`
Expected: PASS. Grep to confirm no dangling `CreateQueryDialog`/`DG_CONDITIONAL_KEY` references remain.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/QueryWizardPage.tsx apps/web/src/features/query-wizard/steps/Step5Notes.tsx \
  apps/web/src/features/query-wizard/QueryWizardPage.test.tsx apps/web/src/features/query-wizard/QueryWizard.e2e.test.tsx
git rm apps/web/src/features/query-wizard/CreateQueryDialog.tsx
git commit -m "feat(web): Create Query = single gate (checklist/notes); remove optional-gaps prompt"
```

---

## Task 7: Web — WizardShell: ValidationSummary + stepper badge counts (retire FindingsPanel)

**Files:**
- Modify: `apps/web/src/features/query-wizard/WizardShell.tsx`
- Delete: `apps/web/src/components/FindingsPanel.tsx`, `apps/web/src/components/FindingsPanel.test.tsx`
- Modify: `apps/web/src/features/query-wizard/WizardShell.test.tsx` (if present) / add coverage

**Interfaces — Consumes:** `ValidationSummary` (Task 3), `findingTabKey`/`FindingTab` (Task 1), `Stepper.StepDef.badgeCount` (Task 4).

**Change:** replace the `FindingsPanel` findings block with `<ValidationSummary findings={findings} onNavigate={(tab) => { const idx = STEPS.findIndex((s) => s.key === tab); if (idx !== -1) setStep(idx); }} />`; compute per-tab badge counts from `findings` and pass them into the `Stepper` steps. `FindingsPanel` is now unused → delete it + its test.

- [ ] **Step 1: Write/adjust the failing test**

In `WizardShell.test.tsx` (render the shell with a `findings` prop containing a blocking finding for two different tabs; mirror the existing render harness):
```tsx
it("shows the ValidationSummary and stepper badges for create findings, and navigates on click", async () => {
  // render WizardShell with findings = [F1 client 'Client is required', F7 notes 'Internal notes are required']
  expect(screen.getByText(/Resolve .* to create this query/i)).toBeInTheDocument();
  // badge on the Notes tab
  expect(screen.getByLabelText(/Notes & Checklist: 1 issue/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/web test WizardShell`
Expected: FAIL (WizardShell still renders `FindingsPanel`, no badges).

- [ ] **Step 3: Implement**

`WizardShell.tsx`:
- Replace `import { FindingsPanel } from "@/components/FindingsPanel";` with `import { ValidationSummary } from "@/components/ValidationSummary";` and add `import { findingTabKey } from "@svyft/shared";` + `import type { FindingTab } from "@svyft/shared";`.
- Compute badge counts (before the return):
```ts
  const tabCounts = findings.reduce<Record<string, number>>((acc, f) => {
    if (f.severity !== "blocking") return acc;
    const t = findingTabKey(f);
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
```
- Stepper steps: `steps={STEPS.map((s) => ({ key: s.key, label: s.label, badgeCount: tabCounts[s.key] ?? 0 }))}`.
- Replace the findings `<FindingsPanel findings={findings} phase="create" />` with:
```tsx
            <ValidationSummary
              findings={findings}
              onNavigate={(tab: FindingTab) => {
                const idx = STEPS.findIndex((s) => s.key === tab);
                if (idx !== -1) setStep(idx);
              }}
            />
```
- Delete `apps/web/src/components/FindingsPanel.tsx` + `FindingsPanel.test.tsx`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @svyft/web test WizardShell && pnpm --filter @svyft/web typecheck`
Expected: PASS. Grep to confirm no remaining `FindingsPanel` import anywhere (LegEditor/LegsStep render their own findings — unaffected).

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/features/query-wizard/WizardShell.tsx apps/web/src/features/query-wizard/WizardShell.test.tsx
git rm apps/web/src/components/FindingsPanel.tsx apps/web/src/components/FindingsPanel.test.tsx
git commit -m "feat(web): WizardShell renders ValidationSummary + stepper badges (retire FindingsPanel)"
```

---

## Definition of Done

- [ ] All 7 tasks committed on `feat/plan-6b-req-issues-round1-validation-summary`.
- [ ] **`pnpm --filter @svyft/shared build && pnpm run ci` green** (shared + web + api). No api code changed → api stays 105; shared grows (bucketing + checklist gate); web net (new ValidationSummary/badges tests, minus deleted FindingsPanel/CreateQueryDialog tests).
- [ ] `pnpm --filter @svyft/web typecheck` clean.
- [ ] Opus **whole-branch review** — expect it to probe: the Create-gate end-to-end (checklist + route + field findings all bucket + display + navigate), the incoterms-scope change (no consumer relied on `query` scope), the removed optional-gaps flow (no dangling refs), and the all-9-mandatory behavior (incl. msds-received for non-DG — an intentional design choice; flag for confirmation).
- [ ] Finish via `superpowers:finishing-a-development-branch` → PR to `main`; update `docs/Stage 3 - Session Handoff.md` (increment 2 done; next = `route-canvas`).

## Self-Review notes (spec coverage — Issue 2 + Notes & Checklist)

- On-Create validation → the single gate: Task 6 (`handleCreateQuery` runs `collectCreateFindings` + `validateRoute("create")` + `collectChecklistFindings`; aborts before the server on blocking). Status stays DRAFT until clean (unchanged server `createQuery`).
- Validation summary grouped by tab + click-to-navigate → Task 3 (`ValidationSummary`) + Task 7 (wired in WizardShell → `setStep`).
- Red-dot + count badge per stepper tab → Task 4 (`Stepper.badgeCount`) + Task 7 (per-tab counts).
- Finding → tab bucket (~4 buckets; incoterms → its tab) → Task 1 (`findingTabKey` + incoterms field scope).
- No per-field red persistence, no Finding→Field table; inline business messages only; mandatory-empty shows no inline message → already delivered in increment 1 (gating removed; schema `.partial()`); this increment adds no per-field persistence.
- Notes + all 9 checklist boxes mandatory (pure manual, Create-enforced) → Task 2 (`collectChecklistFindings`) + Task 5 (all boxes tickable + required markers) + Task 6 (gate).
- Drop the DG-conditional "msds-received" disable → Task 5. Drop the "Save Draft / Send Anyway" optional-gaps prompt → Task 6 (delete `CreateQueryDialog`).
- **Deferred (documented):** server-side authoritative checklist gate (client-preview-enforced here, like F1/route); Route Canvas (increment 3); Timezone (increment 4).
