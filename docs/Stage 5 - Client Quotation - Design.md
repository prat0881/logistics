# Stage 5 · Client Quotation — Design

_Design of record for the client-facing quotation, requested 2026-08-18. Builds on S5.1–S5.7 (`feat/stage-5-fx-master`, PR #52)._

Parent design: [Stage 5 - Compare Quotes - Design.md](Stage%205%20-%20Compare%20Quotes%20-%20Design.md).
Implementation plan: [docs/plans/stage-5/Stage 5 - S5.8 - Client Quotation - Implementation Plan.md](plans/stage-5/Stage%205%20-%20S5.8%20-%20Client%20Quotation%20-%20Implementation%20Plan.md).

## Goal

Once every leg is approved and the award is frozen, an internal user prices the shipment for the client: apply a margin, adjust individual charges where needed, preview the email, and issue it. The query then moves to `AWAITING_CLIENT_DECISION`.

## ⚠ Deliberate scope change

The Stage 5 design explicitly excludes this: *"Stage 5 ends at award/approval. It does not build the client-facing quotation document, apply margin/markup, or send anything to the client."* — and lists **"Client quotation document / PDF; margin/markup model"** as out of scope, deferred to Stage 6.

The requester has pulled it into Stage 5 (2026-08-18: *"We will finish all the quotations in Stage 5"*). This document supersedes that exclusion. The remaining Stage-6 items (`Won` / `Lost` / `Closed` drivers, FF award notifications) stay out.

## Decisions (2026-08-18)

| Question | Decision |
| :-- | :-- |
| What does "margin %" mean? | **Markup on cost** — `client = cost × (1 + margin/100)`. Not `cost ÷ (1 − margin)`. |
| What does it apply to? | **One margin per quotation, applied to every charge line.** |
| Hand-edited charges? | An edit **pins that line as an override**. Changing the margin recalculates every line *except* pinned ones. "Reset overrides" releases them. |
| What does the client receive? | **Grand total only** — no charge lines, no per-leg totals. The email body is the entire deliverable. |
| Attachment / PDF? | **None.** Removed by the decision above. |
| Saved or transient? | **Saved draft, versioned on each issue** (v1, v2 …). |
| Currency | **USD.** Everything is already USD-normalised; multi-currency client billing stays out of scope. |
| Client-facing content | The client's **own enquiry particulars** echoed back — their reference tags, shipment description, vessel/IMO, port of call, ETA/ETD, cargo, ready date. **Not** our route or scope. |
| RBAC | **Manager+** to build, price and issue — matching the existing gate on "generate client quotation" (§16 O4). |

## The pricing model

A pure function in `@svyft/shared`, no Nest and no Prisma, unit-tested in isolation:

```
clientAmount(costUsd, marginPct)        = round2(costUsd × (1 + marginPct / 100))
lineAmount(line, marginPct)             = line.override ?? clientAmount(line.costUsd, marginPct)
groupTotal / legTotal / grandTotal      = round2(Σ children)
```

Rounding is to cents at **each** line, then summed — and totals are re-rounded after summing, the same guard S5.4 applied to `combinedUsd` (three individually-rounded lines can sum to a float artifact). Group and leg totals are always the sum of their children, so an overridden line rolls up correctly without special-casing.

`marginPct` accepts one decimal place, `0 ≤ m ≤ 100`. Overrides are absolute USD amounts, `≥ 0`.

## Where the charges come from

This is the part that does not exist yet. The itemised charges live in each **winning quote's** `draftJson` (`charges[]` with `zone`/`label`/`amount`/`note`, `trucking[]`, `seaRates[]`, `warehouse[]`) but `computeQuoteTotals` collapses them to three sums before anything reads them — recorded as **consequence C2** of S5.7.

The quotation reads the winning quotes **server-side and directly**, so this is a new read path rather than a change to the comparison read model. C2 stays open for the compare screen; this design does not close it.

A new pure grouping function in `@svyft/shared` turns one quote's `draftJson` + its winning variant into ordered, labelled cost lines grouped by journey stage — **Origin → Freight → Destination → Warehouse** — each converted to USD with the rate frozen in `Query.awardSnapshot`. Grouping by journey stage matches how the forwarder portal collects charges and is the grouping the compare-screen work deferred; adopting it here sets the precedent.

**Cost is frozen, not live.** Amounts come from the awarded quotes and the snapshot's `unitsPerUsd`, so a later FX-rate change cannot move a quotation that has already been priced.

## Data model

One new table. No change to `Query`, `Leg`, `Quote` or `LegAwardDecision`.

```prisma
model Quotation {
  id              String   @id @default(uuid()) @db.Uuid
  tenantId        String?  @db.Uuid
  queryId         String   @db.Uuid
  version         Int
  status          QuotationStatus @default(DRAFT)   // DRAFT | ISSUED | SUPERSEDED
  marginPct       Decimal  @db.Decimal(5,2)
  draftJson       Json                               // lines + overrides, editable
  issuedSnapshot  Json?                              // frozen at issue
  costTotalUsd    Decimal  @db.Decimal(14,2)
  clientTotalUsd  Decimal  @db.Decimal(14,2)
  recipientEmail  String?
  subject         String?
  bodyText        String?
  issuedAt        DateTime?
  issuedByUserId  String?  @db.Uuid
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([queryId, version])
  @@index([queryId, status])
}
```

`draftJson` mirrors the established `Quote.draftJson` / `Query.awardSnapshot` convention — the editable document is one JSON column rather than a second table, and issuing freezes a separate immutable snapshot. Only one `DRAFT` may exist per query at a time.

## Screens

**`/queries/:id/quotation` — the builder** (internal, Manager+). Reuses `QueryOverviewHeader` and `RouteDiagram`. A sticky commercial bar carries the margin input alongside live forwarder cost, client price and margin value. Below it, one section per leg naming the winning forwarder, with the charge table grouped by journey stage: **forwarder cost** muted on the left, **client price** editable on the right. Overridden lines are visually pinned and badged. Groups collapse by default; leg and grand totals follow.

**The preview** — a dialog showing the composed email exactly as the client receives it: envelope on the left (recipient prefilled from the query contact, editable; subject; version), letter on the right. The letter carries the client's own enquiry particulars and one number. **The two screens are deliberately opposite** — the builder is dense and operational, the preview is a letter with no controls inside it. If the preview ever grows tables, the client-detail decision has silently changed.

**Withheld from the client, by design:** charge lines, per-leg totals, forwarder cost, margin, **forwarder names** (naming our suppliers invites disintermediation), and our route/scope description.

## Issuing

`POST /api/queries/:id/quotation/issue` (Manager+) in one transaction: freeze `issuedSnapshot`, stamp `status = ISSUED` with `issuedAt`/`issuedByUserId`, compose a `MessageLog` row through the existing `MessageTemplateService` under a new `quotation.issued.email` template, and fire the `awaitingClientDecision` milestone so `QueryStatusProjector` rolls the query to `AWAITING_CLIENT_DECISION`.

That milestone is currently declared but never passed — this is what wires it up. It is sourced the same way `quotingClient` is: from a persisted fact (an `ISSUED` quotation exists for the query), never a hand-written status.

Revising: **Revise** clones the latest `ISSUED` version into a new `DRAFT` at `version + 1`, carrying its margin and overrides. Issued versions are immutable.

## Interaction with reopen

Reopening the comparison clears `Query.awardSnapshot`, so the cost basis a quotation was priced from disappears. Rule: reopening **discards any `DRAFT` quotation** (it can no longer be priced) and marks every `ISSUED` version `SUPERSEDED`, leaving them intact for audit. The query falls back to `QUOTED` via the existing projection. A new quotation starts fresh once the award is re-frozen.

## Consequences

**Q1 — nothing is actually delivered.** `comms/transport.ts` is a `LogTransport` whose `send()` is an explicit no-op: *"the message row IS the deliverable; nothing is transmitted… until `SmtpTransport` lands at the go-live gate."* Issuing composes and records the email and advances the status; **no email reaches the client** until SMTP lands. This is a pre-existing go-live gate, not introduced here — but "Send to client" must not claim more than it does, so the UI says **"Issue quotation"** and states that delivery is pending.

**Q2 — quotation validity has no source.** The letter shows a "valid until" date. No such field exists on the query or the award. Proposed: the **earliest `validUntil` across the winning quotes**, which is the date our own cost basis expires — never promising the client longer than the forwarders promised us. Confirm with the business before build.

**Q3 — a client question about composition is a manual reply.** Following from "grand total only". Revisit if it generates support load.

## Built — S5.8 (2026-08-19)

Delivered on `feat/stage-5-fx-master`, commits `05d137b..b54a3ef` (9). Six SDD tasks, per-task reviews with fix loops, an opus whole-sub-build review, and one fix wave. `pnpm run ci` green: shared 383 · web 768 · api 91 suites / 408 tests.

**What the broad review caught that the task-scoped ones could not** — worth recording, because all three were invisible within a single task's diff:
- **Heavy-weight-calc charges priced at $0.** `HEAVY_WEIGHT_CALC` lines carry a null `amount`; their value comes from `effectiveChargeAmount()`, which `computeQuoteTotals` uses and this new read path did not. The client would have been **quoted below our own cost**, silently — nothing reconciles quotation cost against `awardSnapshot.combinedUsd`.
- **The builder had no entry point.** `awardEnabled` was never passed by `CompareQuotesPage` or `QueryWorkspaceHub`, so the Award step rendered as dead and the screen was reachable only by typing the URL. The fix wave found the same defect one line over: `quotesEnabled` was missing on the hub too, leaving Compare Quotes equally dead there.
- **Reopen → re-award → open builder was a permanent 409**, because `version: 1` was hardcoded against a `@@unique([queryId, version])`. The design promised the opposite ("a new quotation starts fresh once the award is re-frozen").

Two more worth knowing: the UI's pin semantics **contradicted the server's** (value comparison vs key presence), so a pinned line could be silently unpinned by clicking in and tabbing out — and the test suite encoded that divergence as required. And the client letter printed dangling labels (`Vessel: `, `Your reference: `) for every absent optional field, on the sub-build's entire deliverable.

**One policy note that survives the go-live SMTP gate:** the commercial rule is enforced in the body by server-side template rendering — there is no path by which charge lines, cost, margin or forwarder names reach it. The **subject** remains caller-supplied free text. That is this design's own envelope-editable decision, made by an authorised Manager, so it is a policy choice rather than a hole — but it is the only one.

## Testing

- Pricing and grouping are pure functions in `@svyft/shared` — unit-tested directly, including the override/recalculate interaction and the sum-then-re-round guard.
- API e2e for issue: version increments, `issuedSnapshot` frozen, status rolls to `AWAITING_CLIENT_DECISION`, RBAC (Executive → 403), reopen supersedes.
- Web: builder recalculation, override pinning and release, preview content, and — per the S5.6/S5.7 history — **every absence assertion mutation-proven**, with both roles tested where a role gate exists.
- Full `pnpm run ci` on the final task.

## Out of scope

PDF generation; itemised client documents; multi-currency client billing; `Won`/`Lost`/`Closed` drivers; FF award notifications; SMTP delivery (Q1); closing C2 for the compare screen.
