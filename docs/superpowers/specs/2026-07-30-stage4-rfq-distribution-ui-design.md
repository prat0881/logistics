# Stage 4 — RFQ Distribution (Executive Workspace) UI Redesign — Design

- **Date:** 2026-07-30
- **Status:** Approved
- **Area:** Stage 4 · RFQ Distribution — the internal Executive workspace (`apps/web`)
- **Author:** Pratik Jain (with Claude)

## 1. Summary

A **frontend-only** restyle and reorganization of the existing per-query RFQ
Distribution screen (`RfqWorkspace` — the "Executive workspace"), driven by two
supplied mockups (`rfq_distribution_redesign_v2.html` and the per-leg table
screenshot). No backend, shared-package, or database changes — every value shown
already exists in the current DTOs.

Five changes:

1. **Stepper restyle** of `StageRail` (numbered Create → RFQ → Quotes → Award),
   applied wherever the rail renders ("across stages").
2. **Query header restyle** (`QueryOverviewHeader`) — drop Modes / Origin /
   Destination (covered by the route diagram); keep Code · Incoterms · Totals ·
   status.
3. **Route diagram unchanged visually** — add one interaction: clicking a leg
   jumps to that leg's card, expands it, collapses the others.
4. **Per-leg accordion redesign** (`LegPanel` + `FfSelectionGrid`) — single-expand
   (one open at a time, first leg open by default), cleaner header/meta, and a
   **Cards ⇄ Table** forwarder selector with search, sort, sticky header, and
   client-side paging.
5. **Remove the leg name** ("Unnamed leg") from all leg headers.

Cross-cutting: **consistent styling across the whole page** — adopt the mockups'
*layout and structure* using the app's existing design tokens and UI components
(`Card`, `Badge`, `Button`, theme colors), not the mockups' raw hex palette.

## 2. Context

- Today's screen: `apps/web/src/features/rfq-workspace/` — `QueryWorkspaceHub` →
  `StageRail` + `RfqWorkspace`, which renders `QueryOverviewHeader`, a read-only
  `RouteDiagram`, a page-level "Distribute All", and one `LegPanel` per leg (each
  embedding `FfSelectionGrid` + `DistributeLegAction`).
- Role plays no part in RFQ distribution (settled convention); "executive view" =
  this shared operational screen. No role gating is added or changed.
- Data already available (no backend work):
  - Manifest incl. **net weight**: `leg.rollup.totalNetWt` (also `totalPackages`,
    `totalCbm`, `totalGrossWt`).
  - Eligible FFs arrive as full `FreightForwarderDto` (`companyName`,
    `availableCountries`, `modes`, `status` via quote state) — so Country/Modes and
    client-side search/sort/paging need no new endpoint.
  - `RouteDiagram` already emits a per-leg click via its `onEditLeg(legId)` seam.

## 3. Decisions (locked with user)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Terms & Lead on the FF list | **Not shown** — keep the R1 (item 5) removal of payment-terms/lead-time. FF columns: ✓ · Forwarder · Country · Modes · Status. |
| D2 | Cards vs Table default | **Cards by default**, manual toggle to Table (no auto-switch by count). |
| D3 | Accordion expansion | **Single-expand** — at most one leg open; **first leg open by default**. |
| D4 | Header actions | **Collapse All** + **Distribute All** (no "Expand All" — incompatible with single-expand). |
| D5 | Leg name | **Removed** everywhere (was always "Unnamed leg"). |
| D6 | Route diagram | **Kept as-is**; only add click-a-leg → jump/expand. No SVG rebuild, no node recolor, no validation "issue dots". |
| D7 | Styling | Mockup **layout** + app **design tokens/components** (cohesive with the rest of the app). |

### 3.1 Styling consistency (D7 detail)

The redesign adopts the mockups' **layout/structure only**; all visuals route
through the app's existing design system, so the page stays consistent with the
Clients / Vessels / Forwarders / Queries screens and works in **both light and dark
themes**.

- **No hardcoded hex or fonts from the mockup.** Style exclusively with the HSL theme
  tokens defined in `apps/web/src/index.css` and the existing shadcn components
  (`Card`, `Badge`, `Button`, `Input`, `Label`, `Checkbox`). The mockups' raw palette
  (navy `#1F3864`, Segoe UI, light-only) is explicitly **not** used.
- **Token mapping** (mockup value → app token):
  - navy `#1F3864` → **`--primary`** (cobalt `#0A4FA0`) — stepper done/current dots,
    primary buttons, active/selected states, leg-tag chips.
  - amber "RFQ Sent" → **`--accent`** (signal amber `#E08A17`) — reuse the existing
    status-badge variant (`accent`), don't recolor.
  - card / hairline borders → **`--card` / `--border`**.
  - muted fills / faint grey text → **`--muted` / `--muted-foreground`**.
  - fonts → the app's **`font-display` (Space Grotesk) / Inter / IBM Plex Mono**,
    never Segoe UI.
- **Light + dark both preserved** automatically — everything goes through tokens, so
  no `@media` or hardcoded colors are introduced.
- **Reuse existing patterns:** status badges via the existing `statusBadges` helpers /
  `Badge` variants; the FF **Table view header/rows match the existing masters list
  table** style (`bg-muted text-xs uppercase tracking-wide text-muted-foreground`
  header, `border-b border-border` rows, `hover:bg-muted/50`) so tables look identical
  app-wide.

## 4. Component design

### 4.1 `StageRail` → numbered stepper
Restyle the existing rail into a horizontal numbered stepper: **Create · RFQ ·
Quotes · Award**, each a circular index (or ✓ when done) with a connector line.
- State per step derived from existing props (`active: "create" | "rfq"`,
  `rfqEnabled`): steps before `active` = **done** (filled, ✓); `active` = **current**
  (ring); later steps = **upcoming/disabled** (muted).
- Preserve navigation: `Create` and `RFQ` (when `rfqEnabled`) remain `Link`s;
  `Quotes`/`Award` stay non-clickable disabled placeholders.
- One component; both the Create and RFQ screens pick up the new look.

### 4.2 `QueryOverviewHeader` → slimmed, restyled
Horizontal card: **`queryCode`** (left) · **Incoterms** · **Totals**
(`pkg · CBM · kg` + `CargoTagIcons`) · **status badge** (right).
- **Remove** the `Modes`, `Origin`, and `Destination` fields (route diagram covers
  origin/destination/mode).
- Totals math unchanged (sum of leg rollups).

### 4.3 `RouteDiagram` → add jump-to-leg (visual unchanged)
- Add an optional `onLegClick?: (legId: string) => void` prop (or reuse the existing
  leg-click seam). When the workspace supplies it, clicking a leg edge calls it.
- No other change to the diagram's rendering, colors, legend, or findings overlay.

### 4.4 `RfqWorkspace` → single-expand orchestration + header actions
- Own `openLegId: string | null`, initialized to `legs[0]?.id ?? null` (first leg
  open by default).
- Pass `open={leg.id === openLegId}` and an `onToggle` to each `LegPanel`; toggling
  a leg sets `openLegId` to that leg (opening) or `null` (closing) — opening one
  **collapses the others**.
- Wire `RouteDiagram.onLegClick(legId)` → set `openLegId = legId` and
  `scrollIntoView` the target leg card (brief highlight optional).
- **Section header** for "RFQ Distribution": leg count + **Collapse All** (sets
  `openLegId = null`) + existing **Distribute All**.

### 4.5 `LegPanel` → controlled, restyled header/meta
- Becomes **controlled**: accept `open` + `onToggle` (remove internal `useState`
  default-true), so the workspace enforces single-expand.
- Header: **`Leg N` · `origin → destination`** (origin/destination resolved from
  points) + **mode** badge + **status** badge. **Remove `leg.legName ?? "Unnamed
  leg"`.**
- Meta row: **Ready · Target delivery · Manifest** (`pkg · CBM · gross[ · net]`;
  net shown when `totalNetWt > 0`). **Drop Origin/Destination** from the meta (now in
  the header).
- Footer (deadline picker, Preview RFQ when unsent, `DistributeLegAction`) — behavior
  unchanged, restyled for consistency.

### 4.6 `FfSelectionGrid` → Cards ⇄ Table selector
Same data/selection logic (`useEligibleFfs`, `useSetFfSelection`, broaden,
frozen/locked, `RegeneratePortalLink`); new presentation layer over the `display`
list.
- **Toolbar:** `Eligible N · Selected M` (left); **search box** + **Cards|Table
  toggle** (right). View state `"cards" | "table"`, default **cards** (D2).
- **Search** (as-you-type, case-insensitive substring) over `companyName`, `modes`,
  and country. Applies to both views.
- **Cards view** (default): the existing responsive card grid, restyled — checkbox ·
  `companyName` · `country · modes` · status badge. **No terms/lead** (D1).
- **Table view:** columns **✓ · Forwarder · Country · Modes · Status**; **Forwarder
  column sortable** (asc/desc); **sticky header**; **client-side paging** — render the
  first 10, `Showing X of Y eligible` + **Load 10 more**. **No terms/lead** (D1).
- Selection toggle, frozen (checked+disabled) FFs, broaden toggle, and empty state
  behave exactly as today, in both views.
- Country rendered as code(s) (compact, matches the screenshot); modes joined.

## 5. Data & backend
None. Entirely `apps/web` presentation. No changes to `@svyft/shared`, `apps/api`,
Prisma, or any endpoint. `useEligibleFfs`/`useRfqState`/`useSetFfSelection` and the
distribute/reissue mutations are reused unchanged.

## 6. Testing (vitest + React Testing Library)
- **StageRail:** renders 4 steps; `done`/`current`/`disabled` states correct for
  `active="create"` and `active="rfq"`; Create/RFQ are links, Quotes/Award disabled.
- **QueryOverviewHeader:** shows code, incoterms, totals, status; **does not** render
  Modes / Origin / Destination labels.
- **RfqWorkspace (single-expand):** first leg open by default; opening a second leg
  collapses the first; **Collapse All** closes all; clicking a leg in the route
  diagram opens that leg (integration test with a stubbed graph).
- **LegPanel:** header shows `Leg N` + `origin → destination` + mode + status and
  **never "Unnamed leg"**; manifest shows gross and net; controlled `open`/`onToggle`.
- **FfSelectionGrid:** default **cards**; toggle switches to **table**; search filters
  the list; Forwarder sort reorders; **Load 10 more** reveals additional rows and
  updates the count; **no Terms/Lead** column or text in either view; selection
  toggle + frozen-lock still work.
- Gate: `pnpm --filter @svyft/web typecheck` + `pnpm --filter @svyft/web test` +
  `pnpm --filter @svyft/web lint` (no shared/api build needed).

## 7. Non-goals / out of scope
- The first mockup's SVG route-graph rebuild, typed-node recolor, and validation
  **issue dots** / geo-name-resolution checks.
- Payment-terms / lead-time on the FF list (explicitly excluded, D1).
- Any backend, shared, Prisma, endpoint, or RBAC/role change.
- Stage 5 (Quotes/Award) — those stepper steps remain disabled placeholders.
