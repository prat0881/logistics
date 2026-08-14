# Stage 5 — Compare Quotes & Award — Design

> The _what_ + the _how_ for the program's **Stage 5**: the internal decision layer that turns the validated per-leg quotes Stage 4 produced into an **approved, awarded selection** ready to quote the client. Greenfield (no prior spec); realises the `Requoted` / `Approved` / `Quoting Client` statuses the earlier stages defined but never drove. Sibling of the Stage-4 docs; inherits their Extensibility-Core conventions.
>
> **Status:** DESIGN — for review. Companion UI mockup (approved): the interactive `Compare Quotes` artifact (Executive + Admin modes, both themes). Implementation plan → `docs/plans/stage-5/`.

---

## 1. Purpose, scope & boundary

Stage 4 ends with a set of **comparable, validated quotes per leg** — one `Quote` per `(leg, FF)`, each carrying a full `draftJson` (per-variant freight, common charges, transit, chargeable weight, currency). Stage 5 is the **internal workflow** that:

1. **Compares** those quotes leg-by-leg in a column layout (one column per `(FF × rate-variant)` offer), normalised to a common **USD** basis.
2. **Recommends** a winning offer per leg by a priority-driven rule.
3. Lets the **Executive** shortlist an offer per leg (defaulting to the recommendation), **negotiate** a re-quote from any FF, and **send each leg for approval**.
4. Lets a **checker** (a different user; see §4) **approve or reject** each leg, capturing reasons that flow back to the Executive.
5. When **every leg is approved**, unlocks **"Generate quotation for client"**, which freezes the awarded selection and moves the query to **`Quoting Client`**.

### Boundary (locked)
Stage 5 **ends at award/approval**. It does **not** build the client-facing quotation document, apply margin/markup, or send anything to the client or the FFs. Those — plus the `Awaiting Client Decision` / `Won` / `Lost` transitions — are **Stage 6**. Crucially, **no award e-mail is sent to any FF**: "Approved" is a _provisional_ internal selection. Nothing reaches a forwarder until the client closes the deal (Won), which is why an approved leg must remain reversible (§9, §10).

### Non-goals
Client quotation document / PDF; margin/markup model; FF award notifications; multi-currency client billing; Stage-6 `Won/Lost/Closed` drivers.

---

## 2. Prerequisites & branch base

- **Base = `main` after PR #51 is merged.** Stage 5 is built entirely on the **v3 per-variant quote model** — `SeaFreightRate`, per-variant `TruckingCharge`/`TransitPlan`, `Quote.draftJson`, `chargeConfigSnapshot`, `computeQuoteTotals` — which today lives **only on `feat/stage-3-cargo-packing-list` (PR #51)**, not on `main`. `main` already has SB5 (comms), SB6 (change-order), and charge-config. **Decision (user):** merge #51 to `main` first (the go-live cutover) and branch Stage 5 off a clean `main`.
- **#51 merge = destructive prod cutover** (`DROP CargoItem`/`LegCargo` + `DELETE QuoteCargoLine`, auto-`migrate deploy` to Neon prod on merge). It is gated on its own checklist — quantify prod loss (`count(*)` on those 3 tables) → staging Neon-branch dry-run → explicit approval — and is sequenced **before any Stage 5 code lands**. The design doc and implementation plan do **not** depend on it.
- **Depends on SB6** (change-order cascade): Stage 5 must react to a change-order that invalidates a quote by **reversing** that leg's approval (§10). SB6 is on `main`.

---

## 3. Locked decisions

| # | Decision | Rationale |
| :-- | :-- | :-- |
| **D1** | **Comparison unit = `(FF × rate-variant)` offer.** Road → Dedicated/Groupage columns; Sea → FCL/LCL; Air → single. Each variant is its own comparable offer; the recommendation and the award pick a specific `(FF, variant)` pair. | Matches the v3 charge model; a faster-but-pricier variant stays visible to the ranking. |
| **D2** | **Currency → USD via an admin-managed FX table.** Live rates during comparison; **the rate + USD totals are snapshotted at "Generate."** | Spec D8 ("conversion at comparison"). A frozen rate gives the client a stable quoted number; no external FX dependency. |
| **D3** | **Recommendation is a pure, live-derived function** — never stored — but the **recommended offer is snapshotted onto the decision record at shortlist time** so "did the Executive override?" is auditable. | Live so it always reflects current quotes/rates; snapshot so the override reason is anchored to what was recommended _then_. |
| **D4** | **Recommendation rule.** **High/Urgent priority** → lowest `guaranteedTransitDays`; ties → lower USD total. **Medium/Low** → lowest USD total; ties → lower transit. Final tie → earliest `submittedAt` (deterministic). | The requirement's rule; `Urgent` folds into `High` (lead-time-first). Transit days are guaranteed present (Q_TRANSIT is mandatory for priced variants). |
| **D5** | **"Approved" is provisional; term "Awarded" is reserved for Stage 6+.** Admin approval selects the FF for a leg with **no FF notification**; reversible until the client wins. | The user's correction: don't tell a forwarder they won before the client closes. |
| **D6** | **Terminal query status = new `Quoting Client`** (not `Awaiting Client Decision`). | The quotation isn't sent yet at Stage-5 end; `Awaiting Client Decision` is a Stage-6 state (after the quote reaches the client). |
| **D7** | **Soft stage-lock.** Once any FF quotes, the workspace focuses on Compare Quotes; Create/RFQ stay reachable and post-RFQ edits still flow through SB6's change-order path. UI de-emphasis only — no new backend freeze. | Consistent with SB6; nothing is truly frozen except via change-order. |
| **D8** | **Negotiation is a dedicated per-FF re-quote path** (not the change-order mediator). Comment + regenerate that FF's portal link → `Requoted` → `RFQ_Sent`; other FFs untouched; reverses that leg's approval if the re-quoted FF was the approved one. | A negotiation has no field edit, so the change-order path doesn't apply. |
| **D9** | **RBAC — maker Executive+, checker Manager+ with four-eyes.** Roles are cumulative: **Executive ⊂ Manager ⊂ Administrator**. **Maker** actions (view comparison, shortlist, negotiate, send-for-approval) = **Executive+** (auth-only). **Checker** actions (approve/reject a leg, generate client quotation) = **Manager+** _and_ a **different user than the sender** (four-eyes) — a plain Executive never sees the approval controls. FX-table writes = **Manager+** (master-data). | The user's model: "Manager and above for approval; any Executive can send; the same person can't approve their own." A deliberate, user-specified `@Roles` gate on the checker tier (a considered deviation from the Executive+-everywhere convention). |
| **D10** | **Send-for-approval requires the leg to be `Fully Quoted` or its deadline passed.** Comparison is _viewable_ once ≥1 FF has quoted. | Don't lock an award while a better quote could still land. |
| **D11** | **A leg with no viable quote** (all expired/closed) must be **re-distributed and quoted** before "Generate" can unlock — there is **no close-leg / partial-award** path. | The query is awarded whole or not at all; every leg reaches `Approved`. |

---

## 4. Personas & RBAC

Three cumulative roles (existing): `EXECUTIVE` ⊂ `MANAGER` ⊂ `ADMINISTRATOR`. A higher role can do everything a lower one can.

| Capability | Who | Enforcement |
| :-- | :-- | :-- |
| View comparison, shortlist, negotiate, send-for-approval | **Executive+** | auth-only (no `@Roles`) |
| Approve / reject a leg | **Manager+**, and **≠ the user who sent that leg** | `@Roles(ADMINISTRATOR, MANAGER)` + **four-eyes** guard on `sentByUserId` |
| Generate client quotation | **Manager+** | `@Roles(ADMINISTRATOR, MANAGER)` — per **§16 O4**, *no* extra four-eyes (the per-leg four-eyes already applied at each leg's approval) |
| Create/edit FX rates | **Manager+** | `@Roles(ADMINISTRATOR, MANAGER)` (master-data convention) |

The mockup's two views map onto the roles: **maker mode** (compare / shortlist / negotiate / send) is visible to **Executive+**; the **checker mode** — the approval screen with approve/reject + the "Generate" gate — is visible **only to Manager+**; its **approve/reject** controls are active only when the current user is _not_ the one who sent that leg (four-eyes), while **Generate** requires only Manager+ (**§16 O4** — no extra four-eyes, since each leg's approval already passed four-eyes). **A plain Executive can send for approval but never sees or performs an approval.** This is a **deliberate deviation** from the "all workflow writes Executive+" convention: the checker tier is role-gated (like master data), which the user explicitly required.

---

## 5. Data model additions

All additive migrations (no destructive changes). Enum values mirror the shared-const pattern (`const` object + union + `Object.values` cast + pinned `toEqual` test), never a TS `enum`.

### 5.1 New enum values
- `QueryStatus += QUOTING_CLIENT` (Prisma + shared `status.ts` + label/variant maps).
- `LegStatus += APPROVED` — the leg's winning FF is selected (provisional). **Distinct from `AWARDED`**, which stays reserved for the post-Won execution phase (Stage 6+).
- `QuoteStatus` — `APPROVED` and `REQUOTED` already exist (undriven); Stage 5 drives them. No new value (reject is a decision, not a quote state — see §8).
- New `QuoteEvent += APPROVE, UNAPPROVE, REQUEST_REQUOTE` and new `LegEvent += APPROVE, REOPEN_AWARD`.

### 5.2 `FxRate` (new master table)
```
model FxRate {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String?  @db.Uuid
  currency     String                       // ISO-4217, e.g. "INR" (USD implicit = 1)
  unitsPerUsd  Decimal  @db.Decimal(18,8)   // 83.20000000 → 1 USD = 83.2 INR
  effectiveFrom DateTime @default(now())
  note         String?
  createdById  String?  @db.Uuid
  createdAt    DateTime @default(now())
  @@index([currency, effectiveFrom])
}
```
Comparison reads the **latest** `FxRate` per currency (`effectiveFrom ≤ now`). USD amount = `currencyAmount / unitsPerUsd` (USD rate ≡ 1). Missing rate for a quoted currency → that offer shows its native amount + a **"no FX rate — set one to rank"** warning and is excluded from the numeric ranking until a rate exists.

### 5.3 `LegAwardDecision` (current decision state, one per leg)
```
model LegAwardDecision {
  id                  String   @id @default(uuid()) @db.Uuid
  legId               String   @unique @db.Uuid
  queryId             String   @db.Uuid
  shortlistedQuoteId  String?  @db.Uuid
  shortlistedVariant  ChargeRateVariant?          // the chosen (FF × variant)
  recommendedQuoteId  String?  @db.Uuid           // system rec snapshot at shortlist
  recommendedVariant  ChargeRateVariant?
  overrideReason      String?                     // required when shortlist ≠ recommendation
  status              AwardDecisionStatus @default(DRAFT)
  sentForApprovalAt   DateTime?
  sentByUserId        String?  @db.Uuid           // drives the four-eyes guard
  decidedByUserId     String?  @db.Uuid
  decidedAt           DateTime?
  rejectionReason     String?                     // checker's reason, shown to Executive
  updatedAt           DateTime @updatedAt
}
enum AwardDecisionStatus { DRAFT PENDING_APPROVAL APPROVED REJECTED }
```
`status` is the maker-checker state machine _for the decision_ (not a leg/quote status): `DRAFT → PENDING_APPROVAL → APPROVED | REJECTED`, and `APPROVED/REJECTED → DRAFT` on reopen. The **leg** flips `FULLY_QUOTED → APPROVED` only when the decision reaches `APPROVED`.

### 5.4 `AwardDecisionEvent` (append-only audit trail)
```
model AwardDecisionEvent {
  id       String   @id @default(uuid()) @db.Uuid
  legId    String   @db.Uuid
  queryId  String   @db.Uuid
  type     String                    // SHORTLIST | SEND_FOR_APPROVAL | APPROVE | REJECT | REQUEST_REQUOTE | REOPEN
  quoteId  String?  @db.Uuid
  variant  ChargeRateVariant?
  reason   String?
  actorId  String?  @db.Uuid
  at       DateTime @default(now())
  @@index([legId])
}
```
Powers the decision **timeline** in the UI and the audit record of every maker/checker action across re-send loops.

### 5.5 Reason on status transitions (Extensibility-Core enhancement)
- `StatusTransition += reason String?` and `FireContext += reason?: string`. `StatusService.fire` persists `ctx.reason` onto the transition row. Generally useful (any future stage can annotate a transition); Stage 5's `APPROVE`/`UNAPPROVE`/`REQUEST_REQUOTE` fires carry the reason.

### 5.6 Award freeze snapshot
- `Query += awardSnapshot Json?` — written when "Generate" fires; frozen per-leg `{ legId, winningQuoteId, variant, currency, unitsPerUsd, usdTotal, transitDays }[]` + `combinedUsd`. Mirrors the `manifestSnapshot`/`chargeConfigSnapshot` pattern. Cleared on reopen. This is the **hand-off payload for Stage 6** and the stable client number.

---

## 6. Currency → USD normalisation

- **Shared helper** `toUsd(amount, currency, rate)` in `@svyft/shared` (pure): `currency === "USD" ? amount : amount / rate.unitsPerUsd`, rounded to cents. All comparison money is computed via `computeQuoteTotals(draftJson)` (native) → `toUsd(...)` (normalised).
- **Rate selection:** latest `FxRate` per currency at read time. The comparison read model attaches, per quote, the `{ currency, unitsPerUsd, rateAsOf }` used, so the UI can show "₹83.2/$1" and the audit is explicit.
- **Freeze:** at "Generate," the rate used per winning leg is copied into `awardSnapshot`. Re-generating after a reopen re-snapshots at the then-current rate.

---

## 7. Recommendation engine (`@svyft/shared`)

Pure function, unit-tested, no `Date.now()`/IO:
```
recommendOffer(input: {
  priority: Priority,
  offers: { quoteId, variant, usdTotal|null, transitDays, submittedAt }[]   // one per (FF × priced variant)
}): { quoteId, variant } | null
```
- Consider only **clean `QUOTED`** offers with a resolvable `usdTotal`. **Offers under re-quote (`REQUOTED`) are excluded** — you've asked to change that price, so the system won't recommend it (its earlier price still shows in the grid, badged stale — §11). Offers missing an FX rate are surfaced as a warning and excluded until priced (D2).
- **High/Urgent:** sort by `transitDays` asc → `usdTotal` asc → `submittedAt` asc.
- **Medium/Low:** sort by `usdTotal` asc → `transitDays` asc → `submittedAt` asc.
- Returns the top offer, or `null` when no offer is rankable (empty/all-unpriced) — the UI then shows "no recommendation yet."
- Colocated `recommend.test.ts` covering: each priority branch, transit tie → price, price tie → transit, single-variant FF, an FF that only priced one of two variants, an unpriced (no-FX) offer excluded, `Urgent==High`.

---

## 8. Status lifecycle & Extensibility-Core additions

Everything routes through the **one door** `StatusService.fire`; machines are pure data registered/contributed in a module `onModuleInit` (never edit a Stage-3 status file).

### 8.1 Quote machine (contributed edges)
| From | Event | To | When |
| :-- | :-- | :-- | :-- |
| `QUOTED` | `APPROVE` | `APPROVED` | checker approves the shortlisted quote's leg |
| `APPROVED` | `UNAPPROVE` | `QUOTED` | approval reversed (reopen / negotiate an approved FF) |
| `QUOTED` | `REQUEST_REQUOTE` | `REQUOTED` | Executive asks this FF to re-quote — **the prior `draftJson` (earlier price) is retained**; the token is re-issued so the portal reopens |
| `APPROVED` | `REQUEST_REQUOTE` | `REQUOTED` | re-negotiate an already-approved FF (also reverses the leg approval + resets the decision) |
| `REQUOTED` | `SUBMIT` | `QUOTED` | the FF submits the **revised** quote (the ff-portal submit guard is extended to accept `REQUOTED`; the new price overwrites `draftJson`) → re-enters the comparison as a clean offer |
| `REQUOTED` | `EXPIRE` | `EXPIRED` | the deadline passes with no revised quote (expiry sweep) |
| `APPROVED` | `INVALIDATE` | `INVALID` | **new source** — a change-order reopens the leg an approved quote sat on |

**`REQUOTED` is the _durable_ "awaiting revised quote" state** (not a transient hop to `RFQ_SENT`): the FF's earlier price stays visible in the comparison while it waits, the re-issued token reopens the portal for it, and a leg reads `awaitingReQuote = true` while any of its FFs sits in `REQUOTED`.

**Reject is not a quote transition** — the quote stays `QUOTED`; only the `LegAwardDecision` moves to `REJECTED`. (No `REJECTED` quote status; matches spec §9.1's vocabulary.)

### 8.2 Leg machine (contributed edges)
| From | Event | To |
| :-- | :-- | :-- |
| `FULLY_QUOTED` | `APPROVE` | `APPROVED` |
| `APPROVED` | `REOPEN_AWARD` | `FULLY_QUOTED` (reopen / reject-after-approve / negotiate) |
| `APPROVED` | `REOPEN` | `READY_FOR_RFQ` (**new source** — change-order reopens an approved leg) |

### 8.3 Query rollup (`deriveQueryStatus`)
- Add a `quotingClient` milestone (set by "Generate," cleared on reopen) → `QUOTING_CLIENT`. Mirrors the existing `won/lost/closed/awaitingClientDecision` milestone pattern.
- Add `APPROVED` to `LEG_RANK` (above `FULLY_QUOTED`). All-legs-`APPROVED` alone keeps the query at `QUOTED` (the milestone, not the rollup, drives `QUOTING_CLIENT`) — so the "Generate" button is the single gate.
- `QUOTING_CLIENT` → (Stage 6) `AWAITING_CLIENT_DECISION`.

### 8.4 Reason capture
Approve/reject/requote all carry a `reason` (via `FireContext.reason` → `StatusTransition.reason`, and mirrored onto `LegAwardDecision` + an `AwardDecisionEvent`) so both directions are visible cross-mode.

---

## 9. The maker-checker workflow

Per leg, the decision walks: `DRAFT → PENDING_APPROVAL → APPROVED` (or `→ REJECTED → DRAFT`), all recorded on `LegAwardDecision` + `AwardDecisionEvent`.

1. **Shortlist (Executive).** Pick a `(FF, variant)` offer; defaults to the live recommendation. Snapshot `recommendedQuoteId/Variant`. Selecting a non-recommended offer requires `overrideReason` before sending.
2. **Negotiate (Executive, optional).** Per FF — see §10. **Requesting a re-quote auto-clears this leg's shortlist/approval** (`LegAwardDecision → DRAFT`) — the basis changed, so the decision reopens.
3. **Send for approval (Executive).** Guards: leg `FULLY_QUOTED` or deadline passed (D10); override reason present if shortlist ≠ recommendation; and if the leg has an **in-flight re-quote** (`awaitingReQuote`, §11) it is **blocked by default** ("awaiting <FF>'s revised quote") unless the Executive **overrides** with a recorded reason ("proceed without waiting") — the override lets them shortlist any offer, **including the re-quoted FF's own earlier price** (A9). Sets `PENDING_APPROVAL`, `sentByUserId`, `sentForApprovalAt`. The send button then **disables** until a rejection.
4. **Approve (checker ≠ sender).** Fires quote `APPROVE` (→`APPROVED`) + leg `APPROVE` (→`APPROVED`). Decision `APPROVED`. Approve/Reject controls lock.
5. **Reject (checker ≠ sender).** Requires `rejectionReason`. Decision `REJECTED` → back to `DRAFT` (quote unchanged); Executive's send button re-enables; the reason shows in the Executive's timeline.
6. **Generate quotation for client.** Enabled only when **every** leg's decision is `APPROVED` (and no unresolved no-quote leg, D11). Fires the `quotingClient` milestone → query `QUOTING_CLIENT`, writes `awardSnapshot`. Reversible via **Reopen** (clears the milestone/snapshot → `QUOTED`).

**Override reason** (Executive→checker, when shortlist ≠ recommendation) and **rejection reason** (checker→Executive) both persist and render in the opposite mode. Button-state rules mirror the mockup: send disables on click / re-enables on reject; approve+reject disable after either is taken / re-enable on re-send.

---

## 10. Negotiation / re-quote & change-order interaction

### 10.1 Negotiation (dedicated path, D8)
`POST /queries/:id/legs/:legId/quotes/:quoteId/request-requote` (Executive+), body `{ comment }`:
- Fire quote `REQUEST_REQUOTE` (`QUOTED`|`APPROVED` → `REQUOTED`). **Retain the prior `draftJson`** (the earlier price stays visible in the comparison, badged stale — §11). **Reset this leg's `LegAwardDecision` to `DRAFT`** (clears any shortlist/approval — the basis changed); if the quote was `APPROVED`, also fire leg `REOPEN_AWARD` (→`FULLY_QUOTED`).
- **Re-issue the FF's portal token** (reuse `RfqTokenService` + the existing reissue path) so the portal reopens **for the `REQUOTED` quote** (extend the ff-portal `GET`/submit guard to accept `REQUOTED` alongside `RFQ_SENT`); **reset that RFQ's `submissionDeadline`** + re-arm the SB5 reminder/expiry `ScheduledEvent`s; dispatch `rfq.updated` via the SB5 `NotificationDispatcher` with the negotiation comment.
- On the FF's re-submit, `SUBMIT` (`REQUOTED`→`QUOTED`) overwrites `draftJson` with the revised price → it re-enters the comparison as a clean offer and the recommendation recomputes. **Other FFs' quotes on the leg are untouched.**
- Record an `AwardDecisionEvent{type: REQUEST_REQUOTE, reason: comment}`. `REQUOTED` is the **durable** "awaiting revised" state (§8.1) — the leg reads `awaitingReQuote = true` while any FF sits in it.

### 10.2 Change-order reversal (depends on SB6)
When SB6's `ChangeOrderStrategy` invalidates a quote (a post-RFQ field edit reopens a leg), Stage 5 **reverses any approval on that leg**: a listener on the existing `changeorder.leg.reopened` (or the quote `INVALIDATE`) event resets the leg's `LegAwardDecision` to `DRAFT`, fires leg `REOPEN_AWARD`/`REOPEN` as appropriate, and — if the query was `QUOTING_CLIENT` — clears the `quotingClient` milestone + `awardSnapshot` (back to `QUOTED`). New edges added in §8.1/8.2 (`APPROVED → INVALID`, `APPROVED → READY_FOR_RFQ`) make this legal.

---

## 11. Read model & APIs

All under `/api/queries/:id` unless noted; all Executive+ (four-eyes enforced in-service for approve/reject; **Generate is Manager+ only — no four-eyes, §16 O4**).

| Method / path | Purpose | RBAC |
| :-- | :-- | :-- |
| `GET …/comparison` | The comparison read model: per leg → **`offers`** (one per `(FF × variant)` for each `QUOTED`/`REQUOTED` quote) `{ nativeTotal, currency, unitsPerUsd, usdTotal, transitDays, chargeableWeight, validUntil, quoteStatus, priced }` — a `REQUOTED` offer carries its **earlier** price badged stale; **`pendingForwarders`** (FFs with no comparable price: `RFQ_SENT`/`EXPIRED`/`INVALID`/`CLOSED`); **`awaitingReQuote`** (any FF `REQUOTED`); the live **recommendation** (clean `QUOTED` only); the `LegAwardDecision` + decision timeline; per-quote itemised charges (from `draftJson`). Computes via `computeQuoteTotals` + `toUsd`. | Executive+ |
| `PUT …/legs/:legId/shortlist` | Set/replace the shortlist `{ quoteId, variant, overrideReason? }`; snapshots the recommendation. | Executive+ |
| `POST …/legs/:legId/send-for-approval` | Guarded by D10 + override-reason rule → `PENDING_APPROVAL`. | Executive+ |
| `POST …/legs/:legId/approve` | Four-eyes → decision/leg/quote `APPROVED`. | **Manager+**, ≠ sender |
| `POST …/legs/:legId/reject` | Four-eyes + `{ reason }` → decision `REJECTED`. | **Manager+**, ≠ sender |
| `POST …/legs/:legId/quotes/:quoteId/request-requote` | §10.1. | Executive+ |
| `POST …/generate-client-quote` | All-legs-approved gate → `QUOTING_CLIENT` + `awardSnapshot`. | **Manager+** |
| `POST …/reopen-comparison` | Clears the milestone/snapshot → `QUOTED`. | Executive+ |
| `GET /fx-rates` · `POST /fx-rates` | FX master read/write. | read Executive+ / write **Manager+** |

Shared DTOs (`@svyft/shared`): `ComparisonDto`, `LegComparisonDto` (incl. `awaitingReQuote`), `OfferDto`, `PendingForwarderDto`, `AwardDecisionDto`, `AwardDecisionEventDto`, `FxRateDto`, `RecommendationDto`, `QueryAwardSnapshotDto`. Errors via the global `ZodValidationPipe` + `PrismaExceptionFilter`; a non-`Manager+` on a checker route → `403` (RolesGuard); a **four-eyes violation → `403 SELF_APPROVAL`**; a stale-shortlist (quote no longer `QUOTED`) → `409`.

---

## 12. Frontend

The **approved mockup is the visual spec** (interactive `Compare Quotes` artifact). Route `/queries/:id/compare` (new; wire the `StageRail` "Quotes" step, widen its `active` union, add an `isQuotesStageEnabled` gate at `RFQ_SENT`+). Reuse:

- **As-is:** `QueryOverviewHeader`, `RouteDiagram` (+ `computeRouteLayout`), `ForwarderStatusBadge`/`statusBadges`, the shadcn primitives + tokens.
- **Adapt:** `RouteDiagram` gains a `selectedLegId`/`onSelectLeg` channel (clicking a leg opens+scrolls its accordion — reuse the `onEditLeg`/`jumpToLeg` seam); the single-open `LegPanel` accordion pattern; the `ChargeMatrix` grid model → a **read-only comparison grid** with `(FF × variant)` columns, common charges repeated per variant, `NotApplicableCell` greying, click-FF-to-expand itemised detail.
- **New:** the comparison grid + recommendation banner; the **maker view** (Executive+: shortlist radios, override-reason box, negotiate, send-for-approval); the **checker view** rendered **only for Manager+** (approve/reject controls + the Generate gate, with controls disabled when the viewer is the leg's sender — four-eyes); the decision timeline; the **Quoting Client** end-state panel (frozen award summary + combined USD + reopen); an **FX-rate admin** screen under `masters/`.
- Data via TanStack Query hooks (`useComparison`, `useAwardDecision`, mutations) over `lib/api.ts`; forms with RHF + Zod schemas from `@svyft/shared`. No autosave — explicit actions, re-GET on mutate.

---

## 13. Validation catalogue (Stage-5)

| # | Rule | Severity | Trigger |
| :-- | :-- | :-- | :-- |
| A1 | Shortlist references an offer present on the leg — a `QUOTED` offer, or (only under an A9 override) the re-quoted FF's own earlier-price `REQUOTED` offer. | Blocking | shortlist |
| A2 | Override reason present when shortlist ≠ recommendation. | Blocking | send-for-approval |
| A3 | Leg is `FULLY_QUOTED` or deadline passed (D10). | Blocking | send-for-approval |
| A4 | Approver is **Manager+** and **≠ sender** (four-eyes). Generate = **Manager+ only, no four-eyes** (§16 O4). | Blocking | approve / reject |
| A5 | Rejection reason present. | Blocking | reject |
| A6 | Every leg's decision is `APPROVED`; no unresolved no-quote leg (D11). | Blocking | generate |
| A7 | An FX rate exists for every currency among the awarded winners. | Blocking | generate |
| A8 | Offer being acted on is still current (not _silently_ changed by a concurrent re-quote/change-order). The deliberate A9 override is the sanctioned exception. | Blocking (409) | approve / send |
| A9 | A leg with an in-flight re-quote (`awaitingReQuote`) is blocked from send-for-approval unless the Executive supplies an **override with a recorded reason** ("proceed without waiting"). | Blocking (overridable) | send-for-approval |

---

## 14. Edge cases

- **Partial quotes:** comparison viewable at ≥1 quote; shortlist allowed; send gated by A3.
- **No-viable-quote leg** (all expired/closed): blocks generate (A6); **must be re-distributed** (change-order → new RFQ → quote). No close-leg / partial-award path (per O2).
- **Re-quote in flight:** the FF's column shows its **earlier price** badged "Re-quote requested · awaiting revised," is excluded from the recommendation, and sets the leg's `awaitingReQuote`. Send-for-approval is blocked by default, but the Executive can **override** ("proceed without waiting") and shortlist any offer — including that FF's earlier price (§9 step 3, A9). When the revised quote arrives (`REQUOTED→QUOTED`) it re-enters the comparison and the recommendation recomputes.
- **Concurrent change-order after approval:** §10.2 reverses the approval and (if generated) drops the query out of `QUOTING_CLIENT`.
- **FX rate changes between generate and reopen:** re-generating re-snapshots at the current rate; the frozen `awardSnapshot` is what Stage 6 quotes.
- **Same user, two browser tabs (maker+checker):** four-eyes is enforced server-side on `sentByUserId`, not the UI mode.

---

## 15. Sub-build decomposition

Each sub-build = its own worktree off `main` (post-#51), plan in `docs/plans/stage-5/`, `superpowers:subagent-driven-development` (sonnet implementers + opus whole-branch review), PR. Ordered by dependency:

| SB | Scope | Migration? |
| :-- | :-- | :-- |
| **S5.1 — FX master** | `FxRate` model + module (read Executive+, write Manager+) + `toUsd` shared helper + web `masters/fx-rates` screen. | yes (`add_fx_rate`) |
| **S5.2 — Comparison engine (shared) + read model** | `recommendOffer` + `OfferDto`/`LegComparisonDto` + `GET …/comparison` (per-variant totals via `computeQuoteTotals` + `toUsd`). Backend + shared; no writes. | no |
| **S5.3 — Status & decision foundations** | enum additions (`QUOTING_CLIENT`, leg `APPROVED`, quote/leg events) + machine contributes + `reason` on `StatusTransition`/`FireContext` + `LegAwardDecision`/`AwardDecisionEvent` + `Query.awardSnapshot`. Headless. | yes (`add_award_decision`) |
| **S5.4 — Approval workflow endpoints** | shortlist / send-for-approval / approve / reject / generate / reopen (+ four-eyes guard, A1–A8), firing through the machines; query rollup. | no |
| **S5.5 — Negotiation / re-quote** | the dedicated per-FF re-quote path (§10.1) + the change-order reversal listener (§10.2). | no |
| **S5.6 — Compare Quotes frontend** | the `/queries/:id/compare` screen per the mockup + the FX-admin screen + hooks. | no |

**Sequencing:** S5.1 → S5.2 → S5.3 → S5.4 → (S5.5 ∥ S5.6). Each is independently reviewable/mergeable to `main`. (S5.5 and S5.6 can overlap once S5.4 lands.)

---

## 16. Open items — for your review (O-S5-*)

- **O1 — RESOLVED:** checker = **Manager+ _and_ ≠ sender** (role gate + four-eyes). A plain Executive can send for approval but never sees/performs approval.
- **O2 — RESOLVED:** **no close-leg** — a dead leg must be re-distributed and quoted; the query is awarded whole (no partial award).
- **O4 — RESOLVED:** **"Generate" = Manager+** (the checker tier). No extra four-eyes on Generate itself — the per-leg four-eyes already applied at each leg's approval.
- **O3 — Manager self-send (confirm):** a Manager may _send_ a leg and a **different** Manager+ approves it; four-eyes blocks only self-approval. Assumed: no minimum-second-role beyond Manager+.
- **O5 — FX granularity (confirm):** one global `FxRate` table (optional `tenantId`), latest-effective. Assumed global.
