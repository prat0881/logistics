# Stage 5 · S5.8 — Client Quotation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Design of record: [`docs/Stage 5 - Client Quotation - Design.md`](../../Stage%205%20-%20Client%20Quotation%20-%20Design.md).

**Goal:** After every leg is approved and the award frozen, let a Manager price the shipment for the client — apply a margin, adjust individual charges, preview the email, and issue it — moving the query to `AWAITING_CLIENT_DECISION`.

**Architecture:** Two pure functions in `@svyft/shared` (charge grouping, margin pricing) carry all the arithmetic; one new `Quotation` table holds the editable draft as JSON and freezes an immutable snapshot on issue; a builder screen and a preview dialog sit on top. Issuing composes a `MessageLog` row through the existing template service and fires a new milestone the query projector already knows how to read.

**Tech Stack:** NestJS + Prisma/Postgres (`apps/api`), React 18 + Vite + TanStack Query + RHF + Zod + shadcn (`apps/web`), pure TS + Zod (`packages/shared`). Tests: jest e2e (api), vitest (web, shared).

## Global Constraints

- **Margin is markup on cost:** `client = round2(cost × (1 + marginPct / 100))`. **Never** `cost ÷ (1 − m)`.
- **One margin per quotation, applied to every line.** A hand-edited line is **pinned as an override**; changing the margin recalculates every line **except** pinned ones.
- **The client sees the grand total only** — no charge lines, no per-leg totals, no forwarder cost, no margin, **no forwarder names**, no route/scope. The client-facing content is the client's own enquiry particulars echoed back.
- **No PDF, no attachment.** The email body is the entire deliverable.
- **Currency is USD throughout.** Cost is frozen from `Query.awardSnapshot`'s `unitsPerUsd` — never re-read live FX.
- **RBAC: Manager+** (`@Roles(ADMINISTRATOR, MANAGER)`) for every quotation endpoint, matching the existing gate on generate-client-quote.
- **Round to cents at each line, then re-round after summing.** Three individually-rounded lines can sum to a float artifact (the guard S5.4 applied to `combinedUsd`).
- Errors surface through the global handlers: `ZodValidationPipe` → 400, `PrismaExceptionFilter` → 404/409. Web surfaces `ApiError` inline via `role="alert"` — **no toast system**; reuse `apps/web/src/features/compare/errorMessage.ts`, never re-paste it.
- **Rebuild `@svyft/shared` after editing it** (`pnpm --filter @svyft/shared build`) — api runtime, web build and web vitest resolve it through `dist/`.
- Run `pnpm run typecheck` per task (vitest/jest do **not** type-check). Full `pnpm run ci` on the final task only.
- **Every absence assertion in a web test must be mutation-proven** (break the condition → red → revert → green) and the evidence reported. `renderWithProviders`' `/api/auth/me` stub resolves **asynchronously** — never assert synchronously after `render()`; await a positive control first (`AuthProbe` pattern, `CheckerPanel.test.tsx:85-92`). S5.6 shipped three vacuous tests and S5.7 five uncovered behaviours from exactly these two causes.
- Commit per task. Verify `git branch --show-current` before every commit.

---

## File Structure

| File | Responsibility | Task |
| :-- | :-- | :-- |
| `packages/shared/src/quotation-charges.ts` *(new)* | Pure: one winning quote's `draftJson` + variant → ordered cost lines grouped by journey stage. | 1 |
| `packages/shared/src/quotation-pricing.ts` *(new)* | Pure: margin + overrides → client amounts and totals. | 2 |
| `packages/shared/src/quotation.ts` *(new)* | DTOs + Zod schemas for the quotation API. | 2 |
| `prisma/schema.prisma` *(modify)* | `Quotation` model + `QuotationStatus` enum + migration. | 3 |
| `apps/api/src/modules/quotation/*` *(new)* | Controller + service: get-or-create draft, patch, issue, revise. | 3, 4 |
| `apps/api/src/modules/status/query-status.projector.ts` *(modify)* | Source the `awaitingClientDecision` milestone. | 4 |
| `apps/api/src/seed/message-templates.seed.ts` *(modify)* | `quotation.issued.email` template. | 4 |
| `apps/web/src/features/quotation/useQuotation.ts` *(new)* | Read + mutation hooks. | 5 |
| `apps/web/src/features/quotation/QuotationPage.tsx` *(new)* | Builder shell: header, route, margin bar, leg tables. | 5 |
| `apps/web/src/features/quotation/ChargeEditorTable.tsx` *(new)* | Per-leg grouped table, editable client prices, override pinning. | 5 |
| `apps/web/src/features/quotation/QuotationPreviewDialog.tsx` *(new)* | Envelope + letter + Issue. | 6 |

---

## Task 1: Charge grouping (pure)

**Files:**
- Create: `packages/shared/src/quotation-charges.ts`
- Create: `packages/shared/src/quotation-charges.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `QuoteDraft`, `QuoteDraftCharge`, `ChargeRateVariant`, `CHARGE_ZONES` from `./quote`; `toUsd` from `./fx`.
- Produces:
  ```ts
  export type ChargeGroupKey = "ORIGIN" | "FREIGHT" | "DESTINATION" | "WAREHOUSE";
  export interface QuotationCostLine {
    id: string;            // stable within a leg: `${group}:${index}`
    group: ChargeGroupKey;
    label: string;
    note?: string;
    costNative: number;
    costUsd: number;
  }
  export interface QuotationCostGroup { group: ChargeGroupKey; label: string; lines: QuotationCostLine[]; costUsd: number }
  export function buildQuotationCostLines(
    draft: QuoteDraft, variant: ChargeRateVariant | null, currency: string | null, unitsPerUsd: number | null,
  ): QuotationCostGroup[];
  ```

**Group order is fixed:** `ORIGIN` ("Origin charges") → `FREIGHT` ("Freight") → `DESTINATION` ("Destination charges") → `WAREHOUSE` ("Warehouse"). Empty groups are omitted.

Mapping: `draft.charges` with `zone === "ORIGIN"` / `"DESTINATION"` land in those groups; `zone === "MAIN_FREIGHT"` and `zone === null` (ad-hoc lines) land in `FREIGHT`. `draft.trucking` rows whose `rateVariant` matches the winning variant, and `draft.seaRates` rows whose `rateVariant` matches, also land in `FREIGHT`. `draft.warehouse` rows land in `WAREHOUSE`. A `null` `amount` contributes `0`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildQuotationCostLines } from "./quotation-charges";
import type { QuoteDraft } from "./quote";

const draft = (over: Partial<QuoteDraft> = {}): QuoteDraft => ({
  charges: [
    { zone: "ORIGIN", presetKey: null, label: "Terminal handling", amount: 820, rateVariant: null },
    { zone: "DESTINATION", presetKey: null, label: "Import clearance", amount: 460, rateVariant: null },
    { zone: null, presetKey: null, label: "Ad-hoc surcharge", amount: 100, rateVariant: null },
  ],
  trucking: [
    { legEndpointPointId: "p1", truckingType: "PICKUP", basis: "PER_TRIP", amount: 2600, rateVariant: "DEDICATED", tonnage: null },
    { legEndpointPointId: "p2", truckingType: "PICKUP", basis: "PER_TRIP", amount: 999, rateVariant: "GROUPAGE", tonnage: null },
  ],
  seaRates: [], warehouse: [{ warehousePointId: "w1", position: "PRE", label: "Shanghai Bonded WH", amount: 400 }],
  transit: null, dgSurchargeNote: null, termsConditions: null,
  ...over,
} as QuoteDraft);

describe("buildQuotationCostLines", () => {
  it("groups by journey stage in a fixed order and omits empty groups", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "AED", 3.6725);
    expect(g.map((x) => x.group)).toEqual(["ORIGIN", "FREIGHT", "DESTINATION", "WAREHOUSE"]);
  });

  it("includes only the winning variant's freight rows", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "AED", 3.6725);
    const freight = g.find((x) => x.group === "FREIGHT")!;
    expect(freight.lines.map((l) => l.costNative)).toEqual([100, 2600]);
    expect(freight.lines.some((l) => l.costNative === 999)).toBe(false);
  });

  it("converts each line to USD with the supplied rate and sums the group", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "AED", 3.6725);
    const origin = g.find((x) => x.group === "ORIGIN")!;
    expect(origin.lines[0].costUsd).toBe(223.28);
    expect(origin.costUsd).toBe(223.28);
  });

  it("treats a null amount as zero rather than dropping the line", () => {
    const d = draft({ warehouse: [{ warehousePointId: "w1", position: "PRE", label: "WH", amount: null }] } as Partial<QuoteDraft>);
    const g = buildQuotationCostLines(d, "DEDICATED", "AED", 3.6725);
    expect(g.find((x) => x.group === "WAREHOUSE")!.lines[0].costUsd).toBe(0);
  });

  it("passes USD amounts through unconverted", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "USD", null);
    expect(g.find((x) => x.group === "ORIGIN")!.lines[0].costUsd).toBe(820);
  });

  it("gives every line a stable id unique within the leg", () => {
    const g = buildQuotationCostLines(draft(), "DEDICATED", "AED", 3.6725);
    const ids = g.flatMap((x) => x.lines.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```


- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @svyft/shared test -- quotation-charges`
Expected: FAIL — cannot resolve `./quotation-charges`.

- [ ] **Step 3: Implement**

Build the four groups in fixed order, pushing lines as described in the mapping above. Convert with the existing helper rather than hand-rolling division:

```ts
const usd = (native: number): number =>
  currency == null || currency === "USD"
    ? round2(native)
    : round2(unitsPerUsd && unitsPerUsd > 0 ? native / unitsPerUsd : 0);
```

`round2(n) = Math.round((n + Number.EPSILON) * 100) / 100`. Group `costUsd` is `round2(Σ line.costUsd)`. Export the type and function from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @svyft/shared test -- quotation-charges`
Expected: PASS, 6 tests.

- [ ] **Step 5: Rebuild shared, typecheck, commit**

```bash
pnpm --filter @svyft/shared build && pnpm run typecheck
git add packages/shared/src
git commit -m "feat(stage5): group a winning quote's charges by journey stage (S5.8)"
```

---

## Task 2: Margin pricing + DTOs (pure)

**Files:**
- Create: `packages/shared/src/quotation-pricing.ts`
- Create: `packages/shared/src/quotation-pricing.test.ts`
- Create: `packages/shared/src/quotation.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `QuotationCostGroup`, `QuotationCostLine` (Task 1).
- Produces:
  ```ts
  export function clientAmount(costUsd: number, marginPct: number): number;      // round2(cost × (1 + m/100))
  export interface PricedLine extends QuotationCostLine { clientUsd: number; overridden: boolean }
  export interface PricedGroup { group: ChargeGroupKey; label: string; lines: PricedLine[]; costUsd: number; clientUsd: number }
  export interface PricedLeg { legId: string; legCode: string; forwarderName: string; variantLabel: string | null; groups: PricedGroup[]; costUsd: number; clientUsd: number }
  export interface PricedQuotation { legs: PricedLeg[]; costTotalUsd: number; clientTotalUsd: number; marginValueUsd: number }
  export function priceQuotation(
    legs: { legId: string; legCode: string; forwarderName: string; variantLabel: string | null; groups: QuotationCostGroup[] }[],
    marginPct: number,
    overrides: Record<string, number>,   // key: `${legId}:${lineId}` → absolute client USD
  ): PricedQuotation;
  ```
  Plus in `quotation.ts`: `quotationPatchSchema = z.object({ marginPct: z.number().min(0).max(100).optional(), overrides: z.record(z.string(), z.number().min(0)).optional() })`, `quotationIssueSchema = z.object({ recipientEmail: z.string().email(), subject: z.string().trim().min(1).max(200), bodyText: z.string().trim().min(1).max(20000) })`, and `QuotationDto`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { clientAmount, priceQuotation } from "./quotation-pricing";

const legs = [{
  legId: "l1", legCode: "L1", forwarderName: "Bridge", variantLabel: "Dedicated",
  groups: [{ group: "ORIGIN" as const, label: "Origin charges", costUsd: 300,
    lines: [
      { id: "ORIGIN:0", group: "ORIGIN" as const, label: "THC", costNative: 0, costUsd: 100 },
      { id: "ORIGIN:1", group: "ORIGIN" as const, label: "Docs", costNative: 0, costUsd: 200 },
    ] }],
}];

describe("clientAmount", () => {
  it("marks up on cost, not margin-on-sell", () => {
    expect(clientAmount(100, 20)).toBe(120);      // NOT 125
    expect(clientAmount(100, 0)).toBe(100);
  });
  it("rounds to cents", () => { expect(clientAmount(103.47, 18)).toBe(122.09); });
});

describe("priceQuotation", () => {
  it("applies the margin to every line and rolls up", () => {
    const p = priceQuotation(legs, 20, {});
    expect(p.legs[0].groups[0].lines.map((l) => l.clientUsd)).toEqual([120, 240]);
    expect(p.legs[0].groups[0].clientUsd).toBe(360);
    expect(p.clientTotalUsd).toBe(360);
    expect(p.costTotalUsd).toBe(300);
    expect(p.marginValueUsd).toBe(60);
  });

  it("an override pins its line and is excluded from recalculation", () => {
    const p = priceQuotation(legs, 20, { "l1:ORIGIN:1": 500 });
    expect(p.legs[0].groups[0].lines[0]).toMatchObject({ clientUsd: 120, overridden: false });
    expect(p.legs[0].groups[0].lines[1]).toMatchObject({ clientUsd: 500, overridden: true });
    expect(p.clientTotalUsd).toBe(620);
  });

  it("changing the margin moves unpinned lines only", () => {
    const a = priceQuotation(legs, 20, { "l1:ORIGIN:1": 500 });
    const b = priceQuotation(legs, 50, { "l1:ORIGIN:1": 500 });
    expect(b.legs[0].groups[0].lines[0].clientUsd).toBe(150);
    expect(b.legs[0].groups[0].lines[1].clientUsd).toBe(500);
    expect(a.legs[0].groups[0].lines[1].clientUsd).toBe(500);
  });

  it("re-rounds after summing so per-line rounding cannot leak a float artifact", () => {
    const drift = [{ legId: "l1", legCode: "L1", forwarderName: "B", variantLabel: null,
      groups: [{ group: "ORIGIN" as const, label: "Origin charges", costUsd: 0,
        lines: [1000.1, 500.25, 233.33].map((c, i) => ({ id: `ORIGIN:${i}`, group: "ORIGIN" as const, label: `L${i}`, costNative: 0, costUsd: c })) }] }];
    const p = priceQuotation(drift, 0, {});
    expect(p.clientTotalUsd).toBe(1733.68);
    expect([1000.1, 500.25, 233.33].reduce((s, n) => s + n, 0)).not.toBe(1733.68);
  });

  it("ignores an override whose key matches no line", () => {
    const p = priceQuotation(legs, 20, { "l1:NOPE:9": 999 });
    expect(p.clientTotalUsd).toBe(360);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @svyft/shared test -- quotation-pricing`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function clientAmount(costUsd: number, marginPct: number): number {
  return round2(costUsd * (1 + marginPct / 100));
}
```

`priceQuotation` maps each line to `{ ...line, clientUsd: overrides[`${legId}:${line.id}`] ?? clientAmount(line.costUsd, marginPct), overridden: key in overrides }`, then re-rounds each group, leg and grand total with `round2(Σ …)`. `marginValueUsd = round2(clientTotalUsd − costTotalUsd)`.

Write `quotation.ts` with the three schemas and `QuotationDto` from the Interfaces block. Export everything from `index.ts`.

- [ ] **Step 4: Run to confirm it passes**

Run: `pnpm --filter @svyft/shared test -- quotation-pricing`
Expected: PASS, 7 tests.

- [ ] **Step 5: Rebuild, typecheck, commit**

```bash
pnpm --filter @svyft/shared build && pnpm run typecheck
git add packages/shared/src
git commit -m "feat(stage5): quotation margin pricing + DTOs (S5.8)"
```

---

## Task 3: `Quotation` model and the draft endpoints

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated>/migration.sql` (via `prisma migrate dev`)
- Create: `apps/api/src/modules/quotation/quotation.module.ts`, `quotation.controller.ts`, `quotation.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/quotation.e2e-spec.ts`

**Interfaces:**
- Consumes: `buildQuotationCostLines` (Task 1), `priceQuotation` / `quotationPatchSchema` / `QuotationDto` (Task 2).
- Produces: `GET /api/queries/:id/quotation` → `QuotationDto` (creates the `DRAFT` on first call); `PATCH /api/queries/:id/quotation` → `QuotationDto`.

Add to `prisma/schema.prisma` exactly the `Quotation` model and `enum QuotationStatus { DRAFT ISSUED SUPERSEDED }` from the design's Data model section, plus `quotations Quotation[]` on `Query`.

- [ ] **Step 1: Write the failing e2e**

Follow `apps/api/test/comparison.e2e-spec.ts`'s conventions exactly: a per-file `const PFX = "s58q"`, cookies minted via `JwtService`, `afterAll` cleanup of every row the file created.

```ts
it("creates a DRAFT on first GET, priced from the awarded quotes at margin 0", async () => {
  const res = await request(app.getHttpServer())
    .get(`/api/queries/${query.id}/quotation`)
    .set("Cookie", cookieFor(randomUUID(), Role.MANAGER))
    .expect(200);
  expect(res.body.version).toBe(1);
  expect(res.body.status).toBe("DRAFT");
  expect(res.body.marginPct).toBe(0);
  expect(res.body.clientTotalUsd).toBe(res.body.costTotalUsd);
  expect(res.body.legs[0].groups.length).toBeGreaterThan(0);
});

it("is idempotent — a second GET returns the same draft, not a second one", async () => { /* same id, version still 1 */ });

it("PATCH applies a margin and recalculates every line", async () => { /* marginPct 20 → clientTotalUsd = round2(cost × 1.2) */ });

it("PATCH stores an override that survives a later margin change", async () => { /* override a line, change margin, assert the line held */ });

it("403s an EXECUTIVE on both GET and PATCH", async () => { /* RolesGuard */ });

it("409s when the query has no frozen award snapshot", async () => { /* a QUOTED query, not QUOTING_CLIENT */ });
```

- [ ] **Step 2: Run to confirm it fails**

```bash
set -a; . apps/api/.env; set +a
pnpm --filter @svyft/api test -- quotation.e2e-spec.ts
```
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Migrate and implement**

```bash
pnpm exec prisma migrate dev --name add_quotation --schema prisma/schema.prisma
```

`QuotationService.getOrCreateDraft(queryId)`: load the query with `awardSnapshot`; **409 if it is null** (nothing to price). For each snapshot leg, load its winning quote's `draftJson`, call `buildQuotationCostLines(draft, leg.variant, leg.currency, leg.unitsPerUsd)`, and cache the resulting groups in `draftJson`. Return `priceQuotation(...)` over them with the stored `marginPct` and `overrides`.

`patch(queryId, body)`: merge `marginPct`/`overrides` into `draftJson`, persist `costTotalUsd`/`clientTotalUsd`, return the repriced DTO. **409 if the current quotation is not `DRAFT`.**

Controller: `@Controller("queries/:id/quotation")`, `@Roles(Role.ADMINISTRATOR, Role.MANAGER)` on the class, `new ZodValidationPipe(quotationPatchSchema)` on the PATCH body, `@CurrentUser()` for the actor. No logic in the controller.

- [ ] **Step 4: Run to confirm it passes**

Run: `pnpm --filter @svyft/api test -- quotation.e2e-spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm run typecheck
git add prisma apps/api/src apps/api/test
git commit -m "feat(stage5): Quotation model + draft pricing endpoints (S5.8)"
```

---

## Task 4: Issue, revise, and the `AWAITING_CLIENT_DECISION` milestone

**Files:**
- Modify: `apps/api/src/modules/quotation/quotation.service.ts`, `quotation.controller.ts`
- Modify: `apps/api/src/modules/status/query-status.projector.ts`
- Modify: `apps/api/src/seed/message-templates.seed.ts`
- Modify: `apps/api/src/modules/award/award.service.ts` (reopen path)
- Modify: `apps/api/test/quotation.e2e-spec.ts`

**Interfaces:**
- Consumes: `quotationIssueSchema` (Task 2), `MessageTemplateService.lookup` (existing).
- Produces: `POST /api/queries/:id/quotation/issue` → `QuotationDto`; `POST /api/queries/:id/quotation/revise` → `QuotationDto`.

- [ ] **Step 1: Write the failing e2e**

```ts
it("issue freezes a snapshot, stamps ISSUED, and rolls the query to AWAITING_CLIENT_DECISION", async () => { /* … */ });
it("issue composes exactly one MessageLog row against quotation.issued.email", async () => { /* … */ });
it("issue 409s when the draft has no priced legs", async () => { /* … */ });
it("403s an EXECUTIVE on issue", async () => { /* … */ });
it("revise clones the issued version into a new DRAFT at version + 1, carrying margin and overrides", async () => { /* … */ });
it("reopening the comparison supersedes issued quotations, discards the draft, and returns the query to QUOTED", async () => { /* … */ });
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @svyft/api test -- quotation.e2e-spec.ts`
Expected: FAIL — issue/revise routes 404.

- [ ] **Step 3: Implement**

`issue()` in one transaction: reprice, write `issuedSnapshot` (the priced document verbatim), set `status = ISSUED`, `issuedAt`, `issuedByUserId`, `recipientEmail`, `subject`, `bodyText`; compose the `MessageLog` row via `MessageTemplateService`; then recompute the query status **inside the same transaction** using the projector's `client` parameter, exactly as `generateClientQuote` does.

In `message-templates.seed.ts` add:

```ts
{
  key: "quotation.issued.email", eventKey: "quotation.issued", channel: "EMAIL",
  subject: "Quotation {{Quotation_Ref}} · Ref {{Query_ID}}",
  body: "Dear {{Client_Name}},\n\nThank you for your enquiry. We are pleased to quote for the shipment below.\n\nOur reference: {{Query_ID}}\nYour reference: {{Reference_Tags}}\nShipment: {{Shipment_Description}}\nVessel: {{Vessel}}\nPort of call: {{Port_Of_Call}}\nCargo: {{Cargo_Summary}}\nCargo ready: {{Ready_Date}}\nQuotation valid until: {{Valid_Until}}\n\nTotal — all inclusive: USD {{Grand_Total}}\n\nCovers all charges for the scope described above, subject to space and equipment availability at the time of booking and to the validity date shown.\n\nTo proceed, simply reply to this email and we will confirm the booking.\n\nRegards,\nYankalfa Logistics",
},
```

In `query-status.projector.ts`, source the milestone from a persisted fact, mirroring `quotingClient: !!q.awardSnapshot`:

```ts
const issued = await client.quotation.count({ where: { queryId, status: "ISSUED" } });
const status = this.project(legStatuses, {
  rfqReady: !!q.rfqReadyAt,
  noResponse,
  quotingClient: !!q.awardSnapshot,
  awaitingClientDecision: issued > 0,
});
```

`deriveQueryStatus` already checks `awaitingClientDecision` **before** `quotingClient`, so no change to `packages/shared/src/status.ts` is needed — verify this before writing code and report if it is not the case.

In `award.service.ts`'s `reopenComparison`, inside its existing transaction: `updateMany` every `ISSUED` quotation for the query to `SUPERSEDED` and delete any `DRAFT`. The status recompute already in that method then returns the query to `QUOTED`.

**Valid-until** is the **earliest `validUntil` across the winning quotes** (design Q2). If every winning quote has a null `validUntil`, omit the line from the body rather than printing an empty value.

- [ ] **Step 4: Run to confirm it passes**

```bash
pnpm exec prisma db seed
pnpm --filter @svyft/api test -- quotation.e2e-spec.ts
```
Expected: PASS, 12 tests.

- [ ] **Step 5: Regression, typecheck, commit**

Run: `pnpm --filter @svyft/api test -- award` — the award family must stay green, particularly `award-generate.e2e-spec.ts`'s reopen cases.

```bash
pnpm run typecheck
git add prisma apps/api/src apps/api/test
git commit -m "feat(stage5): issue + revise quotation, wire AWAITING_CLIENT_DECISION (S5.8)"
```

---

## Task 5: The builder screen

**Files:**
- Create: `apps/web/src/features/quotation/useQuotation.ts`
- Create: `apps/web/src/features/quotation/QuotationPage.tsx`
- Create: `apps/web/src/features/quotation/ChargeEditorTable.tsx`
- Create: `apps/web/src/features/quotation/QuotationPage.test.tsx`
- Create: `apps/web/src/features/quotation/ChargeEditorTable.test.tsx`
- Modify: `apps/web/src/App.tsx` (route `/queries/:id/quotation`)
- Modify: `apps/web/src/features/rfq-workspace/StageRail.tsx` (link the "Award" step)

**Interfaces:**
- Consumes: `QuotationDto`, `quotationPatchSchema` (Task 2); `GET`/`PATCH` (Task 3).
- Produces: `useQuotation(queryId)`, `usePatchQuotation(queryId)` — invalidate `["quotation", queryId]`.

Reuse `QueryOverviewHeader` and `RouteDiagram` from `features/rfq-workspace` / `features/query-wizard` exactly as `CompareQuotesPage` does. Reuse `fmtUsd` from `features/compare/money.ts`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows forwarder cost and client price for every line", async () => { /* both columns present */ });

it("typing a margin recalculates unpinned lines and the grand total", async () => {
  /* set 20 → a 100.00 cost line reads 120.00; grand total updates */
});

it("editing a line pins it, badges it, and holds it across a margin change", async () => {
  /* edit to 45.00 → badge visible → change margin → still 45.00 */
});

it("reset overrides releases every pinned line back to the formula", async () => { /* … */ });

it("renders for a MANAGER and not for an EXECUTIVE", async () => {
  /* await the AuthProbe positive control BEFORE the absence assertion */
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `pnpm --filter @svyft/web test -- Quotation`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`QuotationPage`: header → route diagram → sticky margin bar (`marginPct` input, cost total, client total, margin value) → one `ChargeEditorTable` per leg → grand total → "Preview quotation" (Task 6 wires the dialog; this task renders the button disabled with `title="Preview arrives in the next task"` — **remove that stub in Task 6**).

`ChargeEditorTable`: groups collapsed by default; a group row shows its own cost and client totals; expanding reveals lines with the client price in a number input. On blur, if the value differs from `clientAmount(costUsd, marginPct)`, PATCH it as an override; overridden lines carry a visible badge. Margin changes are debounced and PATCHed.

Route in `App.tsx` under `ProtectedRoute` + `AppLayout`. In `StageRail`, point the "Award" step at `/queries/:id/quotation`, enabled when `query.status` is `QUOTING_CLIENT` or later — add `isAwardStageEnabled(status)` beside the existing `isQuotesStageEnabled`. **Do not key it off `RANK.QUOTING_CLIENT`**, which is 4 and collides with `QUOTED` (recorded as S5.7 T2 M2); compare the status value directly.

- [ ] **Step 4: Run, mutation-prove, typecheck**

Run: `pnpm --filter @svyft/web test -- Quotation && pnpm --filter @svyft/web lint && pnpm run typecheck`

For the EXECUTIVE absence assertion: invert the role gate, confirm **only** that test goes red, revert, confirm green. Report the evidence.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(stage5): client quotation builder screen (S5.8)"
```

---

## Task 6: Preview, issue, and full CI

**Files:**
- Create: `apps/web/src/features/quotation/QuotationPreviewDialog.tsx`
- Create: `apps/web/src/features/quotation/QuotationPreviewDialog.test.tsx`
- Modify: `apps/web/src/features/quotation/QuotationPage.tsx` (remove the Task-5 stub)
- Modify: `apps/web/src/features/quotation/useQuotation.ts` (`useIssueQuotation`, `useReviseQuotation`)

**Interfaces:**
- Consumes: `quotationIssueSchema` (Task 2); `POST …/issue`, `POST …/revise` (Task 4).
- Produces: nothing downstream — this is the last task.

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows the client's own enquiry particulars and one grand total", async () => {
  expect(await screen.findByText("USD 5,356.11")).toBeInTheDocument();
  expect(screen.getByText(/PO-88431/)).toBeInTheDocument();          // reference tags
});

it("never renders forwarder cost, margin, charge lines or forwarder names", async () => {
  const letter = await screen.findByTestId("quotation-letter");
  expect(letter).not.toHaveTextContent("Bridge Logistics");
  expect(letter).not.toHaveTextContent("4,539.08");                   // cost total
  expect(letter).not.toHaveTextContent(/margin/i);
  expect(letter).not.toHaveTextContent("Terminal handling");
});

it("prefills the recipient from the query contact and allows editing it", async () => { /* … */ });

it("issue posts recipient, subject and body, then closes", async () => { /* … */ });

it("surfaces an issue failure inline and keeps the dialog open", async () => { /* role=alert, onOpenChange not called with false */ });
```

The second test is the commercial guard for the whole feature — **mutation-prove it** by rendering a cost figure into the letter and confirming it goes red.

- [ ] **Step 2: Run to confirm they fail**

Run: `pnpm --filter @svyft/web test -- QuotationPreviewDialog`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

A `Dialog` (reuse `@/components/ui/dialog`): envelope on the left (recipient, subject, version, "Attachments — none"), the letter on the right in a `data-testid="quotation-letter"` container built **only** from the client's own enquiry particulars (`referenceTags`, `shipmentDescription`, `vesselName`/`imoNumber`, `portOfCall`, `eta`/`etd`, cargo summary, `readyDate`, valid-until) plus `clientTotalUsd`. Actions: "Back to builder", "Copy text", and **"Issue quotation"** — not "Send", since nothing is transmitted (design Q1). Below the button, state that delivery is pending SMTP.

Remove Task 5's disabled-button stub and wire the real dialog.

- [ ] **Step 4: Run, mutation-prove, lint, typecheck**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web lint && pnpm run typecheck`
Report the mutation evidence for the withheld-content test.

- [ ] **Step 5: Full CI**

```bash
set -a; . apps/api/.env; set +a
pnpm run ci
```
Expected: GREEN across all three workspaces. API e2e needs Postgres — container `svyft-postgres-task4` on port **5433**. If an api e2e fails, check for stray `FxRate` rows in the dev DB before assuming a code defect; that exact pollution caused a false failure during S5.7.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(stage5): quotation preview + issue (S5.8)"
```

---

## S5.8 acceptance

- [ ] `pnpm run ci` green → visual verification against a seeded `QUOTING_CLIENT` query (margin recalculation, override pinning, preview content) → opus whole-sub-build review → push to PR #52.
- [ ] Confirm the preview renders **no** cost, margin, charge line or forwarder name — by eye as well as by test.

## Self-review against the design

- **Coverage:** margin model → T2; charge exposure → T1; data model + draft → T3; issue/revise/milestone/reopen → T4; builder → T5; preview + client-facing rules → T6. RBAC is asserted in T3 (api) and T5 (web). Rounding guard → T2. Frozen FX → T1 (rate passed in, never re-read).
- **Consequences carried, not fixed:** Q1 (no SMTP — surfaced as "Issue", with delivery stated as pending), Q2 (valid-until = earliest winning-quote validity, flagged for business confirmation), Q3 (no itemisation for the client, by decision). C2 remains open for the compare screen — T1 is a separate server-side read path.
- **Type consistency:** `QuotationCostLine`, `QuotationCostGroup`, `ChargeGroupKey`, `PricedLine`, `PricedGroup`, `PricedLeg`, `PricedQuotation`, `clientAmount`, `priceQuotation`, `buildQuotationCostLines`, `quotationPatchSchema`, `quotationIssueSchema` are each defined once (T1, T2) and referenced by those exact names thereafter.
