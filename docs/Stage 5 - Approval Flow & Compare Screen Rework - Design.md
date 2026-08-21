# Stage 5 · S5.9 — Approval Flow Statuses & Compare-Screen Rework — Design

_Authored 2026-08-21. Design of record for sub-build **S5.9**. Parent designs: `docs/Stage 5 - Compare Quotes - Design.md`, `docs/Stage 5 - Compare Quotes UI Enhancements - Design.md` (S5.7). Implementation plan: `docs/plans/stage-5/Stage 5 - S5.9 - Approval Flow & Compare Screen Rework - Implementation Plan.md`._

## 1 · Why this sub-build exists

The product owner reviewed the delivered S5.6/S5.7 Compare Quotes screen and raised nine UI/UX issues. Working through them surfaced three things that are **not** cosmetic:

1. **The manager cannot see what they are approving.** Once a leg's decision leaves `DRAFT`, the whole Shortlist affordance is unmounted (`CompareLegPanel.tsx`), the checker panel shows only Approve/Reject, and the decision timeline records event types without naming a forwarder. Nothing on screen identifies the selected offer.
2. **The approval flow is invisible in status.** Shortlist → send → approve all happen inside `LegStatus.FULLY_QUOTED`; only the private `LegAwardDecision.status` moves.
3. **The negotiate feature delivered in S5.5 cannot be completed by the forwarder.** The backend accepts a `REQUOTED` re-submission and was e2e-tested for it (`ff-portal-requote-submit.e2e-spec.ts`), but `LegSection.tsx` has no `REQUOTED` branch, so the portal tells the forwarder *"This leg is not open for quoting."* **Severity: Critical — a shipped feature is a dead end.**

S5.9 fixes all three plus the nine UI items.

## 2 · Vocabulary guard (unchanged, still binding)

Decision **D5** stands: nothing in Stage 5 is *awarded*. User-visible strings say **Approved**, **Quotation**, **Issue**, **Quoting client**. `LegStatus.AWARDED` remains deliberately unreachable. Internal `award*` identifiers keep their names.

**New for S5.9:** the forwarder-facing portal must never reveal a commercial outcome. Both `PENDING_APPROVAL` and `APPROVED` render to the forwarder as a single neutral label — **"Under review"** (D9 below).

## 3 · Decisions

| # | Decision | Rationale |
| :-- | :-- | :-- |
| **D1** | **New `LegStatus.PENDING_APPROVAL`**, rank 5, mapped to `QueryStatus.QUOTED` in `deriveQueryStatus`. | Makes the approval flow visible at leg level. Query status deliberately unchanged — the product owner asked for no query-level change. |
| **D2** | **New `QuoteStatus.PENDING_APPROVAL`**, set on the selected quote only. | Supersedes the originally-requested `SHORTLISTED`. Because D3 removes standalone shortlisting there is exactly one moment and one status, and the losing forwarders staying `QUOTED` *is* the differentiation the manager needs. |
| **D3** | **Standalone "save shortlist" is removed.** Selecting an offer and sending for approval are one action. | Product owner's call. It also collapses the two-call race (§4.3). |
| **D4** | **Reject restores the leg's *recomputed* rollup status**, not a hard-coded `FULLY_QUOTED`. | `sendForApproval` is legally reachable from a `PARTIALLY_QUOTED` leg via the A3/D10 deadline-passed path. Hard-coding `FULLY_QUOTED` would promote a leg into a state it never reached, claiming every forwarder quoted when some timed out. |
| **D5** | **Negotiate is refused with `409` while a leg is `PENDING_APPROVAL`** (register B1). | The UI has disabled it since S5.7 while the server accepted it — the two contradicted each other. Without the guard the call would now park the leg at `PENDING_APPROVAL` with a `DRAFT` decision: a state no screen can act on. Matches the product owner's rule that rejection restarts the cycle. |
| **D6** | **`send-for-approval` carries the offer identity** and performs selection + send in one transaction (register B3); `PUT …/shortlist` is retired. | The endpoint previously named no offer and re-read whatever was last persisted, so a concurrent change could submit a different forwarder than the maker saw — 200 OK, no error. D3 makes the merge natural rather than a workaround. |
| **D7** | **The FF portal access token is no longer rotated on re-quote.** Rotation happens only via the existing Stage-4 **Regenerate** button. | The forwarder's bookmarked link keeps working — the product owner's explicit requirement, and materially useful for a forwarder holding many legs across rounds. Rotation on re-quote protected nothing: the same token already survives the entire first round including submission, and `resolveByToken` has no expiry at all. |
| **D8** | **The raw access token is persisted on `Rfq`** so any email can render the current link without rotating. | Required by D7 — the token is otherwise unrecoverable (only its SHA-256 hash is stored). **This is a deliberate security-posture change**, taken because `MessageLog.bodyRendered`/`tokens` already persist the fully rendered email *including the link*, so no new exposure class is created. See §6. |
| **D9** | **Forwarder-facing status for `PENDING_APPROVAL` and `APPROVED` is "Under review".** | The portal renders quote status straight to the forwarder. "Approved" would tell them they won before the client has accepted anything, contradicting D5 and destroying negotiating leverage. |
| **D10** | **The portal submit is guarded by a derived `legVersion`**, not `Quote.updatedAt`. | A stale open page must fail loudly rather than submit against a changed basis. `updatedAt` is wrong because the portal autosaves drafts, so the forwarder's own typing would invalidate their page. The version is derived from what a stale page actually cares about: quote status, submission deadline, manifest snapshot, charge-config snapshot. |

## 4 · The status model

### 4.1 Leg

| From | Event | To |
| :-- | :-- | :-- |
| `FULLY_QUOTED` | `SEND_FOR_APPROVAL` | `PENDING_APPROVAL` |
| `PARTIALLY_QUOTED` | `SEND_FOR_APPROVAL` | `PENDING_APPROVAL` |
| `PENDING_APPROVAL` | `APPROVE` | `APPROVED` |
| `PENDING_APPROVAL` | `RETURN` | `FULLY_QUOTED` |
| `PENDING_APPROVAL` | `RETURN` | `PARTIALLY_QUOTED` |

`FULLY_QUOTED --APPROVE--> APPROVED` is **retired**: send-for-approval is now the only route to approval.

`RETURN` serves both reject (D4) and any future reversal. The target is chosen by recomputing the rollup from the leg's quotes — the same rule `LegQuoteProjector` already owns, extracted into a shared helper so the two cannot drift.

### 4.2 Quote (forwarder-facing)

| From | Event | To |
| :-- | :-- | :-- |
| `QUOTED` | `SEND_FOR_APPROVAL` | `PENDING_APPROVAL` |
| `PENDING_APPROVAL` | `APPROVE` | `APPROVED` |
| `PENDING_APPROVAL` | `RETURN` | `QUOTED` |
| `PENDING_APPROVAL` | `REQUEST_REQUOTE` | `REQUOTED` |

`QUOTED --APPROVE--> APPROVED` is **retired** for the same reason.

Only the selected forwarder's quote moves. Everyone else stays `QUOTED`.

### 4.3 Every place the new quote status must be admitted

Adding a `QuoteStatus` value is not a local change. All of these must learn it or something breaks silently:

| Site | Consequence if missed |
| :-- | :-- |
| `comparison.service.ts` `COMPARABLE_STATUSES` | **The selected offer vanishes from the compare grid** — the exact bug that already bit `APPROVED`. |
| `leg-quote.projector.ts` `RESOLVED` | The leg rollup stops counting the selected quote as settled. |
| `changes/scope.resolver.ts` active-quote list | A field edit on a leg under review free-paths instead of raising a change order. |
| `NegotiateDialog.tsx` `buildCandidates` | The selected forwarder becomes ineligible for negotiation. |
| `LegSection.tsx` `LEG_STATUS_BADGE` | Falls back to rendering the raw enum string to the forwarder. |

### 4.4 Rollup guard

`LegQuoteProjector.recomputeLeg` fires `QUOTE_FULL` whenever every quote resolves and the leg is not already `FULLY_QUOTED`. A straggler forwarder submitting or expiring while the leg sits at `PENDING_APPROVAL` would attempt an illegal edge — caught and logged, so nothing corrupts, but **the leg would silently never become approvable**. The projector must skip legs in `PENDING_APPROVAL` and `APPROVED`.

Beneficial side effect: with that skip in place, the delicate fire-ordering comment in `approve()` becomes unnecessary — quote-then-leg is uniformly safe for both approve and reject.

### 4.5 Query

**Unchanged.** `PENDING_APPROVAL` maps to `QueryStatus.QUOTED`. Register item **A5** — that a query reads plain "Quoted" from RFQ response through to full approval — remains open and out of scope here.

## 5 · The compare screen

| # | Item | Resolution |
| :-- | :-- | :-- |
| 1 | Column order | `METRICS` reordered to Total (native) · Rate (per USD) · Total (USD) · Transit · Valid until. Single-sourced, so both orientations follow. Variant leads, Status trails. |
| 2 | Recommended marker | `★` next to the variant, carrying the recommendation reason as its accessible name; footnote under the table; tint retained; the Status-cell badge removed. |
| 3 | Actions below the table | `Negotiate…` and `Send for approval…` move under the grid. The send dialog lists every priced offer with forwarder, variant and Total (USD), single-select, reason mandatory only when the pick is not the recommendation. |
| 4 | Negotiate dialog | Already delivered (S5.7 T5). Only the trigger moves. |
| 5 | Forwarder column | Dropped. Rows view gains a full-width forwarder band row above each forwarder's variants. Columns view already carries the name as a `colSpan` header. |
| 6 | Selected-offer visibility | Falls out of D2 — the selected offer's Status cell reads "Pending approval" while every other reads "Quoted". |
| 7 | Approved/locked messaging | Both `MakerPanel` messages become tooltips on the leg header's decision chip. The rejection alert **stays visible** — it is the maker's only cue to rework. |
| 8 | Leg status | D1. |
| 9 | Rejection restarts the cycle | Already true of the decision; D4 adds the leg-status half. |

Both grid orientations are retained (product owner's call).

## 6 · Consequences accepted

1. **D8 persists a bearer credential in plaintext.** Justified because `MessageLog` already does, so nothing newly exposed. **Separately actionable, and recommended:** the `MessageLog` plaintext is worth its own security decision — anyone with read access to that table currently holds a working portal link for every RFQ ever sent. Not in this sub-build's scope.
2. **Legacy RFQs have no stored raw token.** Rows predating D8 render the re-quote email without a link and instead direct the forwarder to their original RFQ email. Optional backfill from `MessageLog.tokens` is possible and deliberately not attempted here.
3. **A superseded link stays dead after Regenerate.** That remains the point of Regenerate. Only the automatic rotation is removed.
4. **Re-quote still resets the shared RFQ deadline** for every leg that forwarder holds open on the query (decision D-A, unchanged).
5. **Multi-forwarder negotiate is still not atomic** (register B4). Untouched here.

## 7 · Open items unchanged by this sub-build

Register items **A1–A4**, **B4–B6**, **C1–C7** in `docs/Stage 5 - Session Handoff.md` are unaffected. **B1, B2, B3** are closed by D5/D6. **A5** remains open by choice.
