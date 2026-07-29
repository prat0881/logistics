# Stage 4 · Sub-build 4c — FF Portal Frontend — Design

> Design of record for **SB4c** (the third + final slice of SB4 — the FF Portal). The authoritative *what/how* remains the Functional Spec (§7.3–§7.4, §9.1, §10.4, §13.2) and the Technical Design (§9.5 portal decomposition, §6.3 client+server engine, §9.6 screen states, §9.7 shared client validation). This doc records the **4c slice boundary + concrete decisions + the codebase facts** a fresh session needs to plan/execute. Siblings: `Stage 4 - Sub-build 4 - Decomposition & 4a Design.md`, `… Sub-build 4b - FF Portal Backend - Design.md`.

## SB4c — scope

**Goal:** the public, no-login `/ff/rfq/:token` SPA where an invited freight forwarder reviews their scoped RFQ (read-only cargo, from the frozen manifest) and enters a quote — per-leg pricing with **live** chargeable-weight/Grand-Total recalc, Save Draft, and Submit. **Pure frontend** (like SB3) — it consumes the SB4b endpoints and runs the **same `@svyft/shared` engine client-side** (§6.3, zero drift). **No backend changes.**

**Locked decisions (from the SB4c brainstorm, 2026-07-29):**
- **Draft persistence = an explicit "Save Draft" button** (PATCH on click). Chargeable-weight + Grand-Total recalc is **instant client-side** (no server round-trip). Autosave is a later enhancement, not built now.
- **Visual direction = reuse the internal shadcn design system** (shadcn/ui + Radix + Tailwind), with `frontend-design` polishing the external-facing shell (header, hierarchy, spacing, trust cues). Clean + professional + consistent.
- **A dedicated portal fetch client** (NOT the shared `fetchJson`) — see §1 (the 401 hazard).
- **One RHF form per leg** (PATCH + submit are per-leg endpoints) + a shared RFQ-level currency/validity section.

**Out of scope / deferred (polish pass):** PDF download (§8.4), `ScopedRouteDiagram` (§7.3.4), FF read-only Preview (§7.4.7). No backend/API change (SB4b is the complete contract).

## The SB4b contract SB4c consumes (do NOT rebuild)

All under `/api/ff/rfq/:token` — public, token-in-the-path (no JWT/cookie):
- **`GET /api/ff/rfq/:token` → `FfPortalRfqDto`** (`@svyft/shared`): `{ rfqNumber, incoterms, submissionDeadline (ISO), currency (string|null — the RFQ-level, top-level), quoteValidityUntil (ISO|null, top-level), freightForwarder: { companyName }, legs: FfPortalLegDto[] }`. `FfPortalLegDto = { legId, quoteId, status (QuoteStatus), mode (FreightMode|null), manifest (ManifestSnapshot — cargo/mode/endpoints/dates), endpoints (FfPortalEndpoint[] = { pointId, type, name, country, warehousePosition }), seededCharges ({ zone, presetKey, label, isPreset, amount: null }[]), seededDensity ({ cargoItemId, freightDensity }[]), draft (QuoteDraft|null) }`.
- **`PATCH /api/ff/rfq/:token/quotes/:legId`** — body = `QuoteDraft`; draft-save, last-write-wins, no validation; upserts RFQ-level currency/validity to the Rfq. → `200`.
- **`POST /api/ff/rfq/:token/quotes/:legId/submit`** — `validateQuote` server-side (§10.4 Q1–Q8) → **`201 { quoteId, status: "QUOTED" }`** | **`422 { findings: Finding[] }`** | **`409`** (not `RFQ_SENT` — already submitted). The server re-derives immutables + scope-validates point IDs.
- **Bad/expired token → `401`.** (Deadline-past submit → `422` with a Q7 finding.)
- **Read the TOP-LEVEL `currency`/`quoteValidityUntil`** from the DTO (RFQ-level), NOT the draft blob's copies.
- **Engine (client-side):** `computeChargeableWeight(grossWtT, cbm, densityKgPerCbm)`, `computeQuoteTotals(draft) → { zoneSubtotals, truckingSubtotal, warehouseSubtotal, totalChargeableWeightT, grandTotal }`, `validateQuote(draft, deadlineIso, nowIso) → Finding[]`, `classifyWarehousePositions(...)` — all in `@svyft/shared`, browser-safe. `AIR_/SEA_CHARGE_PRESETS`, `ChargeZone`/`WarehousePosition`/`TruckingType`/`TruckingBasis`, `Finding`, `quoteDraftSchema` (Zod) also exported.

---

### 1. Route + the dedicated portal client (⚠ the 401 hazard)

- **Route:** one bare route in `apps/web/src/App.tsx` — `<Route path="/ff/rfq/:token" element={<FfPortalPage />} />` — placed OUTSIDE `<Protected>` (mirrors `/login`). No `AppLayout`, no `ProtectedRoute`, no auth. Served `noindex` (a `<meta>`/head effect on the portal page).
- **⚠ Why a dedicated client (not the shared `lib/api.ts fetchJson`):** `lib/api.ts`'s error path calls a **global `onUnauthorized`** on ANY non-`/api/auth/` 401 → `setUser(null)` + `queryClient.clear()`. If the portal used `fetchJson`, an expired/invalid token (`GET → 401`) would **log out a staff member who has the app open in another tab** + clear their cache. So SB4c adds **`features/ff-portal/portalClient.ts`**:
  - `portalGet<T>(path)`, `portalPatch<T>(path, body)`, `portalPost<T>(path, body)` — plain `fetch` with `credentials: "omit"` (the portal never needs the cookie), `Content-Type: application/json` for writes.
  - **Never calls `onUnauthorized`.** A non-2xx throws a typed **`PortalError`** carrying `status` + the parsed `body` (so `.findings` for 422, and 401/409 by `status`). The page maps `401` → the invalid-token terminal state.
- **`features/ff-portal/useFfPortal.ts`** — TanStack Query hooks (mirror SB3's `features/rfq-workspace/useRfq.ts`):
  - `useFfRfq(token)` — `useQuery({ queryKey: ["ff-rfq", token], queryFn: () => portalGet<FfPortalRfqDto>(\`/api/ff/rfq/${token}\`), retry: false })`. `retry:false` so a 401 surfaces immediately.
  - `useSaveDraft(token, legId)` — `useMutation({ mutationFn: (draft) => portalPatch(\`/api/ff/rfq/${token}/quotes/${legId}\`, draft), onSuccess: () => qc.invalidateQueries({ queryKey: ["ff-rfq", token] }) })`.
  - `useSubmit(token, legId)` — `useMutation({ mutationFn: () => portalPost(\`/api/ff/rfq/${token}/quotes/${legId}/submit\`, {}), onSuccess: → invalidate ["ff-rfq", token] })`. (Submit takes no body — the server reads the stored draft; so the page **Saves the draft, then Submits.**)

### 2. `FfPortalPage` + terminal states (§9.6)

`FfPortalPage` reads `:token` (`useParams`), calls `useFfRfq`, and branches:
- **loading** → a centered spinner/skeleton.
- **invalid / revoked token** (`PortalError.status === 401`) → a terminal card: "This RFQ link is invalid or has expired." No retry.
- **expired link** (`Date.now() > Date.parse(rfq.submissionDeadline)`) → the RFQ renders **read-only** with a prominent "The submission deadline has passed — this RFQ can no longer be submitted." banner (submit is also refused server-side via Q7; the client just disables the controls).
- **loaded** → `PortalShell` with the header + one `LegSection` per leg. Each leg renders per its own `status`: `QUOTED` → an **already-submitted** read-only summary; `RFQ_SENT` → the editable quote form; other → read-only.

### 3. `PortalShell` + RFQ-level fields (§7.3.1)

- **External header** (frontend-design's focus): `freightForwarder.companyName`, RFQ number, incoterms, **live deadline countdown** (a small `useCountdown(deadlineIso)` hook → "2d 14h 03m" in viewer-local; recomputes every 30–60s; turns urgent < T-12h). No org-timezone dependency (the portal is unauthenticated — the countdown is viewer-local off the ISO instant).
- **RFQ-level form** (shared across the FF's legs): **Currency** (a `Select`, pre-filled from the top-level `rfq.currency` ?? the FF default already resolved server-side) + **Quote Validity Until** (a date input). These two values are merged into EACH leg's `QuoteDraft` on Save Draft/Submit (the PATCH upserts them RFQ-level). Held in page-level state (not per-leg).

### 4. Per-leg `LegSection` (one RHF form per leg)

`useForm<QuoteDraft>({ resolver: zodResolver(quoteDraftSchema), defaultValues: draftFromDto(leg, rfq) })` — seed from `leg.draft` if present, else from the seeds. `form.watch()` feeds the engine for live recalc. Sub-components:
- **`CargoManifestTable`** — read-only, from `leg.manifest.cargo` (PO/product/HS/package/qty/dims/gross/CBM/DG).
- **`DensityChargeableGrid`** — one row per manifest cargo: read-only gross/CBM + a **freight-density** number input (default from `leg.seededDensity` by `cargoItemId`) → **live chargeable weight** = `computeChargeableWeight(Number(grossWt)/1000, Number(volumeCbm), density)` (tonnes). Feeds `draft.cargo[]` (`grossWtT`/`cbm`/`isDangerous` from the manifest — the server re-derives them anyway; `freightDensity` from the input).
- **Mode-driven pricing** (from `leg.mode`):
  - **Air/Sea → `ChargeZonePanel`** — the `leg.seededCharges` preset lines, grouped by zone (ORIGIN / MAIN_FREIGHT / DESTINATION); each row = read-only label + an **amount** input + an optional **note**; live **zone subtotals**. (Custom extra lines allowed per §7.4.3 — a `[+ Add line]` per zone; NOT for Road, B8.)
  - **Road → `TruckingBlocks`** — one charge per leg endpoint (`leg.endpoints`): truckingType/basis selects + **amount** + **Remarks** (B8: one charge + Remarks, **no `[+ Add Charge]`**).
  - **`WarehouseStaging`** — per warehouse-type endpoint (`leg.endpoints` where `warehousePosition != null`): the position label (ORIGIN/DESTINATION, server-derived) + **amount** + optional cargo-acceptance-window. Point IDs come straight from `leg.endpoints` (the backend scope-validates them).
- **`TransitPlanForm`** — **departure** + **arrival** (`datetime-local`, viewer-local → ISO on save) + optional carrier / flight-voyage no. / carrier surcharge / guaranteed transit days.
- **Live `QuoteSummary`** — `computeQuoteTotals(draft)` → zone subtotals + trucking/warehouse subtotals + total chargeable weight + **Grand Total** (§7.4.6), updating on every change.

### 5. `SubmissionBar` + save/submit flow (§7.4.7, §9.7)

- **DG surcharge note** (shown/required when any manifest cargo `isDangerous`) + **T&C** checkbox + **Save Draft** + **Submit**.
- **Save Draft:** build the `QuoteDraft` (RHF values + RFQ-level currency/validity + manifest-derived cargo) → `useSaveDraft.mutate(draft)` → a "Saved ✓" indicator. No validation.
- **Submit:** build the draft → **run `validateQuote(draft, rfq.submissionDeadline, new Date().toISOString())` client-side** → if `findings.length`, render them (a `ValidationSummary`-style blocking list, `onNavigate` scrolls to the section; + inline field markers keyed by `finding.scope`) and DO NOT call the API; else **Save the draft, then `useSubmit.mutate()`** → `201` (the leg flips to submitted/read-only via the query invalidation) | `422` (server findings — surface them; a mismatch with the client is a bug to log) | `409` (already submitted → refetch, show the already-submitted state). Findings appear on the first Submit attempt, then update live.

### 6. Testing (Vitest + RTL — mirror SB3)

Use `apps/web/src/test/mock-fetch.ts` (`mockFetch`) + `renderWithProviders` (wraps QueryClientProvider + MemoryRouter). Real `@svyft/shared` imports (no mock — pure). Cover:
- `portalClient` — 401 → `PortalError(401)` WITHOUT logging out (no `onUnauthorized`), 422 → `.findings`, 409 → `.status`.
- `useFfPortal` hooks (mockFetch).
- `DensityChargeableGrid` — density input → live chargeable weight.
- `ChargeZonePanel` (amount+note, zone subtotal) / `TruckingBlocks` (B8: no add-line) / `WarehouseStaging`.
- `SubmissionBar` submit — valid draft → `useSubmit` called → 201; invalid → findings shown, `useSubmit` NOT called.
- `FfPortalPage` terminal states — loading / invalid-token (401) / expired (deadline past) / already-submitted (leg QUOTED) / editable.
- The RFQ-level currency/validity merge into the submitted draft.

### 7. Feature-folder structure + web conventions (inherit SB3)

`apps/web/src/features/ff-portal/`: `FfPortalPage.tsx` · `PortalShell.tsx` · `LegSection.tsx` · `CargoManifestTable.tsx` · `DensityChargeableGrid.tsx` · `ChargeZonePanel.tsx` · `TruckingBlocks.tsx` · `WarehouseStaging.tsx` · `TransitPlanForm.tsx` · `SubmissionBar.tsx` · `terminalStates.tsx` (invalid/expired/submitted cards) · `portalClient.ts` · `useFfPortal.ts` · `useCountdown.ts` · `draftFromDto.ts` (+ `.test.tsx` per file). **Conventions:** TanStack Query (query key `["ff-rfq", token]`); RHF + `zodResolver(quoteDraftSchema)`; shadcn `ui/` primitives (Card/Input/Label/Select/Button/Table/Checkbox/Textarea/Form/Badge); **reuse `ValidationSummary`** (`components/ValidationSummary.tsx`, `{ findings, onNavigate }`) for the findings list; Decimal values are strings in the DTO → `Number(...)` at the boundary for the engine, format for display; Vitest + RTL with `mockFetch`/`renderWithProviders`. **Build `@svyft/shared` before web tests** if shared changed (none expected — 4c is web-only). Web is served same-origin (`/api` proxied in dev) — no API base env var.

### 8. Concrete decisions (locked for the plan)

- **Portal client is dedicated** (`credentials: "omit"`, no `onUnauthorized`, typed `PortalError`); 401 = invalid-token terminal state.
- **One RHF form per leg** + a page-level RFQ-level currency/validity section merged into each draft on save/submit.
- **Save Draft = explicit button**; recalc is client-side + instant; submit = client `validateQuote` gate → `portalPost`.
- **Countdown is viewer-local** off the ISO deadline (no org-timezone; the portal is unauthenticated). Transit dates are viewer-local `datetime-local` → ISO.
- **Reuse** `ValidationSummary`, shadcn primitives, `mockFetch`/`renderWithProviders`; **do not** reuse `fetchJson` (the 401 hazard) or `useOrgTimezone` (auth-only).
- **Deferred:** PDF, `ScopedRouteDiagram`, FF Preview.

## Build workflow

`superpowers:brainstorming` (this doc — DONE) → **`superpowers:frontend-design`** (the external portal shell + visual polish on the shadcn base) + `superpowers:writing-plans` (this doc + TD §9.5/§6.3/§9.6 + spec §7.3–§7.4/§13.2 are the inputs) → `superpowers:subagent-driven-development` (fresh implementer per task, TDD, per-task review, **opus** whole-branch review) → PR `feat/stage-4-sb4c` → `main`. Worktree already set up at `.claude/worktrees/feat+stage-4-sb4c` (off `main`@`71feea7`); run the fresh-worktree setup (**`pnpm -C <worktree> install`**; copy `apps/api/.env`; `pnpm exec prisma generate`; `pnpm --filter @svyft/shared build`) before implementation. ⚠ SB4b gotcha: use `pnpm -C <worktree>`; a background bash task won't inherit the worktree cwd.
