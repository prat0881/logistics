# Stage 5 — S5.9.5 — Approval Freeze & Compare Screen Round 4 — Design of record

_Branch `feat/stage-5-fx-master` (PR #52). Written 2026-08-26, from a product-owner round of
five points, then seven business-backed points that superseded parts of the first round._

## Why this sub-build exists

Two problems, discovered in that order.

1. **An approved forwarder disappears from the compare screen.** `COMPARABLE_STATUSES`
   (`comparison.service.ts`) excludes `APPROVED`, so the winning quote drops out of `leg.offers`
   the instant a checker approves it. This is the identical defect S5.9 already fixed once for
   `PENDING_APPROVAL` — its own comment says so ("without it here the selected offer would vanish
   from the grid the instant it's sent for approval, **exactly as APPROVED once did before this
   fix**"). It was fixed for the send step and left broken for the approve step.
2. **Approval is not actually a freeze, and is not cleanly reversible.** The screen still offers
   actions on an approved leg; the server still accepts several of them; and there is no
   supported way to undo a single mistaken approval before a client quotation exists.

Everything below follows from making approval a real freeze with exactly one door out, and from
showing the full field of forwarders rather than only the ones who happened to answer.

## Decisions of record

### D1 — No action on an approved leg, except Reject

Executive, Manager and Administrator alike take **no** action on a leg whose decision is
`APPROVED`. Every control is rendered **visible and disabled with a reason**, never hidden — the
user should see that the action exists and why it is unavailable. The single exception is
**Reject** (Manager/Administrator), which is how an approval is reversed (D2).

"Visible and disabled with a reason" applies to *state* rules only. **Role** rules keep hiding, as
they do today: an Executive sees no Reject at all (it has always been checker-only), and a checker
sees no Negotiate. A disabled control must be one this viewer could use in some other state, never
one their role can never reach.

**This supersedes an earlier ruling from the same session**, which said *"Negotiate should be
allowed with all the quoted options"* on an approved leg. That was confirmed once and then
reversed after a business discussion. A future session must not restore it as a bug fix.

### D2 — Reject reverses an approval; Reopen does not touch statuses

The original ask was "move all APPROVED forwarder statuses to QUOTED when Admin/Manager reopen the
comparison". That was **withdrawn and replaced**: `reopenComparison` leaves leg, decision and quote
statuses exactly as they are, and **Reject** is what walks a leg back.

`reject()` gains a second mode. Three cases, all of which must hold:

| Query state | Leg decision | Reject |
| :-- | :-- | :-- |
| not locked | `PENDING_APPROVAL` | allowed — existing behaviour, unchanged |
| not locked | `APPROVED` | **allowed — new**, reverses the approval |
| locked (`QUOTING_CLIENT` / `AWAITING_CLIENT_DECISION`) | either | refused until `reopen-comparison` runs (D6) |

The reversal writes: decision → `DRAFT`, quote `APPROVED → QUOTED`, leg `APPROVED →` its honest
rollup target (`FULLY_QUOTED` or `PARTIALLY_QUOTED`, chosen by the `isFullyQuotedForDecision` rule
`reject()` already uses for its `PENDING_APPROVAL` mode — so the two modes cannot disagree about
what "fully quoted" means).

**Four-eyes does not apply in `APPROVED` mode.** The Manager who approved a leg may reject it back;
undoing your own mistake is a different act from approving your own work. The existing
`SELF_APPROVAL` check on a `PENDING_APPROVAL` reject is untouched.

**Approve after a reopen needs no work.** Approve only ever exists at `PENDING_APPROVAL`, and a
reopened leg's decision is `APPROVED`, so Approve is already unavailable there. The flow is:
reject → leg falls back to Fully Quoted → Executive sends for approval again → Approve returns.

### D3 — Negotiation is Executive-only, enforced by the server

The UI has gated Negotiate to Executives since S5.9.1 (R3 — a Manager's route to a revised price is
Reject-with-a-reason). The **server never shared that rule**: `award.controller.ts`'s
`request-requote` carries no `@Roles`, so a Manager or Administrator can negotiate through the API
today. This is the same shape as register B1, already found and closed once.

`@Roles(Role.EXECUTIVE)` goes on the route. This is the first workflow write in the codebase that
**excludes** the higher roles rather than including them, and is a deliberate departure from the
RBAC convention ("workflow writes are auth-only"), not an oversight to be normalised away.

### D4 — An unanswered re-quote no longer destroys the forwarder's price

Closes register **A4**.

Today `rfq-schedule.listener.ts`'s expiry sweep selects quotes in `RFQ_SENT` **or `REQUOTED`** and
nulls `draftJson` under a comment reading "discard the unsubmitted draft". That is correct for
`RFQ_SENT` — a genuine unfinished draft — and wrong for `REQUOTED`, where `draftJson` holds the
forwarder's **already-submitted earlier price**, the only thing keeping their offer on the compare
screen. So negotiating and getting no answer destroys a real, acceptable price; doing nothing would
have kept it.

The rules:

- The sweep **keeps** `draftJson` for a `REQUOTED` quote. It still discards it for `RFQ_SENT`.
- The quote still takes its normal `REQUOTED → EXPIRED` edge. The window really did close, and the
  forwarder's silence must be visible rather than reading as still-pending forever.
- `EXPIRED` joins `COMPARABLE_STATUSES`. This is **self-limiting**: `buildLeg` already skips any
  quote with no `draftJson`, so an ordinary expired forwarder who never submitted still produces no
  priced offer — only one carrying a real submitted price does.
- `EXPIRED` joins the engine's ranking (`buildRecommendation`, currently `QUOTED`-only).
- `EXPIRED` joins `REQUOTABLE_STATUSES`, with a new quote edge
  `EXPIRED --request_requote--> REQUOTED`. Without this the forwarder is frozen out: price visible
  and approvable, portal closed, and no way to ask them again. Negotiating an expired offer reopens
  their portal with a fresh deadline — the same deliberate act that reopens a live one.
- `pendingForwarders` must **exclude any quote that produced an offer**. `EXPIRED` sits in both
  `COMPARABLE_STATUSES` and `PENDING_STATUSES` after this change, so without this the same
  forwarder renders twice — once as a priced cell, once as a "Not quoted" cell.

**Accepted consequence — the `★` will oscillate.** `buildRecommendation` ranks `QUOTED` and (now)
`EXPIRED`, but deliberately not `REQUOTED` (design §10.1: excluded from ranking until the forwarder
responds). So a forwarder loses the `★` when you negotiate and may regain it if they go silent. The
reading that makes this coherent: *while we are waiting for a better price, do not recommend the old
one; once the waiting is over and this is their final answer, rank it.* Accepted, not overlooked.
It only oscillates before a decision exists — once a leg is sent for approval, `★` reads the frozen
snapshot.

**Accepted consequence — a ranked `EXPIRED` offer may carry a `validUntil` already in the past.**
The grid shows "Valid until", so it is visible; the engine does not weigh it. Register **A1** (what
a client quotation's "valid until" means) is unchanged and still open.

**Accepted consequence — the `EXPIRED` badge now does two jobs.** See D8.

#### ⚠️ AMENDED BY S5.9.6 — D4's premise was FALSE, and the fix is a column split

Closes register **A6**.

**The false premise.** D4 above says, of a `REQUOTED` quote, that "`draftJson` holds the forwarder's
already-submitted earlier price, the only thing keeping their offer on the compare screen". Neither
half was true.

*Not their submitted price.* `FfPortalService.saveDraft` writes `draftJson` verbatim with **no
version hash and no guard beyond leg-closure and status**, and `WRITABLE_QUOTE_STATUSES` admits
`REQUOTED` on purpose — a forwarder asked to revise has to be able to type. `quoteDraftSchema`
accepts blanks deliberately, and the portal exposes *Save draft* as an ordinary button. So the
sequence that broke it needs nothing exotic: the forwarder submits 5,000 → an executive asks for a
better number → the forwarder opens the reopened portal, edits it down to 4,200 with a surcharge
still blank, hits Save draft, and goes silent → the sweep keeps that row → and **4,200 appeared on
the compare screen as a ranked, ★-recommendable, approvable offer that nobody had ever offered.**
Approve it and the client letter is priced from it. Before S5.9.5 the same half-edit existed but was
stale-badged, unranked and refused by the send guard; D4 is what made it actionable.

*And not the only thing keeping the offer visible* — that was a claim about which column the read
side happened to gate on, not about provenance, and S5.9.6 makes it plainly false.

**What the product owner chose, and what was rejected.** The ruling was **the column split**
(register A6 option (a)): `Quote.submittedJson`, written by `FfPortalService.submit` and by nothing
else. Two alternatives were on the table and were **not** taken:

- *"Retain only if untouched"* — key the sweep's retention on whether the draft moved since the
  re-quote was requested (`Quote.updatedAt` against the `REQUEST_REQUOTE` audit event). It needs no
  migration, which was its whole appeal, but it silently narrows D4: a forwarder who merely opened
  the portal and saved without changing anything loses their price, and the rule is invisible to
  everyone who did not read this paragraph. It also fixes only the sweep — the same conflation
  reaches `generateClientQuote` and the client letter by other routes.
- *A submission-history table* — one row per submitted bid, the compare screen reading the latest.
  Strictly more information (it would have made the legacy gap below recoverable), but a new table,
  a new write path and a new read model for a defect that one nullable column closes. Rejected as
  disproportionate; it remains the right shape if per-submission history is ever wanted for its own
  sake.

**What each column means now** — this is the durable half of this amendment:

| Column | Written by | Meaning | Read by |
| --- | --- | --- | --- |
| `Quote.draftJson` | `FfPortalService.saveDraft` (any writable status), and `submit` (seeded with what was just sent) | The forwarder's **scratchpad**. Their last saved state, and nothing more. May be half-typed, blank, or a revision they never sent. | The FF portal only — `resolveScope` serves it as the portal's `draft`, which is the pre-fill, preview and print view the forwarder sees. Cleared for an `RFQ_SENT` quote by the expiry sweep and by `RfqService.distribute`; cleared for a refreshing quote by the change-order re-freeze. |
| `Quote.submittedJson` | `FfPortalService.submit` **alone** | The **offer** — the whole offer: the amounts, and also the **currency** and the **validity**, both frozen from the `Rfq` row at submit time. What this forwarder actually put on the table, at the moment they put it there. | Everything that prices something a human acts on: `ComparisonService.buildLeg` (the grid — its existence gate, its numbers, its currency and its `validUntil`), `AwardService.generateClientQuote` (the winner frozen into `Query.awardSnapshot`, currency included), `QuotationService.buildInitialDraft` (the client letter's cost lines and `validUntil`), and `LIVE_QUOTE_WHERE`'s `EXPIRED` arm (whether an expired quote is a live commercial commitment). Cleared only by `RfqService.distribute`, when a quote re-enters distribution. |

**D4's *behaviour* is unchanged.** The sweep still keeps a `REQUOTED` quote's `draftJson` and still
discards an `RFQ_SENT` one's. Only the reason survives differently: retention is now about **portal
pre-fill** — a re-negotiated forwarder opens onto their previous numbers rather than a blank matrix
— and is no longer a provenance claim of any kind. Every bullet in D4 above that reads "`draftJson`"
as a stand-in for "the submitted price" should be read as `submittedJson`; the self-limiting
argument for `EXPIRED ∈ COMPARABLE_STATUSES` still holds, and holds more tightly, because the gate
it rests on is now the submission itself.

**The unit is part of the offer, not just the quantity.** The first pass of this fix moved only the
amounts and left every reader taking each offer's currency from the live `Rfq` row. That reopened the
same defect one field to the left, because `saveDraft` upserts `Rfq.currency` and
`Rfq.quoteValidityUntil` alongside the scratchpad and admits `REQUOTED`: a re-quoted forwarder could
**re-denominate** an offer they never re-submitted. Measured on the built system — submit 4,750 INR
(≈ $57.09), go `REQUOTED`, move only `Rfq.currency` to JPY, and the grid returned ¥4,750 ≈ $31.67.
`usdTotal` is what the grid ranks on and what `combinedUsd` sums, and it is a product of both halves,
so the quantity being provably submitted bought nothing on its own. `Rfq` is
`@@unique([queryId, freightForwarderId])`, so one such save moved **every** offer that forwarder held
on the query, including one already APPROVED on another leg. Both pricing readers now take
`draft.currency ?? rfq.currency` — the `Rfq` row survives only as a legacy fallback, safe because
`validateQuote` hard-blocks a submit with no currency (`Q_CURRENCY`) or no validity (`Q_VALIDITY`).
The grid's per-offer `validUntil` moved the same way, for a reason this sub-build created: once the
client letter's validity came from `submittedJson`, the two could disagree, and an executive would
have seen one validity while the client received another.

**What the fix cannot do.** For rows written *before* the migration there is no record of the
submitted price other than `draftJson`, so the backfill copied the last saved state. For a legacy
`REQUOTED` row whose draft had already been overwritten, that value is wrong and **the true
submitted price is unrecoverable** — no column and no log holds it. Rows written after the migration
are exact.

### D5 — No `Cancelled` status; the portal closes instead

The original ask was to auto-cancel outstanding RFQs on approval and show the forwarder as
"Cancelled". **Withdrawn.** No new status. Instead: once a leg has an approved forwarder, the FF
portal refuses submissions for that leg and renders it read-only with an explanation.

This lands cleanly because the portal's submit guard already accepts only `RFQ_SENT`/`REQUOTED` and
the portal UI already has read-only branches for non-submittable statuses. What is missing is a
**leg-level** guard: a forwarder whose own quote is still `RFQ_SENT` on a leg approved to someone
else can submit today.

**`PENDING_APPROVAL` does not close the portal — only `APPROVED` does.** A leg under checker
review is not yet decided, and a late submission from another forwarder merely adds an offer the
checker can see; nothing is at risk. Deliberate, so a later reader does not "tighten" it.

A structural note the implementer must respect: `Rfq` is unique on `(queryId, freightForwarderId)` —
one RFQ covers **all** of that forwarder's legs on the query. So this closes the leg, never the RFQ.
A forwarder approved on LEG-1 keeps quoting LEG-2, and their reminder timers (which are per-RFQ)
rightly keep running while LEG-2 is open.

### D6 — A locked query refuses every write except Reopen

"Locked" means `Query.awardSnapshot != null` — i.e. `QUOTING_CLIENT` or
`AWAITING_CLIENT_DECISION`. While locked, **every** write on the query is refused server-side except
the two named below. This is the wide reading, confirmed explicitly: it covers leg, cargo and query
field edits, not only the compare-screen actions.

**Two exceptions, and only two:**

1. `reopen-comparison` — the door out.
2. **Every write under `queries/:id/quotation`** (`PATCH`, `POST issue`, `POST revise`). A query is
   locked *precisely so that the client quotation can be composed and issued* — `QUOTING_CLIENT`
   only exists because `generate-client-quote` froze the snapshot, and `AWAITING_CLIENT_DECISION`
   is reached *by* issuing. Blocking these would make the lock forbid the only work the locked
   state exists to allow. **This exception was missed in the first draft of this design and caught
   while enumerating the endpoints; it is not optional.**

The FF portal needs no exception: a locked query has every leg `APPROVED`, and D5 already closes an
approved leg's portal.

**CORRECTION, found during Task 5 (2026-08-27).** This section originally argued that the
`QUOTING_CLIENT` teardown in `award-change-order.listener.ts` "must stay — it fires from a field
edit, which is a different entry point". That reasoning is **wrong**: a field edit is precisely what
D6 now refuses on a locked query, so the change-order cascade can no longer reach a query with a
frozen snapshot, and the listener's `awardSnapshot != null` teardown branch is unreachable. It is
KEPT anyway — deleting it is a behaviour change nobody has ruled on, and it costs nothing standing —
but it is now dead code with no e2e coverage, and no comment anywhere may claim it fires. Recorded
so a later reader does not "restore" reachability by relaxing the lock, and so the dead branch is
removed deliberately rather than discovered.

Consequences, both accepted:

- The `QUOTING_CLIENT` teardown inside `negotiation.service.ts` (built by S5.9's whole-branch review)
  becomes unreachable from that entry point. **The identical teardown in
  `award-change-order.listener.ts` must stay** — it fires from a field edit, which is a different
  entry point, and removing it would strand a locked query with a stale snapshot.
- A user correcting a mistake must reopen explicitly rather than discovering their client quotation
  silently torn down by an edit. This is the more honest failure.

No shared lock guard exists today — five sites check `awardSnapshot` ad hoc. One is introduced and
used everywhere. **The first job of the implementing task is enumerating every write reachable for a
query**; that list is not guessed here.

`reopen-comparison` also gains:

- `@Roles(Role.ADMINISTRATOR, Role.MANAGER)` — it has none today, so an Executive can reopen.
- A **required reason**, collected in a dialog (same shape as `RejectDialog`'s required reason) and
  stored on the per-leg `REOPEN` audit event `reopenComparison` already writes.

### D7 — Every forwarder at RFQ_SENT and beyond appears in the table

`pendingForwarders` stops rendering as an "Awaiting response" list below the grid and becomes real
cells **in** it — status "Not quoted", every metric an em-dash. `SELECT` (not yet distributed) stays
excluded. The `awaitingReQuote` warning below the grid is a different thing and stays.

This is done in the **frontend row model**, not by synthesising `OfferDto` rows server-side.
`SendForApprovalDialog` and `NegotiateDialog` both build their lists from `leg.offers` directly, so
keeping the synthesis out of the DTO makes it structurally impossible for a non-quoting forwarder to
appear in anything actionable.

`OfferCell` becomes a discriminated union (`{kind: "offer"}` | `{kind: "pending"}`) rather than
gaining a nullable `offer` field, so TypeScript forces both grid orientations to handle the new case
instead of letting a missed site compile and render `undefined`.

### D8 — `APPROVED` becomes comparable, and the approved offer is marked

`COMPARABLE_STATUSES` gains `APPROVED`. The approved offer gets its own mark and tint, which
**replaces** the `⚑` sent-for-approval mark on that cell (the two are mutually exclusive by the
decision-status gate, so this falls out of the model rather than needing a precedence rule). `★`
recommended stays independent and may coexist.

Both new marks read `leg.decision` directly — never `offer.quoteStatus`. The existing doc comment on
`OfferCell.sentForApproval` records a live case where those two drifted apart, and that rule holds
here for the same reason.

**Comments that must be re-traced, not reworded.** At least five places reason *from* `APPROVED`
being excluded, and each states a conclusion that this change may or may not preserve:
`PENDING_STATUSES`' own comment; `buildComparisonRowModel`'s `locked` rationale (its **conclusion
stays correct** — `buildRecommendation` still does not rank `APPROVED` — but its stated cause becomes
false); `QuotingClientPanel.test.tsx`'s forwarder-lookup note; `NegotiateDialog`'s "APPROVED is
eligible" branch, which stops being dead code; and `award.ts:106`/`:134`. Trace each before writing.

**One thing to prove, not assume:** whether an `APPROVED` quote can coexist with a `DRAFT` decision
(via `reopenComparison`, or the `UNAPPROVE` edge). If it can, `SendForApprovalDialog` would begin
listing an approved offer as sendable. Establish reachability from the code before deciding whether a
guard is needed. No guard written on speculation; no absence claimed without proof.

## No new statuses anywhere

Deliberate and worth stating plainly, because the original points implied several.

| Vocabulary | New values |
| :-- | :-- |
| `QuoteStatus` (forwarder) | **none** — dropping `Cancelled` (D5) removed the only candidate. `CLOSED` stays unreachable; register C4 unchanged on that line. |
| `LegStatus` | **none** — a reversed approval lands on existing `FULLY_QUOTED`/`PARTIALLY_QUOTED`. |
| `QueryStatus` | **none** — derived projection; both locked states already exist. |

What is new lives one level down:

- **Two leg machine edges**, reusing existing events: `APPROVED --return.full--> FULLY_QUOTED` and
  `APPROVED --return.partial--> PARTIALLY_QUOTED`. These mirror the pair already running from
  `PENDING_APPROVAL`, and let `reject()`'s existing shape work unchanged.
  *Rejected alternative:* reusing `REOPEN_AWARD` plus the re-quote rollup recompute, the way
  `negotiation.service.ts` does. `REQUOTE_PARTIAL`/`REQUOTE_OUTSTANDING` are documented as fireable
  **only** by the projector's re-quote branch; borrowing them for a reject would break that stated
  rule and make the `StatusTransition` log ambiguous about what happened.
- **One quote machine edge**, reusing an existing event: `EXPIRED --request_requote--> REQUOTED` (D4).
- **`UNAPPROVE` (`APPROVED → QUOTED`) is fired for the first time.** The event and its edge already
  exist and are already registered; nothing has ever reached them until now.

## Where `Expired` appears on the compare screen

Exactly two scenarios after this sub-build. `EXPIRED` is written in one place only — the expiry
sweep — reachable from two source states.

| Scenario | Path | Draft | Renders as |
| :-- | :-- | :-- | :-- |
| **A** | RFQ sent, forwarder never submitted, deadline passed | discarded | "Not quoted" cell, Expired badge, metrics em-dashed |
| **B** | Quoted → negotiated → silent, deadline passed | **kept** | Priced cell — real total, transit, valid-until — Expired badge, rankable and approvable |

A already happens today (in the list below the table; D7 moves it into the table). **B is the only
new scenario.** A third machine path, `APPROVED → REQUOTED → EXPIRED`, is left *practically*
unreachable by D1 — but not unreachable, and an earlier draft of this line claimed it was.
**CORRECTED (final whole-branch review).** D1's guard reads the leg's `LegAwardDecision`, while the
`APPROVED --request_requote--> REQUOTED` edge is reached off the QUOTE's own status via
`REQUOTABLE_STATUSES`. In the drifted `decision = DRAFT` / `leg = APPROVED` / `quote = APPROVED`
shape that register **C12** records, the guard passes and that path runs. Rows in that shape —
whether they arrive that way or already sit that way in production — render like B.

Nothing else produces `Expired`. It is a quote-level status only — no leg and no query ever shows it.

**Presence of a price is the only thing distinguishing A from B.** Accepted as legible. If a later
review finds it isn't, a display-only distinction is cheap and needs no schema change.

## Vocabulary check (D5 of the Stage-5 handoff)

Nothing here introduces a user-visible "Awarded". "Approved" stays provisional and — after this
sub-build — genuinely reversible, which strengthens rather than weakens that decision. The
disabled Award rail step is untouched.

## Register impact

- **A3** (*is Reopen actionable?*) — **closed**. It is: reopen unlocks the query, then Reject walks
  the leg back. D2's per-leg reject also removes the dead end that made A3 sharp.
- **A4** (*should the earlier price survive an unanswered re-quote?*) — **closed by D4**. Yes, and it
  stays re-negotiable.
- **C4** (*unreachable enum values*) — amended: `EXPIRED` becomes a comparable, rankable status;
  `AWAITING_CLIENT_DECISION` becomes write-gating. `CLOSED` on the quote remains unreachable.
- **B1** — a second instance of its shape (UI-only rule the server never shared) is closed by D3.
- **C8** (*the forwarder portal link leaks via `GET /api/queries/:id/emails`*) — **untouched and still
  open**, deliberately deferred to its own trip.

## Non-goals

- Register **C8**, **B4**, **B5**, **B6**, **C1**, **C3**, **C5**, **C6**, **C9** — all unchanged.
- Backfilling production rows already in a pre-S5.9.5 shape.
- Any change to the client quotation builder or the Stage-6 award vocabulary.
