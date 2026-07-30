# Stage 4 · Post-Testing Fixes — Round 1 — Design

> Design of record for the first round of testing-team fixes after SB4 shipped (SB4a/4b/4c all merged; PR #36 on `main`@`ac26611`). Six items reported by the testing/business team. **All are `apps/web` UI changes + `@svyft/shared` helpers — no DB migration, no new backend endpoint** (the re-issue endpoint already exists). Branch `fix/stage-4-testing-r1` → PR → `main`. TDD throughout; `tsc` run per task; requirement docs updated for alignment.

## Context

The testing team drove the full RFQ→quote loop and filed 6 issues/requirements. Two (the portal-link copy + the read-only route canvas) are also small features; the rest are display fixes. They span the internal Query Workspace (`features/rfq-workspace/`), the Create-Query cargo model, and the FF portal is largely untouched.

Root-cause note carried from the session: the "Copy portal link" button in `DistributeLegAction` is a **silent no-op on HTTP** because `navigator.clipboard` only exists in a secure context (HTTPS/localhost); prod is HTTP until the SB5 go-live gate. And the raw token is surfaced **only once** (on a fresh mint) — there is no UI to recover it.

## Global constraints

- `apps/web` + `@svyft/shared` only. **No Prisma migration, no new API endpoint.** The `paymentTerms`/`typicalLeadTime` DB columns and the FF-master editor are **kept** — only the FF *selection card* hides them.
- Reuse existing components/patterns and shadcn primitives. Icons from **`lucide-react`** (already a dep).
- TDD (Vitest + RTL): failing test first, minimal impl, green. Run `pnpm --filter @svyft/web test` per task AND `pnpm --filter @svyft/web typecheck` per task (vitest uses esbuild and does NOT type-check — last round's lesson).
- Accessibility: any icon-only affordance carries a `title`/tooltip **and** an `aria-label`; associate form labels via `htmlFor`+`id`.
- Copy/format helpers live in `@svyft/shared` (pure) or `apps/web/src/lib` (browser) so they're unit-testable in isolation.

## Shared building blocks (build once, reuse)

1. **`apps/web/src/lib/clipboard.ts` — `copyToClipboard(text: string): Promise<boolean>`**
   - Try `navigator.clipboard?.writeText(text)` (secure context). On absence/failure, fall back to a hidden `<textarea>` + `document.execCommand("copy")` (works over HTTP). Returns `true` on success, `false` otherwise. Never throws.

2. **`apps/web/src/features/rfq-workspace/PortalLinkRow.tsx` — `PortalLinkRow({ url }: { url: string })`**
   - A read-only, click-to-select `Input` (or `<code>`) showing the full `url`, plus a **Copy** `Button` that calls `copyToClipboard(url)` and shows transient feedback: **"Copied ✓"** on success, **"Couldn't copy — select the link above"** on failure. The link is always visible/selectable so it's recoverable even when copy fails. Reused by items 1a and 1b.

3. **`packages/shared/src/reference.ts` — `getCountryName(code: string): string`**
   - Look up `COUNTRIES` (`{ code, name }[]`) → full name; fall back to the raw `code` if unknown. (Build a `Map` once at module load for O(1).)

4. **`apps/web/src/features/rfq-workspace/useRfq.ts` — `useReissueToken(queryId: string)`**
   - `useMutation({ mutationFn: (freightForwarderId: string) => postJson<ReissueTokenResult>(\`/api/queries/${queryId}/rfqs/reissue-token\`, { freightForwarderId }) })`. `ReissueTokenResult` (from `@svyft/shared`) = `{ rfqId, rfqNumber, freightForwarderId, accessToken }`. No cache invalidation needed (token change isn't reflected in rfq-state).

5. **`apps/web/src/features/rfq-workspace/CargoTagIcons.tsx` — `CargoTagIcons({ cargo }: { cargo: CargoDto[] })`**
   - Consolidate across all cargo: `heavy = cargo.some(c => c.referenceTags.includes("HEAVY"))`, same for `FRAGILE`/`NON_STACKABLE`, and `dg = cargo.some(c => c.isDangerous)`. Render each **true** characteristic **once** as a small `lucide-react` icon in a compact chip with a `title` + `aria-label`. Returns `null` if none apply. Suggested icons (implementer picks the clearest available, tooltip carries the exact label): Heavy → `Weight`; Fragile → `Wine`; Non-stackable → `Layers` (or `PackageX`); **DG → `TriangleAlert`, tinted `text-warning`/`text-destructive`**. Icon-led per the request, but the meaning MUST live in the accessible label, not the glyph alone.

---

## Item 1 — Portal link: fix copy + add regenerate

**Files:** `apps/web/src/features/rfq-workspace/DistributeLegAction.tsx` · `FfSelectionGrid.tsx` · `useRfq.ts` · new `PortalLinkRow.tsx` · new `lib/clipboard.ts`. (+ tests)

**1a — fix the copy (fresh-mint case).** In `DistributeLegAction` (`:99-111`), the per-RFQ result currently renders a "Copy portal link" `Button` that calls `navigator.clipboard?.writeText(\`${window.location.origin}/ff/rfq/${r.accessToken}\`)` — dead on HTTP. Replace it, when `r.accessToken` is present, with `<PortalLinkRow url={\`${window.location.origin}/ff/rfq/${r.accessToken}\`} />` (selectable link + robust copy + feedback).

**1b — regenerate (recover a missed link).** The raw token is shown once; add a durable path in the **FF selection card** (`FfSelectionGrid.tsx`) — for each forwarder whose quote for this leg is **already distributed** (`RFQ_SENT`+, the frozen/read-only state the grid already tracks), render a **"Regenerate portal link"** `Button`. On click → `useReissueToken(queryId).mutate(ffId)`; on success show `<PortalLinkRow url={\`${origin}/ff/rfq/${result.accessToken}\`} />` inline with a caption **"This invalidates the previous link."** Uses the `freightForwarderId` the card already has + the `queryId`. No backend change (endpoint is `POST /api/queries/:id/rfqs/reissue-token`, Executive+).

**Tests:** `copyToClipboard` — clipboard present → uses it; clipboard absent → execCommand fallback path; both return the right boolean. `PortalLinkRow` — renders the URL, Copy → "Copied ✓" (mock success) / failure caption (mock false). `DistributeLegAction` — a minted RFQ renders the link row with the correct `/ff/rfq/<token>` URL. `FfSelectionGrid` — a distributed FF shows "Regenerate portal link"; clicking posts to reissue-token and renders the returned link; a not-yet-distributed FF shows no regenerate button. `useReissueToken` — posts to the right path with `{ freightForwarderId }`.

## Item 2 — Read-only route canvas in the workspace (before distribution)

**Files:** `apps/web/src/features/rfq-workspace/RfqWorkspace.tsx` (+ test). No change to `RouteDiagram`.

Render the existing Stage-3 `RouteDiagram` (`features/query-wizard/steps/legs/RouteDiagram.tsx`) **read-only** — it already drops interactivity (`route-focusable`, click/keyboard) when `onEditPoint`/`onEditLeg` are omitted, and its hover tooltips are built in. Placement: in `RfqWorkspace`, **after `<QueryOverviewHeader/>`** and before the "RFQ distribution" heading, wrapped in a small labelled section ("Route overview"). Gate on **pre-distribution** status only: render when `query.status` is one of `DRAFT | CREATED | RFQ_READY` (i.e. not `RFQ_SENT` or later). Data: pass `detail={query}` (already fetched via `useQueryDetail`) and `findings={[]}` (pure overview — no validation overlay). No extra fetch.

**Tests (`RfqWorkspace`):** with a pre-distribution query (e.g. `RFQ_READY`), the route overview renders (assert a stable element from `RouteDiagram`, e.g. a leg code / the figure); with a distributed query (`RFQ_SENT`), it does NOT render; read-only — no edit affordance. (Use the existing workspace test harness + `mockFetch` for `GET /api/queries/:id`.)

## Item 3 — Consolidated cargo characteristic icons under Totals

**Files:** `apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx` · new `CargoTagIcons.tsx` (+ tests).

`QueryOverviewHeader` already shows a query-level **Totals** field (`:78-80`, "X pkg · Y CBM · Z kg" from `query.legs[].rollup`). Add `<CargoTagIcons cargo={query.cargo} />` in/adjacent to that Totals field — a single consolidated row of deduped characteristic icons (Heavy / Fragile / Non-stackable / DG) computed across all query cargo. Hidden when none apply. (`query.cargo: CargoDto[]` is already on the `QueryDetail` the header receives.)

**Tests (`CargoTagIcons` + header):** cargo with mixed tags across rows → each distinct characteristic appears exactly once (assert by `aria-label`/`title`, e.g. only one "Dangerous goods" even with two DG rows); cargo with no tags and none dangerous → renders nothing; a DG row → the DG icon present. Header test: the icons appear near Totals for a query whose cargo has tags.

## Item 4 — Hide net weight under legs when 0

**Files:** `apps/web/src/features/rfq-workspace/LegPanel.tsx` (+ test).

`LegPanel` (`:82-83`) renders the per-leg "Manifest totals": `… {totalGrossWt} kg gross · {totalNetWt} kg net`. `leg.rollup.totalNetWt` is a `number`. Render the `· {totalNetWt} kg net` segment **only when `leg.rollup.totalNetWt > 0`**; otherwise omit that segment entirely (keep packages/CBM/gross). Scope: the per-leg "under legs" display only (not the Step-3 cargo table).

**Tests (`LegPanel`):** a leg with `totalNetWt > 0` shows "… kg net"; a leg with `totalNetWt === 0` (and null-safety) does NOT render "kg net" while still showing gross/pkg/CBM.

## Item 5 — Remove payment terms + lead time from the FF card

**Files:** `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx` (+ test).

Remove the paragraph at `:121-123` (`{f.paymentTerms ?? "—"} · Lead {f.typicalLeadTime ?? "—"}`) from the FF selection card. **Keep** the `paymentTerms`/`typicalLeadTime` fields in the DB, DTO, and the FF-master editor — this is card-display-only.

**Tests (`FfSelectionGrid`):** the card no longer renders payment terms / lead-time text (assert absence); other card content (company, modes, countries) still renders.

## Item 6 — Full country name in the FF card

**Files:** `packages/shared/src/reference.ts` (`getCountryName`) · `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx` (+ tests).

`FfSelectionGrid` (`:119`) renders `{f.availableCountries.join(", ")}` (raw codes). Change to `{f.availableCountries.map(getCountryName).join(", ")}` → full names ("IN" → "India"), falling back to the code for unknowns.

**Tests:** `getCountryName("IN")` → "India"; unknown code → the code unchanged. `FfSelectionGrid` — a card with `availableCountries: ["IN","AE"]` shows "India, United Arab Emirates" (per the reference list), not the codes.

---

## Requirement docs to update (alignment)

Targeted change-notes (not rewrites), as plan tasks:
- **`docs/Stage 4 - RFQ Send to Freight Forwarder (v2) - Functional Spec.md`** — FF selection card fields (remove payment terms/lead time; show full country) in the §7.2.x selection-grid description; the query header **Totals** now carries consolidated cargo characteristic icons (Heavy/Fragile/Non-stackable/DG) — §7.1; the per-leg net-weight display rule (hide when 0); a **read-only route overview** in the workspace before distribution (§7.2 / note it complements the deferred FF-scoped §7.3.4 diagram); portal-link **copy fix + regenerate** in the distribute/portal-link section (§13).
- **`docs/Stage 4 - Technical Design.md`** — note the new web helpers (`copyToClipboard`, `PortalLinkRow`, `getCountryName`, `CargoTagIcons`, `useReissueToken`) and that the portal-link copy must not assume a secure context (HTTP-until-SB5).
- **`docs/Stage 4 - Session Handoff.md`** — add a "Post-testing fixes — Round 1" entry under Known issues / carried notes with the 6 items + this design/plan path.

## Out of scope

No DB migration; no new API endpoint (re-issue exists); no change to the FF portal quoting screens; no change to the FF-master editor. Persisting the raw token to re-show it (vs regenerating) is explicitly rejected — it defeats the hash-only security design.

## Build workflow

`superpowers:writing-plans` (this doc + the file:line facts above are the inputs) → `superpowers:subagent-driven-development` (fresh implementer per task, TDD, per-task review, **opus** whole-branch review) → PR `fix/stage-4-testing-r1` → `main`.
