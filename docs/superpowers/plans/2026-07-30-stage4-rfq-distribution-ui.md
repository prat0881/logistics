# Stage 4 RFQ Distribution UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the existing per-query RFQ Distribution screen (the Executive workspace) into a numbered-stepper + slim-header + single-expand-accordion layout with a Cards/Table forwarder selector — frontend-only, using the app's design tokens.

**Architecture:** All changes are in `apps/web/src/features/rfq-workspace/` (plus the reused `StageRail`). No backend, shared, Prisma, or endpoint changes — every value already exists in current DTOs (`leg.rollup.totalNetWt`, `FreightForwarderDto`). Single-expand state lifts into `RfqWorkspace`; the route diagram is reused unchanged (its existing `onEditLeg` callback is wired to jump-to-leg).

**Tech Stack:** React 18, TypeScript, TanStack Query, Tailwind + shadcn-style UI (`Card`/`Badge`/`Button`/`Input`/`Checkbox`), Vitest + React Testing Library, lucide-react icons.

## Global Constraints

- **Frontend-only.** Touch only `apps/web/src`. No changes to `@svyft/shared`, `apps/api`, Prisma, or any endpoint/hook signature (`useEligibleFfs`, `useRfqState`, `useSetFfSelection`, `useDistributeAll` reused as-is).
- **Styling = app tokens/components, never mockup hex.** Use theme classes (`bg-primary`, `text-primary`, `bg-card`, `border-border`, `text-muted-foreground`, `bg-muted`, `text-primary-foreground`) and existing components. No hardcoded hex, no Segoe UI. Light/dark both work automatically. Token map: mockup navy→`--primary`, mockup amber "sent"→existing `accent` badge, borders/cards→`--border`/`--card`.
- **D1:** FF list shows **no** payment terms and **no** lead time. Columns: ✓ · Forwarder · Country · Modes · Status.
- **Country = full names** via `getCountryName` (existing test asserts "India", not "IN").
- **D2:** FF view default **Cards**; manual toggle to Table (no auto-switch).
- **D3:** Single-expand accordion — at most one leg open; **first leg open by default**.
- **D4:** RFQ-distribution header has **Collapse All** + **Distribute All** (no "Expand All").
- **D5:** No leg name anywhere (was always "Unnamed leg"); leg header = leg code + `origin → destination`.
- **D6:** Route diagram unchanged visually — only pass a leg-click handler.
- **Header:** drop Modes / Origin / Destination (route diagram covers them).
- **Commands:** `pnpm --filter @svyft/web test` (vitest), `pnpm --filter @svyft/web typecheck` (tsc — separate from `vite build`, which skips types), `pnpm --filter @svyft/web lint`. No shared build needed (no shared change).

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `StageRail.tsx` | Query-stage stepper | Restyle to numbered stepper (Task 1) |
| `QueryOverviewHeader.tsx` | Query summary card | Slim (drop modes/origin/dest) + restyle (Task 2) |
| `LegPanel.tsx` | One leg card (controlled) | Controlled open, header restyle, remove leg name (Task 3) |
| `RfqWorkspace.tsx` | Screen composition | Single-expand state, Collapse All, jump-to-leg (Task 3) |
| `FfSelectionGrid.tsx` | Eligible-FF selector | Cards ⇄ Table + search/sort/paging (Task 4) |
| `*.test.tsx` (each above) | Component tests | Updated + extended per task |

---

### Task 1: `StageRail` → numbered stepper

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/StageRail.tsx`
- Test: `apps/web/src/features/rfq-workspace/StageRail.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged public API — `StageRail({ queryId, active: "create" | "rfq", rfqEnabled })` and `isRfqStageEnabled(status)`. Only the rendered markup changes.

- [ ] **Step 1: Update/extend the test**

Replace the two rendering tests in `StageRail.test.tsx` with these (keep the `isRfqStageEnabled` test as-is):

```tsx
  it("renders all four steps; links Create + RFQ when enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="rfq" rfqEnabled />
      </MemoryRouter>,
    );
    for (const label of ["Create", "RFQ", "Quotes", "Award"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: /create/i })).toHaveAttribute("href", "/queries/q1");
    expect(screen.getByRole("link", { name: /rfq/i })).toHaveAttribute("href", "/queries/q1/workspace");
    // Quotes/Award are non-navigable placeholders
    expect(screen.queryByRole("link", { name: /quotes/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /award/i })).toBeNull();
  });

  it("disables the RFQ stage (no link) when not enabled", () => {
    render(
      <MemoryRouter>
        <StageRail queryId="q1" active="create" rfqEnabled={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /rfq/i })).not.toBeInTheDocument();
    expect(screen.getByText("RFQ")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/web exec vitest run StageRail`
Expected: FAIL — the current component renders "Quotes"/"Award" but the new "renders all four steps…" assertions and structure differ from the current pill layout (e.g. `active="rfq"` currently only supports create/rfq styling; the test now checks four labels + link roles precisely).

- [ ] **Step 3: Rewrite `StageRail.tsx`**

Replace the whole file with:

```tsx
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const RANK: Record<string, number> = {
  DRAFT: 0, CREATED: 1, RFQ_READY: 2, RFQ_SENT: 3, QUOTED: 4,
  AWAITING_CLIENT_DECISION: 5, WON: 6, LOST: 6, CLOSED: 7,
};

export function isRfqStageEnabled(status: string): boolean {
  return (RANK[status] ?? 0) >= RANK.RFQ_READY;
}

type StepState = "done" | "current" | "upcoming";

interface StageRailProps {
  queryId: string;
  active: "create" | "rfq";
  rfqEnabled: boolean;
}

export function StageRail({ queryId, active, rfqEnabled }: StageRailProps) {
  const steps: Array<{ key: string; label: string; to?: string; state: StepState }> = [
    { key: "create", label: "Create", to: `/queries/${queryId}`, state: active === "create" ? "current" : "done" },
    { key: "rfq", label: "RFQ", to: rfqEnabled ? `/queries/${queryId}/workspace` : undefined, state: active === "rfq" ? "current" : "upcoming" },
    { key: "quotes", label: "Quotes", state: "upcoming" },
    { key: "award", label: "Award", state: "upcoming" },
  ];

  return (
    <nav aria-label="Query stages" className="flex items-center rounded-lg border border-border bg-card p-3 sm:p-4">
      {steps.map((step, i) => (
        <div key={step.key} className="flex flex-1 items-center last:flex-none">
          <Step index={i} label={step.label} to={step.to} state={step.state} />
          {i < steps.length - 1 && (
            <span aria-hidden className={cn("mx-2 h-0.5 flex-1 rounded", step.state === "done" ? "bg-primary" : "bg-border")} />
          )}
        </div>
      ))}
    </nav>
  );
}

function Step({ index, label, to, state }: { index: number; label: string; to?: string; state: StepState }) {
  const dot = (
    <span
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold",
        state === "done" && "border-primary bg-primary text-primary-foreground",
        state === "current" && "border-primary bg-card text-primary ring-4 ring-primary/15",
        state === "upcoming" && "border-border bg-card text-muted-foreground",
      )}
    >
      {state === "done" ? <Check className="h-3.5 w-3.5" /> : index + 1}
    </span>
  );
  const text = (
    <span className={cn("text-sm font-medium", state === "upcoming" ? "text-muted-foreground" : "text-foreground")}>
      {label}
    </span>
  );
  const body = <span className="flex items-center gap-2">{dot}{text}</span>;
  return to
    ? <Link to={to} className="rounded-md px-1 py-0.5 transition-opacity hover:opacity-80">{body}</Link>
    : <span className="px-1 py-0.5" aria-disabled="true">{body}</span>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @svyft/web exec vitest run StageRail`
Expected: PASS (all StageRail tests).

- [ ] **Step 5: Stop — the controller commits**

Do NOT run git. Report: files changed (`StageRail.tsx`, `StageRail.test.tsx`), suggested message `feat(web): restyle StageRail as a numbered stepper`, and the test result.

---

### Task 2: `QueryOverviewHeader` → slim + restyle

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx`
- Test: `apps/web/src/features/rfq-workspace/QueryOverviewHeader.test.tsx`

**Interfaces:**
- Consumes: `QueryDetail` (unchanged prop).
- Produces: unchanged public API — `QueryOverviewHeader({ query })`. Renders only Code · Incoterms · Totals · status (+ cargo icons).

- [ ] **Step 1: Update the test**

Replace the first test in `QueryOverviewHeader.test.tsx` with this (keep the DG-icon test unchanged):

```tsx
  it("shows the query code, totals and status; omits modes/origin/destination", () => {
    render(<QueryOverviewHeader query={query} />);
    expect(screen.getByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
    expect(screen.getByText(/5 pkg/i)).toBeInTheDocument();
    expect(screen.getByText(/20 CBM/i)).toBeInTheDocument();
    expect(screen.getByText(/800 kg/i)).toBeInTheDocument();
    // Modes / Origin / Destination now live in the route diagram, not the header
    expect(screen.queryByText("AIR")).toBeNull();
    expect(screen.queryByText(/Shanghai Port/)).toBeNull();
    expect(screen.queryByText(/Dubai/)).toBeNull();
    expect(screen.queryByText("Origin")).toBeNull();
    expect(screen.queryByText("Destination")).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @svyft/web exec vitest run QueryOverviewHeader`
Expected: FAIL — the current header renders "AIR", "Shanghai Port", "Dubai", "Origin", "Destination", so the new `queryByText(...).toBeNull()` assertions fail.

- [ ] **Step 3: Rewrite `QueryOverviewHeader.tsx`**

Replace the whole file with:

```tsx
import type { QueryDetail, QueryStatus } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";
import { CargoTagIcons } from "./CargoTagIcons";

const QUERY_STATUS_LABEL: Record<QueryStatus, string> = {
  DRAFT: "Draft",
  CREATED: "Created",
  RFQ_READY: "RFQ Ready",
  RFQ_SENT: "RFQ Sent",
  QUOTED: "Quoted",
  AWAITING_CLIENT_DECISION: "Awaiting Client Decision",
  WON: "Won",
  LOST: "Lost",
  CLOSED: "Closed",
};

function queryStatusVariant(s: string) {
  if (s === "DRAFT") return "pending" as const;
  if (s === "CREATED") return "secondary" as const;
  if (s === "RFQ_READY") return "default" as const;
  if (s === "RFQ_SENT") return "accent" as const;
  if (s === "QUOTED" || s === "WON") return "success" as const;
  return "outline" as const;
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
  const statusLabel = QUERY_STATUS_LABEL[query.status as QueryStatus] ?? query.status;

  return (
    <section aria-label="Query overview" className="rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          <span className="font-mono tabular-nums text-primary">{query.queryCode}</span>
        </h1>
        <dl className="flex flex-1 flex-wrap items-start gap-x-8 gap-y-4">
          <Field label="Incoterms">{query.incoterms ?? "—"}</Field>
          <Field label="Totals">
            <div className="space-y-1">
              <div>{totals.pkg} pkg · {totals.cbm} CBM · {totals.gross} kg</div>
              <CargoTagIcons cargo={query.cargo} />
            </div>
          </Field>
        </dl>
        <Badge variant={queryStatusVariant(query.status)}>{statusLabel}</Badge>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @svyft/web exec vitest run QueryOverviewHeader`
Expected: PASS (both tests).

- [ ] **Step 5: Stop — the controller commits**

Report: files changed, suggested message `feat(web): slim + restyle QueryOverviewHeader (drop modes/origin/destination)`, test result.

---

### Task 3: Single-expand accordion — `LegPanel` (controlled) + `RfqWorkspace` (orchestration)

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/LegPanel.tsx`
- Modify: `apps/web/src/features/rfq-workspace/RfqWorkspace.tsx`
- Test: `apps/web/src/features/rfq-workspace/LegPanel.test.tsx`
- Test: `apps/web/src/features/rfq-workspace/RfqWorkspace.test.tsx`

**Interfaces:**
- Consumes: `FfSelectionGrid` (unchanged), `RouteDiagram` (existing `onEditLeg?: (legId: string) => void`).
- Produces: `LegPanel` gains required props `open: boolean` and `onToggle: () => void` (no internal open state). `RfqWorkspace` owns `openLegId` and renders each leg card with `id="legcard-<leg.id>"`.

- [ ] **Step 1: Update the `LegPanel` tests**

Replace the "shows leg summary…" test and adjust the net tests in `LegPanel.test.tsx` (the `leg`/`points` fixtures and `wrap` stay). LegPanel is now controlled — pass `open` + `onToggle`:

```tsx
  it("shows leg code + route + status (no leg name); toggles via onToggle", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    const onToggle = vi.fn();
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={onToggle} />);
    expect(screen.getByText("L1")).toBeInTheDocument();
    expect(screen.getByText(/Shanghai PVG → Dubai DXB/)).toBeInTheDocument();
    expect(screen.getByText("Ready for RFQ")).toBeInTheDocument();
    expect(screen.queryByText("Main air leg")).toBeNull(); // leg name removed
    expect(await screen.findByText(/Eligible 0/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /L1/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("hides the body when open is false", () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open={false} onToggle={() => {}} />);
    expect(screen.queryByText(/Eligible 0/i)).not.toBeInTheDocument();
  });
```

And update the two net-weight tests to pass `open onToggle={() => {}}` on the `<LegPanel ... />` render calls (add those two props to each; everything else in them stays).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @svyft/web exec vitest run LegPanel`
Expected: FAIL — `LegPanel` doesn't accept `open`/`onToggle` yet (TS/type error surfaced at runtime as the header still renders "Main air leg" and manages its own state).

- [ ] **Step 3: Rewrite `LegPanel.tsx`**

Replace the whole file with:

```tsx
import { useState } from "react";
import type { QueryLegDto, QueryPointDto, QuoteDto, FreightForwarderDto, CargoDto } from "@svyft/shared";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight } from "lucide-react";
import { LegStatusBadge } from "./statusBadges";
import { FfSelectionGrid } from "./FfSelectionGrid";
import { DistributeLegAction } from "./DistributeLegAction";
import { PreviewRfqDialog } from "./PreviewRfqDialog";

interface LegPanelProps {
  queryId: string;
  leg: QueryLegDto;
  points: QueryPointDto[];
  legQuotes: QuoteDto[];
  referencedFfs: FreightForwarderDto[];
  cargo: CargoDto[];
  open: boolean;
  onToggle: () => void;
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
  return p?.name ?? ([p?.city, p?.country].filter(Boolean).join(", ") || "—");
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

export function LegPanel({ queryId, leg, points, legQuotes, referencedFfs, cargo, open, onToggle }: LegPanelProps) {
  const [deadline, setDeadline] = useState(defaultDeadlineLocal());
  const [previewOpen, setPreviewOpen] = useState(false);
  const hasSent = legQuotes.some((q) => q.status !== "SELECT");
  const route = `${pointName(points, leg.originPointId)} → ${pointName(points, leg.destinationPointId)}`;

  return (
    <Card id={`legcard-${leg.id}`} className="scroll-mt-4 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">{leg.legCode}</span>
        <span className="font-medium">{route}</span>
        {leg.mode && <Badge variant="secondary">{leg.mode}</Badge>}
        <span className="ml-auto"><LegStatusBadge status={leg.status} /></span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-border p-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Ready</dt>
              <dd>{fmtDate(leg.readyDate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Target delivery</dt>
              <dd>{fmtDate(leg.targetDelivery)}</dd>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <dt className="text-xs text-muted-foreground">Manifest</dt>
              <dd>
                {leg.rollup.totalPackages} pkg · {leg.rollup.totalCbm} CBM · {leg.rollup.totalGrossWt} kg gross
                {leg.rollup.totalNetWt > 0 && <> · {leg.rollup.totalNetWt} kg net</>}
              </dd>
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
            {!hasSent && <Button variant="outline" onClick={() => setPreviewOpen(true)}>Preview RFQ</Button>}
            <DistributeLegAction
              queryId={queryId}
              legId={leg.id}
              deadlineLocal={deadline}
              canDistribute={legQuotes.some((q) => q.status === "SELECT")}
            />
          </div>
        </div>
      )}
      <PreviewRfqDialog open={previewOpen} onOpenChange={setPreviewOpen} leg={leg} points={points} cargo={cargo} />
    </Card>
  );
}
```

- [ ] **Step 4: Run the `LegPanel` tests**

Run: `pnpm --filter @svyft/web exec vitest run LegPanel`
Expected: PASS.

- [ ] **Step 5: Update the `RfqWorkspace` test**

In `RfqWorkspace.test.tsx`, (a) fix test 1's leg assertions, and (b) add a single-expand + Collapse All test. Add a two-leg fixture helper near the top (after `baseLeg`):

```tsx
const secondLeg = {
  ...baseLeg, id: "l2", legCode: "L2", legName: "Sea leg", originPointId: "p2", destinationPointId: "p1",
};
function twoLegDetail(status: string) {
  const d = makeQueryDetail(status);
  return { ...d, legs: [baseLeg, secondLeg] };
}
```

In test 1, replace `expect(screen.getByText("Air leg")).toBeInTheDocument();` with:
```tsx
    expect(screen.getByText(/PVG → DXB/)).toBeInTheDocument();
```
and replace the two `getByRole("button", { name: /Air leg/i })` lookups with `getByRole("button", { name: /L1/ })`.

Add this test to the `describe`:
```tsx
  it("single-expands legs (first open by default) and Collapse All closes them", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.endsWith("/api/queries/q1")) return { status: 200, body: twoLegDetail("RFQ_READY") };
      if (url.includes("/rfq-state")) return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(<RfqWorkspace queryId="q1" />);
    await screen.findByText("YAL26-0001");
    // first leg (L1) open by default → its deadline field is present; L2's is not
    expect(await screen.findByLabelText(/submission deadline/i)).toBeInTheDocument();
    expect(screen.getAllByLabelText(/submission deadline/i)).toHaveLength(1);
    // open L2 → L1 collapses (still exactly one deadline field, now L2's)
    await userEvent.click(screen.getByRole("button", { name: /L2/ }));
    expect(screen.getAllByLabelText(/submission deadline/i)).toHaveLength(1);
    // Collapse All → no open leg bodies
    await userEvent.click(screen.getByRole("button", { name: /collapse all/i }));
    expect(screen.queryByLabelText(/submission deadline/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 6: Run the `RfqWorkspace` test to verify it fails**

Run: `pnpm --filter @svyft/web exec vitest run RfqWorkspace`
Expected: FAIL — no "Collapse All" button yet; legs still render all-open (two deadline fields), so the single-expand assertions fail.

- [ ] **Step 7: Rewrite `RfqWorkspace.tsx`**

Replace the whole file with:

```tsx
import { useEffect, useRef, useState } from "react";
import type { DistributeResult } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { useQueryDetail } from "@/features/query-wizard/useQueryDetail";
import { Button } from "@/components/ui/button";
import { useRfqState, useDistributeAll } from "./useRfq";
import { QueryOverviewHeader } from "./QueryOverviewHeader";
import { LegPanel } from "./LegPanel";
import { RouteDiagram } from "@/features/query-wizard/steps/legs/RouteDiagram";

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
  const [openLegId, setOpenLegId] = useState<string | null>(null);

  // Default the first leg open, once. A ref-guard so "Collapse All" (openLegId=null) sticks.
  const inited = useRef(false);
  const legs = query.data?.legs;
  useEffect(() => {
    if (!inited.current && legs && legs.length > 0) {
      setOpenLegId(legs[0].id);
      inited.current = true;
    }
  }, [legs]);

  if (query.isLoading || rfqState.isLoading) return <p className="text-sm text-muted-foreground">Loading workspace…</p>;
  if (query.isError || !query.data) return <p className="text-sm text-destructive">Failed to load the query.</p>;

  const q = query.data;
  const quotes = rfqState.data?.quotes ?? [];
  const referencedFfs = rfqState.data?.freightForwarders ?? [];
  const legCodeById = new Map(q.legs.map((l) => [l.id, l.legCode]));

  function jumpToLeg(legId: string) {
    setOpenLegId(legId);
    requestAnimationFrame(() =>
      document.getElementById(`legcard-${legId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }

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

      <section aria-label="Route overview" className="rounded-lg border border-border bg-card p-4 sm:p-6">
        <h2 className="mb-3 font-display text-sm font-semibold text-muted-foreground">Route overview</h2>
        <RouteDiagram detail={q} findings={[]} onEditLeg={jumpToLeg} />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">RFQ distribution</h2>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setOpenLegId(null)}>Collapse All</Button>
          <Button variant="secondary" onClick={runDistributeAll} disabled={distributeAll.isPending}>
            {distributeAll.isPending ? "Distributing…" : "Distribute All"}
          </Button>
        </div>
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
            open={openLegId === leg.id}
            onToggle={() => setOpenLegId((cur) => (cur === leg.id ? null : leg.id))}
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

- [ ] **Step 8: Run both tests + typecheck**

Run: `pnpm --filter @svyft/web exec vitest run LegPanel RfqWorkspace` then `pnpm --filter @svyft/web typecheck`
Expected: PASS both; typecheck clean.

- [ ] **Step 9: Stop — the controller commits**

Report: files changed (`LegPanel.tsx`, `RfqWorkspace.tsx`, both tests), suggested message `feat(web): single-expand leg accordion + Collapse All + route-diagram jump-to-leg`, test results.

---

### Task 4: `FfSelectionGrid` → Cards ⇄ Table selector

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx`
- Test: `apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx`

**Interfaces:**
- Consumes: `useEligibleFfs`, `useSetFfSelection`, `getCountryName`, `ForwarderStatusBadge`, `RegeneratePortalLink` (all unchanged).
- Produces: unchanged public API — `FfSelectionGrid({ queryId, legId, legQuotes, referencedFfs })`. New internal Cards/Table views. The counts text stays a single node (`Eligible {n}` / `Selected {n}`), the FF checkbox keeps `aria-label="Select {companyName}"`, and country is rendered via `getCountryName` (full names) — so existing tests keep passing.

- [ ] **Step 1: Add the new-behavior tests**

Append these tests inside the `describe("FfSelectionGrid", …)` block in `FfSelectionGrid.test.tsx`. Add a many-FF helper near the top (after the existing `ff` factory):

```tsx
  const manyFfs = (n: number) =>
    Array.from({ length: n }, (_, i) => ff(`ff${i}`, `Forwarder ${String(i).padStart(2, "0")}`));
```

Tests:
```tsx
  it("defaults to Cards and toggles to Table (with column headers)", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("a", "Alpha FF"), ff("b", "Beta FF")] };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    expect(await screen.findByText("Alpha FF")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /forwarder/i })).toBeNull(); // cards first
    await userEvent.click(screen.getByRole("button", { name: /^table$/i }));
    expect(screen.getByRole("columnheader", { name: /forwarder/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /country/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /modes/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /status/i })).toBeInTheDocument();
    // no Terms / Lead columns (D1)
    expect(screen.queryByRole("columnheader", { name: /terms|lead/i })).toBeNull();
  });

  it("filters by search text", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("a", "Alpha FF"), ff("b", "Beta FF")] };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    await screen.findByText("Alpha FF");
    await userEvent.type(screen.getByRole("textbox", { name: /search forwarders/i }), "beta");
    expect(screen.queryByText("Alpha FF")).toBeNull();
    expect(screen.getByText("Beta FF")).toBeInTheDocument();
  });

  it("pages the table with Load 10 more", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: manyFfs(12) };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    await screen.findByText("Forwarder 00");
    await userEvent.click(screen.getByRole("button", { name: /^table$/i }));
    // first 10 rows: 00..09 visible, 10/11 not yet
    expect(screen.getByText("Forwarder 09")).toBeInTheDocument();
    expect(screen.queryByText("Forwarder 11")).toBeNull();
    expect(screen.getByText(/showing 10 of 12/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /load 10 more/i }));
    expect(screen.getByText("Forwarder 11")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @svyft/web exec vitest run FfSelectionGrid`
Expected: FAIL — no Cards/Table toggle, search box, or table headers exist yet.

- [ ] **Step 3: Rewrite `FfSelectionGrid.tsx`**

Replace the whole file with:

```tsx
import { useEffect, useMemo, useState } from "react";
import type { FreightForwarderDto, QuoteStatus } from "@svyft/shared";
import { getCountryName } from "@svyft/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useEligibleFfs, useSetFfSelection } from "./useRfq";
import { ForwarderStatusBadge } from "./statusBadges";
import { RegeneratePortalLink } from "./RegeneratePortalLink";

const PAGE_SIZE = 10;

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

function countryText(f: FreightForwarderDto): string {
  return f.availableCountries.map(getCountryName).join(", ");
}

export function FfSelectionGrid({ queryId, legId, legQuotes, referencedFfs }: FfSelectionGridProps) {
  const [broaden, setBroaden] = useState(false);
  const [view, setView] = useState<"cards" | "table">("cards");
  const [search, setSearch] = useState("");
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);
  const { data: eligible = [], isLoading } = useEligibleFfs(queryId, legId, broaden);
  const setSelection = useSetFfSelection(queryId, legId);

  const statusByFf = useMemo(
    () => new Map(legQuotes.map((q) => [q.freightForwarderId, q.status])),
    [legQuotes],
  );
  const frozen = useMemo(
    () => new Set(legQuotes.filter((q) => q.status !== "SELECT").map((q) => q.freightForwarderId)),
    [legQuotes],
  );

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(legQuotes.filter((q) => q.status === "SELECT").map((q) => q.freightForwarderId)),
  );
  useEffect(() => {
    if (setSelection.isPending) return;
    setSelected(new Set(legQuotes.filter((q) => q.status === "SELECT").map((q) => q.freightForwarderId)));
  }, [legQuotes, setSelection.isPending]);

  const display = useMemo(() => {
    const byId = new Map<string, FreightForwarderDto>();
    for (const f of eligible) byId.set(f.id, f);
    for (const f of referencedFfs) if (statusByFf.has(f.id) && !byId.has(f.id)) byId.set(f.id, f);
    return [...byId.values()];
  }, [eligible, referencedFfs, statusByFf]);

  const selectedCount = new Set([...selected, ...frozen]).size;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? display.filter(
          (f) =>
            f.companyName.toLowerCase().includes(q) ||
            f.modes.join(" ").toLowerCase().includes(q) ||
            countryText(f).toLowerCase().includes(q),
        )
      : display;
    return [...base].sort((a, b) =>
      sortAsc ? a.companyName.localeCompare(b.companyName) : b.companyName.localeCompare(a.companyName),
    );
  }, [display, search, sortAsc]);

  useEffect(() => setPage(1), [search, broaden, view]);

  const paged = view === "table" ? filtered.slice(0, page * PAGE_SIZE) : filtered;
  const hasMore = view === "table" && filtered.length > paged.length;

  function toggle(ffId: string, next: boolean) {
    if (frozen.has(ffId)) return;
    const nextSet = new Set(selected);
    if (next) nextSet.add(ffId);
    else nextSet.delete(ffId);
    setSelected(nextSet);
    setSelection.mutate([...nextSet]);
  }

  const isChecked = (id: string) => selected.has(id) || frozen.has(id);
  const toggleBtn = (v: "cards" | "table", label: string) => (
    <button
      type="button"
      onClick={() => setView(v)}
      className={cn(
        "px-3 py-1 text-xs font-medium",
        view === v ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        <div className="flex items-center gap-3 text-muted-foreground">
          <span>Eligible {eligible.length}</span>
          <span>·</span>
          <span>Selected {selectedCount}</span>
          {broaden && (
            <Button variant="ghost" size="sm" onClick={() => setBroaden(false)}>Back to filtered</Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Search forwarders"
            placeholder="Search forwarder, mode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-56"
          />
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {toggleBtn("cards", "Cards")}
            {toggleBtn("table", "Table")}
          </div>
        </div>
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
      ) : view === "cards" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((f) => {
            const isFrozen = frozen.has(f.id);
            const status = statusByFf.get(f.id);
            return (
              <Card key={f.id} className={isFrozen ? "opacity-90" : ""}>
                <CardContent className="flex gap-3 p-4">
                  <Checkbox
                    aria-label={`Select ${f.companyName}`}
                    checked={isChecked(f.id)}
                    disabled={isFrozen}
                    onCheckedChange={(v) => toggle(f.id, v === true)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{f.companyName}</span>
                      {status && <ForwarderStatusBadge status={status} />}
                    </div>
                    <p className="text-xs text-muted-foreground">{countryText(f)} · {f.modes.join(", ")}</p>
                    {isFrozen && <RegeneratePortalLink queryId={queryId} freightForwarderId={f.id} />}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="w-10 px-3 py-2" />
                  <th scope="col" className="px-3 py-2 font-medium">
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => setSortAsc((s) => !s)}>
                      Forwarder <span aria-hidden>{sortAsc ? "↑" : "↓"}</span>
                    </button>
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">Country</th>
                  <th scope="col" className="px-3 py-2 font-medium">Modes</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((f) => {
                  const isFrozen = frozen.has(f.id);
                  const status = statusByFf.get(f.id);
                  return (
                    <tr key={f.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                      <td className="px-3 py-2">
                        <Checkbox
                          aria-label={`Select ${f.companyName}`}
                          checked={isChecked(f.id)}
                          disabled={isFrozen}
                          onCheckedChange={(v) => toggle(f.id, v === true)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{f.companyName}</span>
                        {isFrozen && (
                          <div className="mt-1"><RegeneratePortalLink queryId={queryId} freightForwarderId={f.id} /></div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{countryText(f)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{f.modes.join(", ")}</td>
                      <td className="px-3 py-2">{status ? <ForwarderStatusBadge status={status} /> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
            <span>Showing {paged.length} of {filtered.length} eligible</span>
            {hasMore && (
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => p + 1)}>Load 10 more</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass (new + existing)**

Run: `pnpm --filter @svyft/web exec vitest run FfSelectionGrid`
Expected: PASS — the three new tests AND all existing ones (counts text, frozen read-only, empty/broaden, full country names + hidden terms/lead, no-regenerate-for-SELECT).

- [ ] **Step 5: Stop — the controller commits**

Report: files changed (`FfSelectionGrid.tsx`, `FfSelectionGrid.test.tsx`), suggested message `feat(web): FF selector Cards/Table views with search, sort, and paging`, test result.

---

### Task 5: Cross-package gate + visual verification

No new code — verify the whole redesign holds together and looks consistent.

- [ ] **Step 1: Typecheck, lint, test (web)**

Run: `pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint && pnpm --filter @svyft/web test`
Expected: all PASS (typecheck covers `.test.tsx`; lint clean; full web suite green).

- [ ] **Step 2: Visual check in the browser preview**

Start the web dev server (`preview_start` with the web launch config), sign in, open a query that is RFQ-Ready with ≥2 legs at `/queries/:id/workspace`, and confirm: numbered stepper (Create done, RFQ current), slim header (no Modes/Origin/Destination), one leg open by default, clicking a leg in the route diagram expands it + collapses others, Collapse All closes all, and the FF selector defaults to Cards with a working Table toggle + search + Load-10-more. Re-check under dark mode (`resize_window` colorScheme "dark"). Capture a screenshot as evidence.

- [ ] **Step 3: Stop — report the gate results and screenshot to the controller.**

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-30-stage4-rfq-distribution-ui-design.md`):
- §4.1 Stepper → Task 1. ✅  §4.2 Header slim → Task 2. ✅  §4.3 Route diagram jump (onEditLeg) → Task 3 (RfqWorkspace). ✅  §4.4 Single-expand + Collapse All + Distribute All → Task 3. ✅  §4.5 LegPanel header/meta, no leg name → Task 3. ✅  §4.6 Cards/Table + search/sort/sticky/paging, no terms/lead → Task 4. ✅
- §3.1 Styling consistency (tokens, no hex, masters-table style for the FF table `bg-muted`/`border-b`/`hover:bg-muted/50`) → applied in Tasks 1–4; verified Task 5. ✅
- D1 (no terms/lead) → Task 4 (+ existing test still asserts hidden). D2 (cards default) → Task 4. D3/D4 (single-expand, Collapse All) → Task 3. D5 (no leg name) → Task 3. D6 (diagram unchanged) → Task 3 passes only `onEditLeg`. D7/full country names → Task 4 `getCountryName`. §6 testing → each task + Task 5. ✅
- Non-goals honored: no route-graph rebuild, no validation dots, no backend/shared/role change.

**Placeholder scan:** none — every code step contains the full file or exact edit.

**Type consistency:** `LegPanel` gains `open: boolean` + `onToggle: () => void` (Task 3), and `RfqWorkspace` passes exactly those (Task 3, same task). `FfSelectionGrid` public props unchanged (Task 4), so `LegPanel`'s `<FfSelectionGrid .../>` call is unaffected. `isRfqStageEnabled`/`StageRail` signatures unchanged (Task 1). Counts text kept as single nodes and `getCountryName`/checkbox aria-labels preserved so existing tests stay green.
