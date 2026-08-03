# Stage 4 · Sub-build 6 — Change-Order Cascade — Design

> **Status:** design of record (brainstorm complete, 2026-08-03). The last remaining Stage-4 sub-build; a prerequisite for Stage 5 (Quote Comparison & Award). Realises the change-order path that Stage 3 reserved but never activated (spec §11; Technical Design §7.2).
>
> **Sources:** Functional Spec §11 (Change-Impact Handling), §9.1/§9.2 (statuses), §7.2 (change-order UX); Technical Design §7.1–§7.4; the Stage-3 Extensibility Core (`changes`/`status` modules). Where this doc and the older docs disagree, **this doc + `main` win** — two "already declared" claims in the TD are not backed by code (§8 below).
>
> **Implementation plan:** to be written next under `docs/plans/stage-4/Stage 4 - Sub-build 6 - Change-Order Cascade - Implementation Plan.md`.

---

## 1. Purpose & scope

When an Executive edits a Stage-3 field (leg, cargo, point, query aggregate) **after** an RFQ has been sent for that leg, the freight forwarders have already priced against the old data. SB6 makes that safe: an **RFQ-defining or Structural** edit to a **distributed** leg no longer applies silently — it runs a **change-order cascade** (preview → confirm + reason → apply → invalidate affected quotes → reopen the leg → record → notify → the Executive re-distributes).

**In scope:** the cascade mechanics for RFQ-defining and Structural changes on legs at `RFQ_SENT` / `PARTIALLY_QUOTED` / `FULLY_QUOTED`; a durable, generic `ChangeLog`; the status **reopen** edges; the scope-resolution the cascade needs.

**Out of scope (see §20):** a universal field-level audit trail; the maker-checker **approval flow** (a separate, deferred requirement — §19); a full quote-revision history table.

---

## 2. Background — the Stage-3 Extensibility Core (what SB6 extends)

Every user-editable mutation already flows through **one door**, `ChangeMediator.apply(req, uow)` ([change-mediator.ts:18](apps/api/src/modules/changes/change-mediator.ts)). Verified call sites: `cargo`, `legs`, `queries`, `points` services. The mediator today:

```
apply(req, uow):
  1. classify(req)          → { impactClass, scope }     [ImpactClassifier]
  2. downstreamWork(scope)  → boolean                     [ScopeResolver]   ← seam #1
  3. decidePath(class, hasDownstream) → "free" | "change-order"   [shared]
  4. fork → FreePathStrategy.run  |  ChangeOrderStrategy.run                 ← seam #2
```

`decidePath` ([change.ts:47](packages/shared/src/change.ts)) returns `change-order` iff **`IMPACT_RANK[class] ≥ RfqDefining` AND `hasDownstreamWork`**.

**Why nothing cascades today:** `ScopeResolver.downstreamWork` is hard-coded `false` ([scope.resolver.ts:9](apps/api/src/modules/changes/scope.resolver.ts)), so `decidePath` always returns `free`; `ChangeOrderStrategy.run` throws ([change-order.strategy.ts:17](apps/api/src/modules/changes/change-order.strategy.ts)); and the change-log sink is a no-op ([change-log.ts](apps/api/src/modules/changes/change-log.ts)). The classification is *computed on every edit but discarded* — its one live effect today is an **editable-field allow-list** (`ImpactRegistry.highestImpactField` throws `400 "Field 'x' is not editable"`, [impact.registry.ts:27](apps/api/src/modules/changes/impact.registry.ts)).

**Design consequence:** the framework was built ahead of need. SB6 is an **activation, not a retrofit** — flip two switches (`downstreamWork`, the log sink) and implement one strategy; the ~10 call sites are untouched.

---

## 3. Design principle — zero Stage-3 edits, activate reserved seams

SB6 touches **no existing Stage-3 behaviour file**. It is: three provider overrides, a `contribute()` of status edges, one new `declare()`, a classifier scope extension, and one new table.

| # | Seam | Today | SB6 |
|---|------|-------|-----|
| 1 | `ScopeResolver.downstreamWork(scope)` | `return false` | *"do any live quotes reference these legs?"* |
| 2 | `ChangeOrderStrategy.run()` | `throw` | the saga (§7) |
| 3 | `CHANGE_LOG` provider | `NoopChangeLog` | `PrismaChangeLog` (§10) |
| 4 | Leg status edges | only `READY_FOR_RFQ→DRAFT` reopen | `contribute()` the `RFQ_SENT+→READY_FOR_RFQ` reopen edges (§8) |
| 5 | Quote status edges | `QUOTED→INVALID` exists | `contribute()` the `INVALID→RFQ_SENT` reactivation edge (§8) |
| 6 | Impact maps | query/cargo/leg/point declared | add `quotes` map; re-confirm the rest (§4) |
| 7 | Classifier scope | fans `cargo→legs` only | also `point→endpoint-legs`, `query→all-legs`, `quote→its-leg` (§5) |

---

## 4. Impact classification (the rules for *what* cascades)

"What produces a change-order (and a `ChangeLog` row)" = a field/action whose class is **RfqDefining or heavier**, on a **distributed** leg. The rule table is the declarative per-entity **impact maps** — `Record<keyof <Entity>SaveInput | "@create" | "@delete", ImpactClass>` — registered via `ImpactRegistry.declare` in each module's `onModuleInit`. The type forces a class for **every** schema field (compile error otherwise), so the rules can never silently go stale as the schema grows.

**The basis for a field's class** — one litmus question: *"Would an FF who already priced this leg have to re-quote if this field changed?"*

| Class (rank) | Litmus | Path when distributed |
|---|---|---|
| Internal (0) | FF never sees it (ops data) | free |
| Corrective (1) | FF sees it but wouldn't re-price (a label) | free |
| RfqDefining (2) | FF would re-price (a physical/commercial fact they bid on) | **change-order** |
| PricingAwardDefining (3) | the FF's *own* price/density/transit | free (Stage-5 concern; portal-side, never hits the mediator) |
| Structural (4) | changes what exists (rows/legs/FF coverage) | **change-order** |

> **`decidePath` invariant (careful point):** `PricingAwardDefining` outranks `RfqDefining` in `IMPACT_RANK` ([change.ts:15](packages/shared/src/change.ts)), so `decidePath` *would* fork it to change-order if it ever reached the mediator. It never does — the FF's price/density/transit are edited only through the FF portal (`ff-portal.service`), never `ChangeMediator`. This **architectural invariant** (not the rank) is what keeps Quote-defining edits always-free per spec §11.2. Consequence: SB6 needs **no edit to `decidePath`** (a Stage-3 file). If FF pricing edits are ever mediated, tighten the fork to `RfqDefining || Structural` explicitly at that point.

**Why "visibility ≠ RfqDefining":** several fields are *in* the frozen manifest yet Corrective (labels, not price drivers) — `legName`, `poReference`, `productName`, `hsCode`. The class tracks *pricing dependence*, not visibility.

**Current maps (to re-confirm against §11.1 as an SB6 task — Plan-8 item E):**
- **query** ([query.impact.ts](apps/api/src/modules/queries/query.impact.ts)) — RfqDefining: `clientId · incoterms · dgIndicator · readyDate · targetDelivery`; everything else Internal/Corrective.
- **cargo** ([cargo.impact.ts](apps/api/src/modules/cargo/cargo.impact.ts)) — RfqDefining: `packageType · isDangerous · qty · dimL/W/H · netWt · grossWt · dimUnit · weightUnit`; Structural: `@create/@delete`; Corrective: `poReference · productName · referenceTags · hsCode · msdsFileId`.
- **leg** ([leg.impact.ts](apps/api/src/modules/legs/leg.impact.ts)) — RfqDefining: `originPointId · destinationPointId · mode · readyDate · targetDelivery`; Structural: `assignedCargoIds · @create/@delete`; Corrective: `legName`.
- **point** ([point.impact.ts](apps/api/src/modules/points/point.impact.ts)) — RfqDefining: `type · streetAddress · city · postalCode · country · iataCode · unLocode · timezone`; Corrective: `name · contact* · warehouseType · icaoCode · terminal`.

**New — `quotes` map (SB6):** `@delete` (remove an FF from a sent leg) = **Structural**; `@create` (add an FF) = **free** (a new distribution, invalidates nothing); the FF's own `price/density/transit` = **PricingAwardDefining** (documentary — those edits are portal-side via `ff-portal.service`, never routed through the mediator, so they are free by construction).

**Multi-field PATCH rule:** a request touching several fields is classified by its **highest-impact field** (`highestImpactField`), so `legName + mode` together → RfqDefining → change-order.

---

## 5. Blast-radius scope resolution (the rules for *which* legs)

**The leg is the biddable unit**, and each distributed leg has a frozen `Quote.manifestSnapshot` — the exact data the FF priced against. So **scope = the leg(s) whose manifest this field feeds**, honouring §11.3 *minimal blast radius*:

| Edited entity | Scope (affected legs) | Reason |
|---|---|---|
| cargo | legs carrying that row (`LegCargo`) | a leg's manifest holds only its assigned cargo |
| leg | that leg | self |
| point | legs using it as origin/destination | manifest embeds endpoint data |
| quote (remove FF) | the quote's leg | the removal targets one (leg, FF) |
| query (`incoterms`, `dgIndicator`) | **all** its legs | query-wide field, in every manifest |

**Code reality + the gap to close:** the classifier ([impact.classifier.ts:29](apps/api/src/modules/changes/impact.classifier.ts)) today fans **cargo→legs** only (`routing.legsCarryingCargo` → `LegCargo`, [routing.service.ts:91](apps/api/src/modules/routing/routing.service.ts)); for point/query/quote it returns *self* scope. **SB6 extends the classifier** so scope is *always* leg-typed before the downstream check — adding `point→endpoint-legs`, `query→all-legs`, `quote→its-leg`. *Why here, not in the resolver:* keeping the fan-out in the classifier means `ScopeResolver.downstreamWork` and the strategy both receive a uniform "list of affected legs," mirroring the existing cargo precedent.

**Rule 1 — downstream predicate (SB6's `ScopeResolver` override):**
> `downstreamWork(scope)` = TRUE iff ∃ `Quote` where `legId ∈ scope-legs` AND `status ∈ {RFQ_SENT, QUOTED}`.

**Why `{RFQ_SENT, QUOTED}` and not "non-INVALID":** `SELECT` was never sent; `INVALID` is already dead; `EXPIRED` is terminal (re-notifying an expired FF on an edit adds noise, no value). Only *live, distributed* quotes gate the cascade. *(This narrows the TD's looser "non-INVALID at RFQ_SENT+" wording — a deliberate call.)*

**Rule 2 — affected-quote partition (what to *do* per leg in scope):**
- `QUOTED` (submitted) → **INVALIDATE** (must re-quote).
- `RFQ_SENT` (pending) → **manifest refreshed in place** (still open).
- `EXPIRED` / `INVALID` → **skip**.

Mirrors the existing `freshQuotes`/`sentQuotes` split in [leg-context.ts:35](apps/api/src/modules/rfq/leg-context.ts).

**Rule 3 — invariants (§11.3):** minimal (only touched legs); **Quote-scoped, not Rfq-scoped** (an FF's quotes on *other* legs of the same RFQ are untouched); **non-destructive** (mark `INVALID`, never `DELETE`).

---

## 6. The two paths & the fork

Unchanged from `decidePath`; SB6 only makes the downstream input real:

| Condition | Path |
|---|---|
| class < RfqDefining (Internal/Corrective/PricingAwardDefining), **or** no live downstream quote on the scope legs | **Free** — apply, revalidate, done (today's behaviour). |
| **RfqDefining or Structural** change to a leg with a live (`RFQ_SENT`/`QUOTED`) quote | **Change-order** — the saga (§7). |

---

## 7. The change-order saga (`ChangeOrderStrategy.run`)

A **two-phase** interaction mapped onto the *single-shot* mediator by branching on `req.reason` — **the mediator stays unchanged** (TD §7.2 insists on this):

**Phase 1 — Preview (no `reason` on the request):**
Compute the affected scope (touched legs × their `{RFQ_SENT, QUOTED}` quotes); **apply nothing**; return a preview. The service surfaces it as **`409 { needsChangeOrder: true, preview }`**. The client (`ImpactPreviewDialog`, spec §9.4) shows what will break + a mandatory reason box.
*Why 409 + re-PATCH:* reuses the SB2b F6 dup-guard idiom (`409` → confirm-re-distribute) and SB3's confirm pattern — no new endpoint, mediator untouched.

**Phase 2 — Confirm (client re-sends the same PATCH **with** `reason`):**
```
tx1 (one $transaction):
  a  read the to-be-invalidated (QUOTED) quotes' pricing  → for the ChangeLog snapshot (§11)
  b  uow(tx)                          apply the field edit (same uow the free path would run)
  c  re-freeze manifestSnapshot on each PENDING (RFQ_SENT) quote from the new data
                                      (buildManifestSnapshot reads Leg/LegCargo/CargoItem/Point/Query)
  d  changeLog.record(entry)          the durable what/why/consequence (§10)
— after tx1 commits, via StatusService.fire (each owns its own tx — Prisma cannot nest) —
  e  fire('quote', qId, INVALIDATE)   per submitted quote → StatusTransition + Quote.status=INVALID
  f  fire('leg', legId, REOPEN)       RFQ_SENT/…→ READY_FOR_RFQ → StatusTransition + Leg.status
  g  projector recomputes Query.status (free — @OnEvent leg.status.changed)
  h  dispatch("rfq.leg.reopened", …)  compose-&-log to the INVALIDATED FF(s) + Executive; pending
                                      FFs are refreshed silently, re-notified at re-distribute (§11.4/§15)
→ Executive manually re-distributes the leg (existing SB2b flow + the INVALID→RFQ_SENT edge)
```

**Why the split tx (not one atomic transaction):** `StatusService.fire` opens its own `$transaction` and emits after commit ([status.service.ts:40](apps/api/src/modules/status/status.service.ts)); Prisma interactive transactions cannot nest, and the "one door" rule forbids writing `Quote.status`/`Leg.status` outside `fire`. So the *data* change + snapshot re-freeze + ChangeLog commit atomically (tx1); the *status* cascade fires after. Per spec §8.5 the system is **last-write-wins, no record locking**, so the small partial-failure window (tx1 committed, a later `fire` fails) is accepted for this build — the reopen is re-runnable and the projector is idempotent. Hardening (an outbox / saga-completion marker) is deferred with the broader concurrency work (§19).

**Re-distribute (Phase 3, existing endpoint + one new edge):** the Executive re-distributes the reopened leg; for an FF whose quote is `INVALID`, distribution **reactivates the same row** (`INVALID→RFQ_SENT`, §8) — it cannot mint a second row (the `@@unique([legId, freightForwarderId])` slot is taken), which is *why* invalidation is non-destructive rather than a delete. The manifest re-freezes, `Rfq.submissionDeadline` resets (+48h), SB5 reminders re-arm.

---

## 8. Status-machine changes (via `StatusRegistry.contribute` — no Stage-3 status file edited)

Two doc-vs-code gaps found and closed here:

- **Leg reopen — MISSING today.** The Stage-3 machine ships only `READY_FOR_RFQ --REOPEN--> DRAFT` ([leg.machine.ts:31](apps/api/src/modules/status/leg.machine.ts)); the TD's "reopen already declared" for `RFQ_SENT+` is not backed by code. SB6 `contribute("leg", …)` (as SB2a did for the forward edges, [rfq.module.ts:25](apps/api/src/modules/rfq/rfq.module.ts)):
  `RFQ_SENT | PARTIALLY_QUOTED | FULLY_QUOTED --REOPEN--> READY_FOR_RFQ`.
- **Quote `QUOTED→INVALID` — EXISTS** ([quote.machine.ts](apps/api/src/modules/rfq/quote.machine.ts), `INVALIDATE`). SB6 adds the **reactivation** edge `INVALID --SEND--> RFQ_SENT` so re-distribute can reuse the row.

The **query rollup is free** — `QueryStatusProjector` already recomputes `Query.status` from leg statuses on `leg.status.changed` and writes only the column, no `StatusTransition` ([query-status.projector.ts:32](apps/api/src/modules/status/query-status.projector.ts)).

---

## 9. Tracking model — two complementary layers

| Layer | Table | Answers | Written by |
|---|---|---|---|
| State history | `StatusTransition` (exists) | the reopen / invalidate / redistribute transitions | `StatusService.fire` |
| Change intent + consequence | **`ChangeLog`** (new) | *why this change happened & what it did to the RFQ workflow* | `ChangeOrderStrategy` |

`StatusTransition` ([schema.prisma:348](prisma/schema.prisma)) has a global `seq`, `(entity,entityId)`, `from/to/event`, `actorId`, `at` — but **no `queryId`**, so it cannot answer "what happened to *this query*" directly. `ChangeLog` carries `queryId` and *is* the per-query change index. The two are complementary, not redundant (redundancy analysis: §18).

---

## 10. `ChangeLog` — generic envelope + typed payload

Designed **generic and configurable** so it flexes to future needs without migrations, and so its overlap with a future audit trail / approval flow collapses to references rather than duplication (§18).

```prisma
model ChangeLog {
  id                String   @id @default(uuid()) @db.Uuid
  tenantId          String?  @db.Uuid
  queryId           String   @db.Uuid            // the per-query trail key
  query             Query    @relation(fields: [queryId], references: [id], onDelete: Cascade)
  entity            String                        // "cargo" | "leg" | "point" | "query" | "quotes"
  entityId          String   @db.Uuid
  changeType        String                        // "change-order" (extensible: "free-edit" | "approval-applied" …)
  actorId           String?  @db.Uuid
  at                DateTime @default(now())
  auditRefId        String?  @db.Uuid             // reserved: future AuditLog reference (§18/§19)
  approvalRequestId String?  @db.Uuid             // reserved: future ApprovalRequest reference (§18/§19)
  payload           Json                          // type-specific bits (below)
  @@index([queryId])
  @@index([entity, entityId])
}
```

**`payload` (JSON) for a change-order:**
```jsonc
{
  "field": "grossWt", "action": null,
  "impactClass": "RfqDefining",
  "from": "1000", "to": "1200",           // lightweight before/after (see §11)
  "reason": "client corrected packing list",
  "affectedScope": [{ "type": "leg", "id": "…" }],
  "invalidatedQuotes": [                    // the FF-scoped consequence + history snapshot (§11)
    { "quoteId": "…", "freightForwarderId": "…", "grandTotal": "4200.00", "currency": "USD" }
  ],
  "refreshedQuotes": [{ "quoteId": "…", "freightForwarderId": "…" }]
}
```

**Three cheap generalisations (build now; expandable later):**
1. **Envelope + JSON payload** — stable, indexed columns for what you filter on (`queryId`, `entity`, `changeType`, `actorId`, `at`); everything variable in `payload`. New change-type or payload field ⇒ **no migration**.
2. **`ChangeLogPolicy` provider** — a tiny injectable `shouldRecord(class, path, entity) → bool`, driven by the impact maps, so "log more/less" is **config, not code**. Ship the trivial "change-order only" version now.
3. **Swappable / fan-out sink** — the existing `CHANGE_LOG` DI token: `Noop → Prisma` now; a composite sink (event bus / SIEM) later, no call-site change.

The `NoopChangeLog`/`ChangeLogEntry` interface ([change-log.ts](apps/api/src/modules/changes/change-log.ts)) already matches this shape — SB6 provides `PrismaChangeLog` and extends the entry with `queryId`, `changeType`, `impactClass`, and the `payload` fields.

---

## 11. Invalidated-quote history — **decision: lightweight in-payload snapshot**

On re-distribute the invalidated quote's row is **reused** (`@@unique([legId, freightForwarderId])`), so when the FF re-submits, SB4b's submit path **overwrites** the 5 pricing child tables (`QuoteCargoLine`/`ChargeLine`/`TruckingCharge`/`WarehouseStagingLine`/`TransitPlan` — all `onDelete: Cascade` from `Quote`, so they persist through an *invalidate* but are replaced on *resubmit*). Spec §11.3 requires the invalidated bid remain "visible as historical context."

**Decision (locked with product):** at invalidation, capture a **lightweight pricing summary** (`grandTotal`, `currency`, `totalChargeableWeightT`, per-zone subtotals) into the `ChangeLog` payload's `invalidatedQuotes[]` (§10). **Why:** honours §11.3 with **zero new tables**, is immediately useful ("what did FF-A bid before we reopened Leg 1?"), and rides the generic payload we're building anyway. Full line-item revision history is **deferred** to an additive `QuoteRevision` table (§19) — YAGNI until someone needs to diff old line items.

---

## 12. DB tables impacted (worked example)

Scenario: Query `YAL26-0007` @ `RFQ_SENT`; Leg **L1** distributed to **FF-A** (`QUOTED`) + **FF-B** (`RFQ_SENT`); cargo **C1**→L1. Executive edits **C1.grossWt** (RfqDefining).

`➕`=insert `✎`=update `👁`=read `—`=untouched

| Table | Phase 1 preview | Phase 2 apply+cascade | Phase 3 re-distribute |
|---|---|---|---|
| `CargoItem` | 👁 | ✎ grossWt (`volumeCbm` regen) | — |
| `Quote` | 👁 | ✎ FF-A status→INVALID · ✎ FF-B manifestSnapshot | ✎ FF-A INVALID→RFQ_SENT + snapshot |
| pricing children ×5 | — | 👁 FF-A **kept** (history) | ✎ overwritten on FF-A resubmit |
| `StatusTransition` | — | ➕ ×2 (quote INVALIDATE, leg REOPEN) | ➕ (quote SEND, leg SEND_RFQ) |
| `Leg` | — | ✎ status→READY_FOR_RFQ | ✎ status→RFQ_SENT |
| `Query` | — | ✎ status (recompute, col only) | ✎ status |
| **`ChangeLog`** | — | ➕ 1 row (payload + invalidated snapshot) | — |
| `Rfq` | — | — | ✎ submissionDeadline +48h |
| `ScheduledEvent`/`MessageLog`/`Notification` (SB5) | — | ➕ notify (§15) | ➕ reminders re-armed + re-invite |

---

## 13. Data-model & migration

- **New:** `ChangeLog` table (§10) + relation on `Query` (`onDelete: Cascade`). One additive migration (`add_change_log`).
- **No other schema change.** Status edges are code (`contribute`); impact maps are code (`declare`); the classifier extension is code. Reserved columns `auditRefId`/`approvalRequestId` are nullable and unused now.
- **Migration hygiene (repo rule):** hand-author + `migrate deploy`; `migrate dev` drifts on the `CargoItem.volumeCbm` generated column (PG 42601). Additive only.

---

## 14. API / HTTP contract

- **No new endpoints.** The existing PATCH routes (`legs`/`cargo`/`points`/`queries`) gain change-order awareness through the mediator.
- **New response:** on the change-order path without a `reason`, the service returns **`409 { needsChangeOrder, preview }`** (`preview` = affected legs, per-FF quotes that will be invalidated vs refreshed, the field's `impactClass`).
- **New request field:** the PATCH body accepts an optional `reason` (mandatory to proceed on the change-order path; ignored on the free path). Plumbed into `ChangeRequest.reason` (already on the shared type, [change.ts:35](packages/shared/src/change.ts)).
- **Remove-FF:** a `quotes.@delete` change-order (mediated) — endpoint shape confirmed in the implementation plan.
- **RBAC:** workflow writes stay **Executive+** (no `@Roles`) per the settled Stage-4 convention — a change-order is still an Executive editing their own query.

---

## 15. Notifications — via the SB5 comms framework (delivered, PR #44)

SB6 **fires**; SB5 **composes**. The reopen step calls `NotificationDispatcher.dispatch("rfq.leg.reopened", { scope, tokens, recipients })` ([notification-dispatcher.service.ts](apps/api/src/modules/comms/notification-dispatcher.service.ts)); a new seeded `MessageTemplate` (`eventKey="rfq.leg.reopened"`, EMAIL + IN_APP) renders it; delivery is **compose-&-log** via the current `LogTransport` (live SMTP is the deferred go-live gate). Tokens: `{ rfqNumber, legCode, origin, destination, reason }`. Recipients: `EMAIL` → each **invalidated** FF's primary contact (those whose *submitted* quote was voided); pending (`RFQ_SENT`) FFs are refreshed in place and re-notified only at re-distribute (spec §11.4). `IN_APP` → the query's Executive. **Why reuse, not rebuild:** SB5 already owns templates, logging, and the transport swap — SB6 adds one template + one dispatch call.

---

## 16. Concurrency & edge cases

- **Concurrent edit + submit:** an FF submitting a moment before the cascade is invalidated like any other `QUOTED` quote (§8.5). Last-write-wins, no locks.
- **Query-wide field (`incoterms`):** scope = all legs → potentially several reopens in one change-order; the `ChangeLog` `affectedScope` lists them all; one notification per affected FF.
- **`EXPIRED`/`INVALID` quotes:** excluded from downstream + skipped in the cascade (§5).
- **Structural leg removal:** never a hard `DELETE` — `Quote.leg`/`Quote.rfqId` are `onDelete: Cascade` and would destroy quote history + hit child `Restrict` FKs. Removal invalidates the leg's quotes, soft-marks the leg, amends the RFQ.
- **Partial cascade failure:** accepted window (§7); reopen re-runnable, projector idempotent.

---

## 17. Testing strategy

- **Unit (shared):** `decidePath` truth table already covered; add classifier scope fan-out (point/query/quote → legs).
- **e2e (api, `*.e2e-spec.ts`, self-contained + `await moduleRef.close()`):** free-path unchanged (Corrective post-RFQ stays free); RfqDefining edit on a distributed leg → `409` preview then apply → FF-A `INVALID`, FF-B manifest refreshed, leg `READY_FOR_RFQ`, `ChangeLog` row with snapshot; re-distribute reactivates `INVALID→RFQ_SENT`; Structural remove-FF; query-wide `incoterms` reopens all legs; `EXPIRED` skipped; minimal-blast-radius (sibling legs untouched).
- **Seed:** e2e needs `FreightDensityFactor` + the new `rfq.leg.reopened` template (extend `message-templates.seed.ts`).
- **Gate:** `pnpm run lint` + typecheck + tests + build green before PR; opus whole-branch review.

---

## 18. Redundancy analysis — `ChangeLog` vs audit trail vs approval flow

Each record answers a **different** question, so there is no fatal redundancy — provided `ChangeLog` stays the *consequence* record and *references* the others:

| Field | Overlaps with | Resolution |
|---|---|---|
| `payload.from/to` (diff) | future **AuditLog** (every write) | keep light now; delegate to `auditRefId` when AuditLog lands |
| `payload.reason` / notes | future **ApprovalRequest** (owns notes+attachment) | reference via `approvalRequestId`, don't copy |
| `payload.affectedScope` | `StatusTransition` | justified denormalisation — StatusTransition has no `queryId` / no trigger link |
| `impactClass` + invalidation consequence | *nothing* | **irreducible — unique to `ChangeLog`** |

**Why AuditLog can't just be "ChangeLog for all fields":** not every write flows through the mediator — master data (Client/Vessel/FF), RFQ actions (distribute/select), and FF portal submits are service methods + `fire()`, invisible to the mediator. A *universal* audit trail needs a lower layer (Prisma `$extends`/middleware) and lands as a **separate additive sink**, with `ChangeLog` as the semantic annotation on top.

---

## 19. Future enhancements (designed-for, not built now)

1. **Universal audit trail** — a Prisma-middleware `AuditLog` capturing every write (value-level, all entities). `ChangeLog.auditRefId` already reserved to point at it; overlapping payload diffs can then be dropped. Additive, no SB6 rework.
2. **Maker-checker approval flow ("SB7", deferred — business not ready).** An *orthogonal pre-gate* on the same substrate: a `requiresApproval` policy on the impact maps, a mediator pre-gate that **holds** the change as an `ApprovalRequest` (serialized patch + **notes + attachment** via the Stage-3 `FileAsset`), a new `approvalRequest` status machine (`PENDING→APPROVED/REJECTED/WITHDRAWN`), and — on approval — apply → (if RfqDefining post-RFQ) the SB6 cascade. `ChangeLog.approvalRequestId` reserved for the authorization link. **Approval-ness and change-order-ness are independent axes** (a field can need approval yet invalidate nothing, e.g. changing the client).
3. **Full `QuoteRevision` history** — line-item snapshots of invalidated quotes (beyond the lightweight §11 summary), if diffing old bids becomes a requirement.
4. **`ChangeLogPolicy` expansion** — flip config to also record free-path workflow-entity edits (a partial, mediator-scoped audit) short of the full middleware AuditLog.
5. **Cascade concurrency hardening** — an outbox / saga-completion marker + row-lock/serializable-retry on `fire`, replacing the accepted last-write-wins window (§7), when true concurrency arrives.
6. **Change-order analytics** — because `ChangeLog` carries `impactClass` + `reason` per query, "which fields most often force re-quotes" becomes a query.
7. **Structural remove-FF change-order (was the SB6 build's Task 12 — deferred during implementation).** Removing an FF from a *sent* leg is already classified `Structural` (the `quotes.@delete` impact map + the `quote → its-leg` classifier fan-out ship in this build), but the **handler** is deferred: unlike a field edit — which voids **all** the leg's QUOTED quotes and reopens the leg — removing one FF must void **only that FF's** quote and recompute coverage **without** reopening (spec §11.3, FF-scoped). A correct handler needs (a) a `quotes.@delete` branch in `ChangeOrderStrategy.apply` targeting only `req.id`'s quote (no manifest re-freeze, no leg `REOPEN`); (b) a new **`RFQ_SENT → INVALID` status edge** to void a *pending* FF (only `QUOTED → INVALID` exists today); (c) a "RFQ withdrawn" notification (a new template + event/handler mirroring `rfq.leg.reopened`). It is secondary to the field-edit cascade (the primary deliverable + the Stage-5 prerequisite); the classification infrastructure is in place and tested, ready for the follow-up.

---

## 20. Out of scope / non-goals

- The universal field-level audit trail (§19.1) — deferred, separate layer.
- The approval flow (§19.2) — deferred (SB7 candidate), parked pending business requirements.
- Full quote line-item revision history (§19.3).
- Live email transmission + TLS (the FF-facing go-live gate — Stage-4 register).
- Automatic re-distribution — the Executive re-distributes manually (spec §11.2).
- Structural **remove-FF** change-order **handler** (§19.7) — deferred; the `quotes.@delete` classification ships, the handler is a documented follow-up.

---

## 21. Decisions log (locked, with rationale)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Activate the reserved seams; **zero Stage-3 behaviour edits** | The core was built for this; activation beats retrofit (§3). |
| D2 | Preview via **`409` + re-PATCH-with-`reason`**; mediator unchanged | Reuses the SB2b/SB3 confirm idiom; no new endpoint (§7). |
| D3 | Extend the **classifier** to fan point/query/quote → legs | Uniform leg-typed scope for the resolver + strategy (§5). |
| D4 | Downstream = `{RFQ_SENT, QUOTED}` only (**exclude EXPIRED**) | Only live quotes warrant a cascade (§5). |
| D5 | `ChangeLog` = **generic envelope + JSON payload + policy + swappable sink** | Configurable without migrations; collapses future overlap to references (§10, §18). |
| D6 | Invalidated-quote history = **lightweight in-payload snapshot** | Honours §11.3 with no new table; full `QuoteRevision` deferred (§11, §19.3). |
| D7 | Saga = data+snapshot+ChangeLog in one tx, **status fires after** | `fire` owns its tx / can't nest; last-write-wins per §8.5 (§7). |
| D8 | Notifications via the **SB5 comms framework** (`dispatch` + a template) | SB5 owns templates/logging/transport; SB6 adds one of each (§15). |
| D9 | Approval flow is an **orthogonal future layer**, not part of SB6 | Independent axis; keeps SB6 scoped to the cascade Stage 5 needs (§19.2). |
