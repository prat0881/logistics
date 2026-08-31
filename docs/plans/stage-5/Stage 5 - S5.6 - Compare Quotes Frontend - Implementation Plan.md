# Stage 5 · S5.6 — Compare Quotes Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Steps use checkbox tracking. Design of record: `docs/Stage 5 - Compare Quotes - Design.md` **§12 (frontend)** + §11 (endpoints) + §4/§13 (RBAC/four-eyes). The **approved interactive mockup is the visual spec** (claude.ai artifact `10b4cbc3-c713-4773-b8c5-00ea8289cec4`). Frontend-seam research (exact component props, hook patterns, DTOs): `scratchpad/s5.6-frontend-research.md`. Backend S5.1–S5.5 all merged on this branch (PR #52).

**Goal:** The internal **Compare Quotes** screen at `/queries/:id/compare` — an Executive compares per-`(FF × variant)` offers leg-by-leg, shortlists + negotiates + sends for approval; a Manager+ checker approves/rejects and generates the client quote — all against the existing Stage-4 executive look and the approved mockup.

**Architecture:** One feature folder `apps/web/src/features/compare/` (page + hooks + components), reusing the Stage-4 `rfq-workspace` shell (`QueryOverviewHeader`, `RouteDiagram`, the controlled single-open leg accordion, `StageRail`, `statusBadges`). Server state via TanStack Query v5 hooks over `lib/api.ts`; forms via RHF + Zod schemas from `@svyft/shared`. **One backend task first** (Task 1): the comparison read model must expose the award decision + timeline + itemised charges, which it does not today.

**Tech stack:** React 18 + Vite + TanStack Query v5 + RHF + Zod + shadcn/Radix + Tailwind (`apps/web`); NestJS + Prisma (`apps/api`, Task 1 only); pure-TS + Zod (`packages/shared`). Tests: vitest + @testing-library (web), jest e2e (api).

## Global Constraints
- **RBAC (§4/§13):** the whole page is Executive+ (authenticated). The **maker** controls (shortlist / override-reason / negotiate / send-for-approval) are Executive+. The **checker** controls (approve / reject + the Generate gate) render **only for Manager+** — a conditional MOUNT `canCheck = user.role === "ADMINISTRATOR" || user.role === "MANAGER"` (mirror `FxRatesPage`'s `canWrite`; there is **no** `roleAtLeast` helper). **Generate = Manager+ only, NO four-eyes** (design §16 O4). approve/reject controls are **four-eyes-disabled** when `decision.sentByUserId === user.id` (server also enforces `403 SELF_APPROVAL`).
- **Read model is the source of truth:** the page renders the maker-checker state (which offer is shortlisted, decision status, override/rejection reasons, timeline) from `GET …/comparison` (extended in Task 1). Never infer it client-side.
- **Errors:** the repo has **no toast system** — surface `ApiError` inline (`<p role="alert" className="text-sm text-destructive">{err.message}</p>` + the mutation's `isError`), the house convention (see `RfqWorkspace`).
- **After a mutation**, invalidate `["comparison", queryId]` (+ `["query", queryId]` where the query status changes). Explicit actions, re-GET on success — no optimistic writes.
- **Reuse, don't reinvent:** import the Stage-4 components listed in the research; only extend where §12 requires (the `RouteDiagram` selected-leg channel, the `StageRail` "quotes" step). Match the existing shadcn tokens/`Badge` variants — do NOT introduce a new visual language.
- **Rebuild `@svyft/shared`** after Task 1 edits it; `pnpm run typecheck` per task. Full `pnpm run ci` on the last task.

## ⚠ Scope note (flag): the read model needs a backend extension
Design §15 marks S5.6 "Migration? no" and implies pure-frontend, but the research found `GET …/comparison` returns **no** `LegAwardDecision`, **no** decision timeline, and **no** per-quote itemised charges — all of which §11/§12 and the maker/checker UI require. Task 1 adds them (shared DTOs + a `ComparisonService` join). **No DB migration** (the tables exist and are populated), but it is real backend + shared code, not pure frontend.

---

## Task 1 — Backend: extend the comparison read model with decision + timeline + itemised charges

**Files:**
- `packages/shared/src/award.ts` — add `AwardDecisionDto`, `AwardDecisionEventDto`, `OfferChargeLineDto`; extend `LegComparisonDto`. Re-export (already via `index.ts`).
- `apps/api/src/modules/comparison/comparison.service.ts` — join the decision + events + per-offer charge lines into each `LegComparisonDto`.
- Test: extend `apps/api/test/comparison.e2e-spec.ts`.

**Produces (shared DTOs, string dates — mirror `FxRateDto`):**
```ts
export interface AwardDecisionDto {
  legId: string; status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  shortlistedQuoteId: string | null; shortlistedVariant: ChargeRateVariant | null;
  recommendedQuoteId: string | null; recommendedVariant: ChargeRateVariant | null;
  overrideReason: string | null; rejectionReason: string | null;
  sentByUserId: string | null; sentForApprovalAt: string | null;
  decidedByUserId: string | null; decidedAt: string | null;
}
export interface AwardDecisionEventDto {
  id: string; legId: string; type: string; quoteId: string | null;
  variant: ChargeRateVariant | null; reason: string | null; actorId: string | null; at: string;
}
// Itemised breakdown per offer (for the click-FF-to-expand detail, §11/§12). One row per charge line
// derived from the quote's draftJson (origin/destination/additional/freight), USD-normalised.
export interface OfferChargeLineDto { label: string; group: string; nativeAmount: number; usdAmount: number | null; }
```
Extend `LegComparisonDto` with: `decision: AwardDecisionDto | null;` and `timeline: AwardDecisionEventDto[];`. Add `charges: OfferChargeLineDto[];` to `OfferDto` (itemised, from the same `computeQuoteTotals`/`draftJson` the totals already use).

**Service logic:** in `getComparison`, additionally load `legAwardDecision.findMany({ where:{ queryId } })` (map by legId) + `awardDecisionEvent.findMany({ where:{ queryId }, orderBy:{ at:"asc" } })` (group by legId), and map each to its DTO (Dates→ISO). For each offer, derive `charges` from its `draftJson` (reuse `computeQuoteTotals`'s line grouping + `toUsd`). Wire onto each `LegComparisonDto`/`OfferDto`. **No new endpoint, no migration.**

**Steps (TDD):** (1) failing `comparison.e2e` assertions: a leg with a shortlisted+sent decision → `legs[].decision.status === "PENDING_APPROVAL"`, `shortlistedQuoteId` set, `sentByUserId` set; an `AwardDecisionEvent` (e.g. a SHORTLIST) → appears in `legs[].timeline`; an offer → `offers[].charges` non-empty with USD amounts. (2) RED. (3) implement. (4) GREEN + `pnpm --filter @svyft/shared build` + `pnpm run typecheck` + api lint. (5) commit `feat(stage5): comparison read model exposes decision + timeline + itemised charges (S5.6)`.

---

## Task 2 — Frontend scaffold: route, StageRail wiring, `useComparison`, page shell

**Files:**
- Create `apps/web/src/features/compare/CompareQuotesPage.tsx`, `apps/web/src/features/compare/useComparison.ts`, `apps/web/src/features/compare/CompareLegPanel.tsx` (the accordion card shell).
- Modify `apps/web/src/App.tsx` (add the route), `apps/web/src/features/rfq-workspace/StageRail.tsx` (wire the "quotes" step), `apps/web/src/features/query-wizard/steps/legs/RouteDiagram.tsx` (add the `selectedLegId` channel).
- Tests: `CompareQuotesPage.test.tsx`.

**Produces:** the route `/queries/:id/compare` renders the Stage-4-style shell: `<StageRail active="quotes" .../>` + `<QueryOverviewHeader query/>` + `<RouteDiagram detail findings={[]} selectedLegId onSelectLeg onEditLeg/>` + the per-leg `CompareLegPanel` single-open accordion (reuse the `openLegId` state + `legcard-${id}` scroll-jump). Clicking a leg in the diagram opens+scrolls its panel (`onSelectLeg`).

**Logic:**
- `useComparison(queryId)` — `useQuery({ queryKey:["comparison", queryId], queryFn:()=>fetchJson<ComparisonDto>(`/api/queries/${queryId}/comparison`), enabled:!!queryId })`. Also `useQueryDetail(id)` (existing) for the header/route diagram.
- **`RouteDiagram`**: add optional `selectedLegId?: string` + `onSelectLeg?(legId: string)`. Thread `selectedLegId` into the `Edge` stroke/width precedence (a highlighted "selected" tier above the finding tiers); call `onSelectLeg` on edge click (keep `onEditLeg` working). Backwards-compatible (both optional).
- **`StageRail`**: widen `active` to `"create" | "rfq" | "quotes"`; add `RANK.QUOTING_CLIENT = 4`; add `export function isQuotesStageEnabled(status: string): boolean { return (RANK[status] ?? 0) >= RANK.RFQ_SENT; }`; make the `quotes` step a `Link` to `/queries/:id/compare` when enabled.
- `CompareLegPanel` — the controlled `Card id="legcard-${leg.id}" scroll-mt-4` accordion (header: legCode chip + route + mode + `LegStatusBadge` + a decision-status chip; body: a slot the later tasks fill with the grid + maker/checker panels). Props `{ leg: LegComparisonDto, open, onToggle, ... }`.
- `CompareQuotesPage`: `openLegId` state + `jumpToLeg` (copy the rfq-workspace seam). Loading/empty/error states inline.

**Steps (TDD):** (1) failing `CompareQuotesPage.test.tsx` (renders the header + a leg card from a mocked `ComparisonDto`; clicking a leg opens its panel). (2) RED. (3) implement. (4) GREEN + web lint + typecheck. (5) commit `feat(stage5): compare-quotes route + shell + StageRail wiring (S5.6)`.

---

## Task 3 — The read-only comparison grid + recommendation banner

**Files:** `apps/web/src/features/compare/ComparisonGrid.tsx`, `RecommendationBanner.tsx`, `OfferDetail.tsx` (the expand); test `ComparisonGrid.test.tsx`. Fill the `CompareLegPanel` body.

**Produces:** per leg, a **read-only** grid with one column per `(FF × variant)` offer (Road: Dedicated+Groupage side by side; Sea: FCL+LCL; common charges repeated per column — reuse the `ChargeMatrix` mental model, `variantsForMode`/`rateVariantLabel`; NO RHF), showing per-offer `usdTotal` (+ native), `transitDays`, `validUntil`, and a `ForwarderStatusBadge`. Un-priced/`REQUOTED`(stale)/pending cells greyed (a `NotApplicableCell`-style display cell). A **recommendation banner** (from `leg.recommendation`) highlighting the recommended offer. **Pending / awaiting-re-quote** forwarders listed (`leg.pendingForwarders`, `leg.awaitingReQuote`). Clicking an FF column header/cell expands `OfferDetail` — the itemised `offers[].charges` breakdown (Task 1).

**Steps (TDD):** (1) failing `ComparisonGrid.test.tsx` (renders a column per offer with its USD total + transit; the recommended offer is visually flagged; a REQUOTED offer shows its stale badge; clicking an FF reveals its charge lines). (2) RED. (3) implement. (4) GREEN + lint + typecheck. (5) commit `feat(stage5): read-only comparison grid + recommendation banner (S5.6)`.

---

## Task 4 — Maker controls: shortlist + override-reason + send-for-approval + negotiate

**Files:** `apps/web/src/features/compare/MakerPanel.tsx`, mutation hooks in `useComparison.ts` (or a `useAwardActions.ts`), a `RadioGroup` primitive `apps/web/src/components/ui/radio-group.tsx` (add `@radix-ui/react-radio-group` OR hand-roll), a `NegotiateDialog.tsx`; test `MakerPanel.test.tsx`.

**Produces (Executive+):** in each leg panel — **shortlist radios** (one per priced offer; default-selected = `decision.shortlistedQuoteId` or the recommendation), an **override-reason** textarea shown/required when the shortlist ≠ recommendation, a **Send for approval** button (disabled once `decision.status === "PENDING_APPROVAL"`, re-enabled on reject; if `awaitingReQuote`, the A9 "proceed without waiting" + reason confirm), and a per-FF **Negotiate** button opening `NegotiateDialog` (comment → `request-requote`).

**Hooks (mutations, each invalidating `["comparison", queryId]`):** `useShortlist(queryId, legId)` (`putJson(...shortlist, ShortlistInput)`), `useSendForApproval(queryId, legId)`, `useRequestRequote(queryId, legId, quoteId)`. Forms via RHF + `zodResolver(shortlistSchema | sendForApprovalSchema | requestRequoteSchema)`. Inline `ApiError` surfacing.

**Steps (TDD):** (1) failing `MakerPanel.test.tsx` (selecting a non-recommended offer reveals the required override box; Send posts the exact `send-for-approval` body; a 409 surfaces inline; Negotiate posts `{comment}`). (2) RED. (3) implement (+ the RadioGroup primitive). (4) GREEN + lint + typecheck. (5) commit `feat(stage5): maker controls — shortlist / send-for-approval / negotiate (S5.6)`.

---

## Task 5 — Checker view: approve / reject + Generate gate + decision timeline

**Files:** `apps/web/src/features/compare/CheckerPanel.tsx`, `GenerateGate.tsx`, `DecisionTimeline.tsx`; mutation hooks `useApprove`/`useReject`/`useGenerateClientQuote`; test `CheckerPanel.test.tsx`.

**Produces (Manager+ only — conditional mount):** per leg with `decision.status === "PENDING_APPROVAL"`, **Approve** + **Reject** (reject requires a reason via `rejectSchema`) — both **disabled with a four-eyes hint** when `decision.sentByUserId === user.id`. A **decision timeline** (`leg.timeline`) rendered in every mode (maker sees the checker's reasons + vice-versa). A **Generate quotation for client** gate (`GenerateGate`) enabled only when **every** leg's `decision.status === "APPROVED"` → `generate-client-quote` (Manager+). Buttons disable after action / re-enable per §9 button-state rules.

**Hooks:** `useApprove(queryId, legId)`, `useReject(queryId, legId)` (`postJson(...approve|reject, ...)`, invalidate comparison + query), `useGenerateClientQuote(queryId)`. Handle `403 SELF_APPROVAL` / `409` inline.

**Steps (TDD):** (1) failing `CheckerPanel.test.tsx` (checker controls hidden for EXECUTIVE, shown for MANAGER; approve/reject disabled when the viewer is the sender; reject posts the reason; Generate disabled until all legs APPROVED then posts). (2) RED. (3) implement. (4) GREEN + lint + typecheck. (5) commit `feat(stage5): checker view — approve/reject + generate gate + timeline (S5.6)`.

---

## Task 6 — Quoting-Client end-state panel

**Files:** `apps/web/src/features/compare/QuotingClientPanel.tsx`; `useReopenComparison` hook; test `QuotingClientPanel.test.tsx`. Wire into `CompareQuotesPage` (shown when `query.status === "QUOTING_CLIENT"` / `awardSnapshot` present).

**Produces:** when the query is `QUOTING_CLIENT`, a frozen **award summary** panel — per-leg winner (FF + variant + USD) from `Query.awardSnapshot` (`QueryAwardSnapshot`), the **combined USD** total, the FX "as of" stamp, and a **Reopen** button (`reopen-comparison`, Executive+) that returns to the live comparison. The comparison grid switches to a read-only/locked presentation in this state.

**Steps (TDD):** (1) failing `QuotingClientPanel.test.tsx` (renders the per-leg winners + combinedUsd from a mocked snapshot; Reopen posts `reopen-comparison` + invalidates). (2) RED. (3) implement. (4) GREEN + **full `pnpm run ci`**. (5) commit `feat(stage5): quoting-client end-state panel + reopen (S5.6)`.

### S5.6 acceptance
- [ ] `pnpm run ci` green → **visual verification** against the mockup (run `apps/web` dev server, screenshot the compare screen in maker + checker modes, light + dark) → opus whole-branch review → push to PR #52.

---

## Self-review (against §12)
- **§12 coverage:** route + StageRail wiring (T2); reuse QueryOverviewHeader/RouteDiagram(+selectedLeg)/leg accordion (T2); read-only (FF×variant) grid + recommendation + click-FF detail (T3); maker view (T4); checker view + Generate gate + timeline (T5); Quoting-Client panel + reopen (T6). FX-admin screen already exists (S5.1) — no task.
- **Backend prerequisite (T1):** the decision + timeline + itemised charges the UI needs but the read model doesn't yet expose — flagged as a scope correction to §15's "no migration/pure frontend" (no migration; is backend code).
- **RBAC:** maker Executive+, checker Manager+ conditional-mount, four-eyes-disabled approve/reject, Generate Manager+-only-no-four-eyes (O4). Server enforces; UI mirrors.
- **New primitives:** `RadioGroup` (T4), the `RouteDiagram` selected-leg channel (T2) — both flagged as build-from-scratch. No toast (inline `role="alert"`).
- **Visual authority:** the approved mockup + the existing shadcn token system; no new visual language.
