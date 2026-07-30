# Stage 3 — Round 3 (Cargo UI, Units & Small Fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the business/testing Round-3 issues — Step-1 label renames, Incoterms default N/A + its persistence bug, Cargo optional-PO + an OUT_OF_GAUGE tag + per-row CM/MM & KG/GM unit selectors (with a unit-aware m³ `volumeCbm`), and a soft `:00` datetime-minute default.

**Architecture:** Bottom-up — shared (pure Zod/enums/helpers, TDD unit) → one Prisma migration → api (e2e) → web (integration) → docs. Dimensions/weights are stored **raw in the chosen unit** with the unit persisted per row; `volumeCbm` is a **unit-aware generated column** always in m³; weight roll-ups normalize to kg.

**Tech Stack:** pnpm monorepo · `@svyft/shared` (Zod + const-enums) · NestJS + Prisma (Neon Postgres) · Vite + React + shadcn/Radix + RHF · Vitest.

## Global Constraints

- Shared enums are **const objects** (never TS `enum`) + a union type + `Object.values(...) as [X, ...X[]]` array, pinned by a `toEqual` test.
- **Build `@svyft/shared` before web vitest:** run `pnpm --filter @svyft/shared build` before any web test/typecheck that depends on new shared runtime code.
- **Web CI:** `vite build` skips type errors — always run `pnpm --filter @svyft/web typecheck` separately.
- **API e2e** runs on CI against a fresh migrated-but-**unseeded** Postgres → every spec is seed-independent + self-cleaning (own rows by a unique prefix).
- `volumeCbm` is a **DB-generated column** — never written by the app.
- Prisma **cannot** express the generated column or enum `ADD VALUE` → the migration SQL is **hand-authored** (Postgres 12+; Neon is 15).
- Web tests: `renderWithProviders` + `mockFetch`; Radix Select is jsdom-flaky → drive the hidden native `<select>` / assert values.
- Datetime default is a **soft** `:00` (editable), not a lock.
- Renames are **UI-label-only** — `readyDate` field + DB column are unchanged.

---

### Task 1: Shared — `DimUnit` / `WeightUnit` enums + unit helpers

**Files:**
- Modify: `packages/shared/src/cargo.ts`
- Modify: `packages/shared/src/index.ts` (export, if not `export *`)
- Test: `packages/shared/src/cargo.test.ts`

**Interfaces — Produces:**
- `DimUnit = "CM" | "MM"`, `WeightUnit = "KG" | "GM"`; arrays `DIM_UNITS`, `WEIGHT_UNITS`.
- `cbmFromDims(dimL:number, dimW:number, dimH:number, qty:number, dimUnit:DimUnit): number` — m³.
- `toKg(weight:number, weightUnit:WeightUnit): number`.

- [ ] **Step 1: Write the failing test** (append to `cargo.test.ts`)

```ts
import { DIM_UNITS, WEIGHT_UNITS, cbmFromDims, toKg } from "./cargo";

describe("units", () => {
  it("pins the unit arrays", () => {
    expect(DIM_UNITS).toEqual(["CM", "MM"]);
    expect(WEIGHT_UNITS).toEqual(["KG", "GM"]);
  });
  it("cbmFromDims returns m³ and is unit-consistent (same box, either unit)", () => {
    // 100×50×40 cm, qty 2 → 0.4 m³
    expect(cbmFromDims(100, 50, 40, 2, "CM")).toBeCloseTo(0.4, 6);
    // same box in mm → same 0.4 m³
    expect(cbmFromDims(1000, 500, 400, 2, "MM")).toBeCloseTo(0.4, 6);
  });
  it("toKg normalizes grams", () => {
    expect(toKg(5, "KG")).toBe(5);
    expect(toKg(5000, "GM")).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts`
Expected: FAIL — `cbmFromDims`/`DIM_UNITS` not exported.

- [ ] **Step 3: Write minimal implementation** (add to `cargo.ts`, near the top after the `z` import)

```ts
export const DimUnit = { CM: "CM", MM: "MM" } as const;
export type DimUnit = (typeof DimUnit)[keyof typeof DimUnit];
export const DIM_UNITS = Object.values(DimUnit) as [DimUnit, ...DimUnit[]];

export const WeightUnit = { KG: "KG", GM: "GM" } as const;
export type WeightUnit = (typeof WeightUnit)[keyof typeof WeightUnit];
export const WEIGHT_UNITS = Object.values(WeightUnit) as [WeightUnit, ...WeightUnit[]];

/** Volume in cubic metres from dims in the chosen unit. cm³/1e6 = m³; mm³/1e9 = m³. */
export function cbmFromDims(dimL: number, dimW: number, dimH: number, qty: number, dimUnit: DimUnit): number {
  const div = dimUnit === "MM" ? 1e9 : 1e6;
  return (dimL * dimW * dimH * qty) / div;
}

/** Normalize a weight in the chosen unit to kilograms. */
export function toKg(weight: number, weightUnit: WeightUnit): number {
  return weightUnit === "GM" ? weight / 1000 : weight;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/cargo.ts packages/shared/src/cargo.test.ts
git commit -m "feat(shared): DimUnit/WeightUnit enums + cbmFromDims/toKg helpers"
```

---

### Task 2: Shared — `OUT_OF_GAUGE` reference tag + label map

**Files:**
- Modify: `packages/shared/src/cargo.ts`
- Test: `packages/shared/src/cargo.test.ts`

**Interfaces — Produces:**
- `ReferenceTag` now includes `OUT_OF_GAUGE`; `REFERENCE_TAGS` array updated.
- `referenceTagLabel(tag: ReferenceTag): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { REFERENCE_TAGS, referenceTagLabel } from "./cargo";

describe("reference tags", () => {
  it("includes OUT_OF_GAUGE", () => {
    expect(REFERENCE_TAGS).toEqual(["HEAVY", "FRAGILE", "NON_STACKABLE", "OUT_OF_GAUGE"]);
  });
  it("labels OUT_OF_GAUGE as 'Out of Gauge Cargo'", () => {
    expect(referenceTagLabel("OUT_OF_GAUGE")).toBe("Out of Gauge Cargo");
    expect(referenceTagLabel("NON_STACKABLE")).toBe("Non Stackable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts`
Expected: FAIL — array missing OUT_OF_GAUGE / `referenceTagLabel` undefined.

- [ ] **Step 3: Write minimal implementation** (edit the `ReferenceTag` const in `cargo.ts`, add the label fn)

```ts
export const ReferenceTag = {
  HEAVY: "HEAVY",
  FRAGILE: "FRAGILE",
  NON_STACKABLE: "NON_STACKABLE",
  OUT_OF_GAUGE: "OUT_OF_GAUGE",
} as const;
// (type + REFERENCE_TAGS array lines unchanged below the const)

const REFERENCE_TAG_LABELS: Record<ReferenceTag, string> = {
  HEAVY: "Heavy",
  FRAGILE: "Fragile",
  NON_STACKABLE: "Non Stackable",
  OUT_OF_GAUGE: "Out of Gauge Cargo",
};
export function referenceTagLabel(tag: ReferenceTag): string {
  return REFERENCE_TAG_LABELS[tag] ?? tag.replace(/_/g, " ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/cargo.ts packages/shared/src/cargo.test.ts
git commit -m "feat(shared): add OUT_OF_GAUGE reference tag + referenceTagLabel"
```

---

### Task 3: Shared — Incoterms `NA` reconcile + display label

**Files:**
- Modify: `packages/shared/src/query.ts:33-48`
- Test: `packages/shared/src/query.test.ts`

**Interfaces — Produces:**
- `Incoterms.NA === "NA"` (was `"N/A"`); `INCOTERMS` includes `"NA"`.
- `incotermsLabel(v: Incoterms): string` → `"NA" → "N/A"`, else identity.

- [ ] **Step 1: Write the failing test** (add to `query.test.ts`)

```ts
import { INCOTERMS, Incoterms, incotermsLabel } from "./query";

describe("incoterms NA", () => {
  it("stores NA (no slash) and pins the 12-value array", () => {
    expect(Incoterms.NA).toBe("NA");
    expect(INCOTERMS).toEqual(["EXW","FCA","FAS","FOB","CFR","CIF","CPT","CIP","DAP","DPU","DDP","NA"]);
  });
  it("displays NA as 'N/A'", () => {
    expect(incotermsLabel("NA")).toBe("N/A");
    expect(incotermsLabel("FOB")).toBe("FOB");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared exec vitest run src/query.test.ts`
Expected: FAIL — `Incoterms.NA` is `"N/A"` / `incotermsLabel` undefined / any existing pinned array test asserts 11 values.

- [ ] **Step 3: Write minimal implementation**

In `query.ts`, change the enum member value and add the label fn:

```ts
export const Incoterms = {
  EXW: "EXW", FCA: "FCA", FAS: "FAS", FOB: "FOB", CFR: "CFR", CIF: "CIF",
  CPT: "CPT", CIP: "CIP", DAP: "DAP", DPU: "DPU", DDP: "DDP",
  NA: "NA",
} as const;
// type + INCOTERMS array unchanged

export function incotermsLabel(v: Incoterms): string {
  return v === "NA" ? "N/A" : v;
}
```

If an existing test pins `INCOTERMS` to 11 values or asserts `"N/A"`, update it to the 12-value array above.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/shared exec vitest run src/query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/query.ts packages/shared/src/query.test.ts
git commit -m "fix(shared): store Incoterms N/A as 'NA' + incotermsLabel display map"
```

---

### Task 4: Shared — cargo schema: optional PO + `dimUnit`/`weightUnit`

**Files:**
- Modify: `packages/shared/src/cargo.ts` (`cargoCreateSchema`, `cargoUpdateSchema`, `CargoDto`)
- Test: `packages/shared/src/cargo.test.ts`

**Interfaces — Produces:**
- `cargoCreateSchema`: `poReference` optional; `dimUnit` (default `"CM"`), `weightUnit` (default `"KG"`).
- `cargoUpdateSchema`: same fields optional.
- `CargoDto` gains `dimUnit: DimUnit; weightUnit: WeightUnit`.

- [ ] **Step 1: Write the failing test**

```ts
import { cargoCreateSchema } from "./cargo";

describe("cargo schema round-3", () => {
  const base = { productName: "Widget", packageType: "Carton", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 };
  it("accepts a blank/absent PO reference", () => {
    expect(cargoCreateSchema.safeParse(base).success).toBe(true);
    expect(cargoCreateSchema.safeParse({ ...base, poReference: "" }).success).toBe(true);
  });
  it("defaults dimUnit=CM and weightUnit=KG when omitted", () => {
    const r = cargoCreateSchema.parse(base);
    expect(r.dimUnit).toBe("CM");
    expect(r.weightUnit).toBe("KG");
  });
  it("accepts explicit MM/GM units", () => {
    const r = cargoCreateSchema.parse({ ...base, dimUnit: "MM", weightUnit: "GM" });
    expect(r.dimUnit).toBe("MM");
    expect(r.weightUnit).toBe("GM");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts`
Expected: FAIL — blank PO rejected / `dimUnit` undefined.

- [ ] **Step 3: Write minimal implementation**

In `cargoCreateSchema`, change `poReference` and add units:

```ts
    poReference: z.string().trim().max(120).optional(),
    // …unchanged fields…
    dimUnit: z.enum(DIM_UNITS).default("CM"),
    weightUnit: z.enum(WEIGHT_UNITS).default("KG"),
```

In `cargoUpdateSchema` (the `.partial()` object), change `poReference` to `z.string().trim().max(120).nullable()` and add `dimUnit: z.enum(DIM_UNITS)`, `weightUnit: z.enum(WEIGHT_UNITS)` (they become optional via `.partial()`).

In `CargoDto` add:

```ts
  dimUnit: DimUnit;
  weightUnit: WeightUnit;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/cargo.ts packages/shared/src/cargo.test.ts
git commit -m "feat(shared): optional PO + dimUnit/weightUnit on cargo schemas + CargoDto"
```

---

### Task 5: Shared — cargo label fallback + route findings use it

**Files:**
- Modify: `packages/shared/src/cargo.ts` (add `cargoLabel`)
- Modify: `packages/shared/src/route.ts` (`RouteCargo` + the per-cargo finding messages)
- Test: `packages/shared/src/cargo.test.ts`, `packages/shared/src/route.test.ts`

**Interfaces:**
- Consumes: `RouteCargo` (Task exists) — extend with `productName: string; rowIndex: number`.
- Produces: `cargoLabel(c: { poReference?: string | null; productName?: string | null; rowIndex?: number }): string`.

- [ ] **Step 1: Write the failing test** (cargo.test.ts)

```ts
import { cargoLabel } from "./cargo";
describe("cargoLabel", () => {
  it("prefers PO, falls back to product name, then Row n", () => {
    expect(cargoLabel({ poReference: "PO-1", productName: "Steel", rowIndex: 0 })).toBe("PO-1");
    expect(cargoLabel({ poReference: "", productName: "Steel", rowIndex: 0 })).toBe("Steel");
    expect(cargoLabel({ poReference: null, productName: "", rowIndex: 2 })).toBe("Row 3");
  });
});
```

And in `route.test.ts` (the R2 delivery-start case fixture — set PO blank, productName set):

```ts
it("uses Product Name in a finding when PO is blank", () => {
  const g = validGraph();
  g.points[0].type = "DELIVERY";
  g.cargo[0].poReference = "";
  (g.cargo[0] as { productName?: string }).productName = "Steel Coils";
  const r2 = validateRoute(g, "create").find((f) => f.rule === "R2");
  expect(r2?.message).toContain("Steel Coils");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts src/route.test.ts`
Expected: FAIL — `cargoLabel` undefined; R2 message uses empty PO.

- [ ] **Step 3: Write minimal implementation**

In `cargo.ts`:

```ts
export function cargoLabel(c: { poReference?: string | null; productName?: string | null; rowIndex?: number }): string {
  const po = c.poReference?.trim();
  if (po) return po;
  const name = c.productName?.trim();
  if (name) return name;
  return `Row ${(c.rowIndex ?? 0) + 1}`;
}
```

In `route.ts`: extend `RouteCargo` with `productName: string;` and `rowIndex: number;`, import `cargoLabel`, and replace `Cargo ${c.poReference}` with `Cargo ${cargoLabel(c)}` in every per-cargo finding message (R9, R6, R1, R2, R4, C2 — search `c.poReference` in the per-cargo loop). Also update the shared fixtures in `route.test.ts` `validGraph()` cargo objects to include `productName` + `rowIndex` (e.g. `productName: "PO-1 goods", rowIndex: 0`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @svyft/shared exec vitest run` (whole shared suite — the fixture change touches many route tests)
Expected: PASS (all shared).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): cargoLabel fallback (PO→ProductName→Row n) in route findings"
```

---

### Task 6: Prisma schema + migration (enums, unit columns, unit-aware volumeCbm)

**Files:**
- Modify: `prisma/schema.prisma` (`enum ReferenceTag`, `enum Incoterms`, new `enum DimUnit`/`WeightUnit`, `model CargoItem`)
- Create: `prisma/migrations/20260730_round3_cargo_units/migration.sql`

**Interfaces — Produces:** DB columns `CargoItem.dimUnit`, `CargoItem.weightUnit`; enum values `ReferenceTag.OUT_OF_GAUGE`, `Incoterms.NA`; unit-aware `volumeCbm`.

- [ ] **Step 1: Edit `schema.prisma`**

- `enum ReferenceTag { HEAVY FRAGILE NON_STACKABLE OUT_OF_GAUGE }`
- `enum Incoterms { EXW FCA FAS FOB CFR CIF CPT CIP DAP DPU DDP NA }`
- Add: `enum DimUnit { CM MM }` and `enum WeightUnit { KG GM }`
- In `model CargoItem`, after `dimH`: `dimUnit DimUnit @default(CM)` and after `grossWt`: `weightUnit WeightUnit @default(KG)`
- Update the `volumeCbm` `@default(dbgenerated(...))` string to the unit-aware form:

```prisma
  volumeCbm  Decimal? @default(dbgenerated("((((\"dimL\" * \"dimW\") * \"dimH\") * (qty)::numeric) / (CASE WHEN (\"dimUnit\" = 'MM'::\"DimUnit\") THEN (1000000000)::numeric ELSE (1000000)::numeric END))")) @db.Decimal(14, 6)
```

- [ ] **Step 2: Hand-author the migration SQL**

Create `prisma/migrations/20260730_round3_cargo_units/migration.sql`:

```sql
-- New unit enums
CREATE TYPE "DimUnit" AS ENUM ('CM', 'MM');
CREATE TYPE "WeightUnit" AS ENUM ('KG', 'GM');

-- Extend existing enums (PG12+: ADD VALUE is fine in a tx as long as the value isn't USED in this tx — it isn't)
ALTER TYPE "ReferenceTag" ADD VALUE 'OUT_OF_GAUGE';
ALTER TYPE "Incoterms" ADD VALUE 'NA';

-- Per-row unit columns (existing rows backfill to CM/KG — their stored values are already cm/kg)
ALTER TABLE "CargoItem" ADD COLUMN "dimUnit" "DimUnit" NOT NULL DEFAULT 'CM';
ALTER TABLE "CargoItem" ADD COLUMN "weightUnit" "WeightUnit" NOT NULL DEFAULT 'KG';

-- Unit-aware volumeCbm. PG<17 cannot alter a generated expression → drop + re-add.
-- STORED recomputes for every row on ADD; existing CM rows recompute identically (/1e6).
ALTER TABLE "CargoItem" DROP COLUMN "volumeCbm";
ALTER TABLE "CargoItem" ADD COLUMN "volumeCbm" DECIMAL(14,6)
  GENERATED ALWAYS AS ("dimL" * "dimW" * "dimH" * "qty" / (CASE WHEN "dimUnit" = 'MM' THEN 1000000000 ELSE 1000000 END)) STORED;
```

- [ ] **Step 3: Verify schema ↔ migration are drift-free**

Run: `pnpm --filter @svyft/api exec prisma validate` then
`pnpm --filter @svyft/api exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DB" --exit-code`
Expected: `prisma validate` OK; `migrate diff` exit code 0 (no drift). If no local DB, rely on CI's `migrate deploy` on a fresh Postgres (the api e2e job).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260730_round3_cargo_units
git commit -m "feat(db): round-3 migration — unit enums/columns, OUT_OF_GAUGE, Incoterms NA, unit-aware volumeCbm"
```

---

### Task 7: API — persist `dimUnit`/`weightUnit`; volumeCbm correct for CM & MM

**Files:**
- Modify: `apps/api/src/modules/cargo/*.service.ts` (create/update payload mapping + the `shapeCargo`/DTO projection)
- Test: `apps/api/test/cargo.e2e-spec.ts` (add cases; if absent, add to the existing cargo e2e)

**Interfaces:**
- Consumes: `CargoCreateInput.dimUnit/weightUnit` (Task 4).
- Produces: `CargoDto.dimUnit/weightUnit` on read.

- [ ] **Step 1: Write the failing test**

```ts
it("round-trips dimUnit/weightUnit and computes volumeCbm in m³ for CM and MM", async () => {
  const { queryId } = await freshQuery();  // helper that mints a query
  // CM: 100×50×40, qty 2 → 0.4 m³
  const cm = await api().post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie())
    .send({ productName: "A", packageType: "Box", qty: 2, dimL: 100, dimW: 50, dimH: 40, grossWt: 1, dimUnit: "CM", weightUnit: "KG" }).expect(201);
  expect(cm.body.dimUnit).toBe("CM");
  expect(Number(cm.body.volumeCbm)).toBeCloseTo(0.4, 4);
  // MM: same physical box → same 0.4 m³
  const mm = await api().post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie())
    .send({ productName: "B", packageType: "Box", qty: 2, dimL: 1000, dimW: 500, dimH: 400, grossWt: 1, dimUnit: "MM", weightUnit: "GM" }).expect(201);
  expect(mm.body.weightUnit).toBe("GM");
  expect(Number(mm.body.volumeCbm)).toBeCloseTo(0.4, 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @svyft/api test:e2e -- cargo` (or the project's e2e command)
Expected: FAIL — `dimUnit` not persisted/returned (or CI shows the failure).

- [ ] **Step 3: Write minimal implementation**

In the cargo service create/update, include `dimUnit` and `weightUnit` in the Prisma `data` (they arrive validated from the schema). In the DTO projection (`shapeCargo` / wherever `CargoDto` is built), add `dimUnit: row.dimUnit, weightUnit: row.weightUnit`. `volumeCbm` stays read-only (DB-generated).

- [ ] **Step 4: Run test to verify it passes** — same command; Expected: PASS (locally or on CI).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/cargo apps/api/test/cargo.e2e-spec.ts
git commit -m "feat(api): persist + return cargo dimUnit/weightUnit; unit-aware volumeCbm verified"
```

---

### Task 8: API — weight roll-ups normalize to kg

**Files:**
- Modify: `apps/api/src/modules/queries/queries.service.ts:315-319`
- Test: `apps/api/test/routing.e2e-spec.ts` or `create-query-route.e2e-spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("leg totalGrossWt sums in kg across mixed weight units", async () => {
  // Build a leg carrying a 5 kg row and a 5000 gm row → total 10 kg.
  const { queryId, legId } = await legWithTwoCargo(
    { grossWt: 5, weightUnit: "KG" },
    { grossWt: 5000, weightUnit: "GM" },
  );
  const res = await api().get(`/api/queries/${queryId}`).set("Cookie", cookie()).expect(200);
  const leg = res.body.legs.find((l: { id: string }) => l.id === legId);
  expect(leg.rollup.totalGrossWt).toBeCloseTo(10, 3);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL — sum is 5005 (raw), not 10.

- [ ] **Step 3: Write minimal implementation**

Import `toKg` from `@svyft/shared`; change the two weight reducers:

```ts
          totalGrossWt: attached.reduce((s, c) => s + toKg(num(c.grossWt), c.weightUnit), 0),
          totalNetWt: attached.reduce((s, c) => s + (c.netWt == null ? 0 : toKg(num(c.netWt), c.weightUnit)), 0),
```

(`attached` rows must include `weightUnit` — ensure the `select`/shape includes it.)

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/queries/queries.service.ts apps/api/test
git commit -m "fix(api): normalize leg weight roll-ups to kg by weightUnit"
```

---

### Task 9: API — Incoterms "N/A" persists (regression for 2b)

**Files:**
- Test: `apps/api/test/queries.e2e-spec.ts` (or the query create/patch e2e)
- (No source change expected beyond the migration/enum from Task 6 — this task proves it.)

- [ ] **Step 1: Write the failing test**

```ts
it("saves and returns Incoterms 'NA' (regression: N/A was silently dropped)", async () => {
  const { queryId } = await freshQuery();
  await api().patch(`/api/queries/${queryId}`).set("Cookie", cookie())
    .send({ incoterms: "NA" }).expect(200);
  const res = await api().get(`/api/queries/${queryId}`).set("Cookie", cookie()).expect(200);
  expect(res.body.incoterms).toBe("NA");
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL pre-migration (enum rejects/drops NA). After Task 6 it should pass; if the query PATCH DTO restricts incoterms, ensure `querySaveSchema` uses `z.enum(INCOTERMS)` (now includes NA).

- [ ] **Step 3: Fix if needed** — confirm `querySaveSchema.incoterms` = `z.enum(INCOTERMS)`; no other change expected.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test
git commit -m "test(api): Incoterms NA persists end-to-end (2b regression)"
```

---

### Task 10: Web — Step 1 renames (Shipment Dates / Target Pickup)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.tsx:603,610,619,624`
- Test: `apps/web/src/features/query-wizard/steps/Step1Client.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it("shows the Shipment Dates section with a Target Pickup label", async () => {
  renderStep1();               // existing helper in this test file
  expect(await screen.findByText("Shipment Dates")).toBeInTheDocument();
  expect(screen.getByText("Target Pickup")).toBeInTheDocument();
  expect(screen.queryByText(/^Ready Date$/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @svyft/web exec vitest run src/features/query-wizard/steps/Step1Client.test.tsx` → FAIL.

- [ ] **Step 3: Write minimal implementation** — in `Step1Client.tsx`: change `<h2>Delivery</h2>` → `Shipment Dates`; `label="Ready Date"` → `label="Target Pickup"`; the tz `<FormLabel>Ready Date timezone</FormLabel>` → `Target Pickup timezone` and its `ariaLabel`. (Field `name="readyDate"` unchanged.)

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/Step1Client.tsx apps/web/src/features/query-wizard/steps/Step1Client.test.tsx
git commit -m "feat(web): Step 1 rename — Shipment Dates / Target Pickup (label only)"
```

---

### Task 11: Web — Step 2 Incoterms default "N/A" + label + saves

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step2Shipment.tsx` (default value + `SelectItem` label via `incotermsLabel`)
- Test: `apps/web/src/features/query-wizard/steps/Step2Shipment.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it("defaults Incoterms to N/A and PATCHes incoterms='NA' on save", async () => {
  const patch = renderStep2Fresh();      // helper returning the mocked PATCH spy
  // default shown
  expect(screen.getByLabelText("Incoterms")).toHaveTextContent("N/A");
  await save();                          // existing save helper
  expect(patch).toHaveBeenCalledWith(expect.objectContaining({ incoterms: "NA" }));
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (default is "Select"/undefined).

- [ ] **Step 3: Write minimal implementation**

- Import `incotermsLabel` from `@svyft/shared`.
- In `fromDetail`, default incoterms: `(detail.incoterms as …) ?? "NA"`.
- Render each option label via `incotermsLabel(term)`:

```tsx
{INCOTERMS.map((term) => (
  <SelectItem key={term} value={term}>{incotermsLabel(term)}</SelectItem>
))}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS. (Rebuild shared first: `pnpm --filter @svyft/shared build`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/Step2Shipment.tsx apps/web/src/features/query-wizard/steps/Step2Shipment.test.tsx
git commit -m "feat(web): Incoterms default N/A + display label; value 'NA' now saves"
```

---

### Task 12: Web — CargoRowForm: optional PO + OUT_OF_GAUGE tag

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/cargo/CargoRowForm.tsx` (PO label `*` removed in both Add/Edit; `ReferenceTags` uses `referenceTagLabel`)
- Test: `apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it("saves a cargo row with a blank PO and offers the Out of Gauge Cargo tag", async () => {
  const { submit } = renderAddCargo();   // existing helper
  await fillRequired({ productName: "Widget", packageType: "Box", qty: "1", dimL: "1", dimW: "1", dimH: "1", grossWt: "1" });
  expect(screen.getByText("Out of Gauge Cargo")).toBeInTheDocument();
  await clickSave();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ poReference: "" }));
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (PO required blocks save; tag label reads "OUT OF GAUGE").

- [ ] **Step 3: Write minimal implementation**

- Remove the `<span className="text-destructive">*</span>` from both PO `<FormLabel>`s.
- In `ReferenceTags`, render `referenceTagLabel(tag)` instead of `tag.replace(/_/g, " ")` (import it). `REFERENCE_TAGS` now includes OUT_OF_GAUGE automatically.

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS (rebuild shared first).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/cargo/CargoRowForm.tsx apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx
git commit -m "feat(web): optional PO + Out of Gauge Cargo tag in cargo form"
```

---

### Task 13: Web — CargoRowForm: dimension & weight unit dropdowns + unit-aware CBM preview

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/cargo/CargoRowForm.tsx` (both Add + Edit: one dim-unit Select by L/W/H, one weight-unit Select by Net/Gross, `VolumeCbmPreview` uses `cbmFromDims`, defaults include units)
- Test: `apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx`

**Interfaces:** Consumes `DIM_UNITS`, `WEIGHT_UNITS`, `cbmFromDims` (Task 1); submits `dimUnit`/`weightUnit`.

- [ ] **Step 1: Write the failing test**

```ts
it("has one dim-unit (CM/MM) + one weight-unit (KG/GM) selector and CBM tracks the unit", async () => {
  const { submit } = renderAddCargo();
  // one dropdown each (default CM/KG)
  const dimUnit = screen.getByLabelText("Dimension unit");
  const wtUnit = screen.getByLabelText("Weight unit");
  await fillRequired({ productName: "W", packageType: "Box", qty: "2", dimL: "1000", dimW: "500", dimH: "400", grossWt: "1" });
  await selectOption(dimUnit, "MM");          // drive the hidden native <select>
  // CBM preview shows 0.4000 for the mm box
  expect(screen.getByLabelText("Volume (CBM)")).toHaveValue("0.4000");
  await selectOption(wtUnit, "GM");
  await clickSave();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ dimUnit: "MM", weightUnit: "GM" }));
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (no unit dropdowns; CBM preview divides by 1e6 always).

- [ ] **Step 3: Write minimal implementation**

- Add `dimUnit`/`weightUnit` to both forms' `defaultValues` (`"CM"`/`"KG"`; Edit reads `row.dimUnit`/`row.weightUnit`).
- Add **one** dim-unit `Select` (options `DIM_UNITS`, `aria-label="Dimension unit"`) placed in the dims grid, and **one** weight-unit `Select` (options `WEIGHT_UNITS`, `aria-label="Weight unit"`) in the weights grid. Wire via `FormField`/`Controller`.
- Change the dim labels from `L (cm)` → `L`, etc. (unit now shown by the dropdown); likewise `Net Wt`/`Gross Wt` drop the `(kg)`.
- `VolumeCbmPreview` takes `dimUnit` and uses `cbmFromDims(dimL, dimW, dimH, qty, dimUnit)`; give the preview `<Input aria-label="Volume (CBM)">`.

Example dim-unit control (place inside the dims grid):

```tsx
<FormField control={form.control} name="dimUnit" render={({ field }) => (
  <FormItem>
    <FormLabel>Unit</FormLabel>
    <Select value={field.value ?? "CM"} onValueChange={field.onChange}>
      <SelectTrigger aria-label="Dimension unit"><SelectValue /></SelectTrigger>
      <SelectContent>{DIM_UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
    </Select>
  </FormItem>
)} />
```

(Mirror for `weightUnit` with `WEIGHT_UNITS` + `aria-label="Weight unit"`.)

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS (rebuild shared first).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/cargo/CargoRowForm.tsx apps/web/src/features/query-wizard/steps/Step3Cargo.test.tsx
git commit -m "feat(web): one dim-unit + one weight-unit selector; unit-aware CBM preview"
```

---

### Task 14: Web — datetime fields default to `:00` minutes (editable)

**Files:**
- Modify: `apps/web/src/components/ZonedDateTimeField.tsx`
- Test: `apps/web/src/components/ZonedDateTimeField.test.tsx` (create if absent)

**Behavior:** when the user picks a value whose minutes are non-zero on first entry from empty, snap to `:00`; subsequent edits are respected. Simplest robust rule: **on change, if the field was previously empty, zero the minutes**; always keep the input editable.

- [ ] **Step 1: Write the failing test**

```ts
it("defaults minutes to :00 when a value is first entered, but stays editable", async () => {
  const onValue = vi.fn();
  render(<Harness zone="Asia/Kolkata" onValue={onValue} />);  // wraps ZonedDateTimeField with a spy
  const input = screen.getByLabelText("Ready");
  fireEvent.change(input, { target: { value: "2026-08-01T09:37" } });
  // stored UTC corresponds to 09:00 wall-clock, not 09:37
  expect(utcToZonedInput(onValue.mock.calls.at(-1)![0], "Asia/Kolkata")).toBe("2026-08-01T09:00");
  // editing again to :30 is respected (not re-zeroed)
  fireEvent.change(input, { target: { value: "2026-08-01T11:30" } });
  expect(utcToZonedInput(onValue.mock.calls.at(-1)![0], "Asia/Kolkata")).toBe("2026-08-01T11:30");
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (minutes preserved as :37).

- [ ] **Step 3: Write minimal implementation**

In `ZonedDateTimeField`'s `onChange`, when the previous `field.value` was empty and the new wall-clock has non-zero minutes, replace the minutes with `00` before converting:

```tsx
onChange={(e) => {
  let v = e.target.value;
  const wasEmpty = !field.value;
  if (v && wasEmpty) v = v.slice(0, 14) + "00";   // "YYYY-MM-DDTHH:" + "00"
  field.onChange(v ? zonedInputToUtc(v, zone) : undefined);
  onChanged?.();
}}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ZonedDateTimeField.tsx apps/web/src/components/ZonedDateTimeField.test.tsx
git commit -m "feat(web): datetime fields default minutes to :00 (editable) — all screens"
```

---

### Task 15: Docs — align Functional Spec + Technical Design + Handoff

**Files:**
- Modify: `docs/Stage 3 - Create Query - Functional Spec.md` (§7.1, §7.2, §7.3, §10.1)
- Modify: `docs/Stage 3 - Technical Design.md` (§4.2 CargoItem, §4.5 derived)
- Modify: `docs/Stage 3 - Session Handoff.md` (Round 3 record)

- [ ] **Step 1: Functional Spec edits**
  - §7.1: section "Delivery" → "Shipment Dates"; "Ready Date" row → "Target Pickup" (note: internal field `readyDate`, UI label only).
  - §7.2: Incoterms — default value **"N/A"** (a valid value; stored as `NA`).
  - §7.3: PO Reference → **optional**; Reference Tags list adds **"Out of Gauge Cargo"**; Dimensions row → note the **CM/MM** selector (default CM); Net/Gross → **KG/GM** selector (default KG); Volume CBM is always **m³**.
  - §10.1: F1/F5 — remove PO Reference from the mandatory set; add a note "datetime inputs default to `:00` minutes (editable)".

- [ ] **Step 2: Technical Design edits**
  - §4.2 `CargoItem`: add `dimUnit (CM·MM)`, `weightUnit (KG·GM)`; `referenceTags` includes OUT_OF_GAUGE; `volumeCbm` = unit-aware generated column (m³); `Incoterms` enum includes `NA`.
  - §4.5 derived-on-read: leg weight roll-ups **normalize to kg** by `weightUnit`; CBM roll-up sums m³ directly.

- [ ] **Step 3: Handoff edit** — add a "Round 3 (Cargo UI, units & small fixes)" bullet summarizing the shipped scope + the branch/PR.

- [ ] **Step 4: Commit**

```bash
git add "docs/Stage 3 - Create Query - Functional Spec.md" "docs/Stage 3 - Technical Design.md" "docs/Stage 3 - Session Handoff.md"
git commit -m "docs(stage-3): align Functional Spec + Technical Design + handoff with Round 3"
```

---

## Final gate (before PR)

- [ ] `pnpm --filter @svyft/shared build` then `pnpm run ci` (shared + web + api build/typecheck/lint) green.
- [ ] Web: `pnpm --filter @svyft/web typecheck` (vite build skips type errors).
- [ ] API e2e green on CI (fresh migrated Postgres — proves the migration + unit round-trips + Incoterms NA).
- [ ] Opus whole-branch review; fix Critical/Important before finishing.
- [ ] Finish via `superpowers:finishing-a-development-branch` → PR off `main` (`feat/stage-3-round3-cargo-ui`, already created).

## Self-review — spec coverage

| Spec item | Task |
|---|---|
| 1a Delivery→Shipment Dates | 10 |
| 1b Ready Date→Target Pickup | 10 |
| 2a Incoterms default N/A | 11 |
| 2b Incoterms N/A not saving | 3 (shared), 6 (enum), 9 (e2e), 11 (UI) |
| 3a PO optional | 4 (schema), 5 (label fallback), 12 (UI) |
| 3b OUT_OF_GAUGE tag | 2 (shared), 6 (enum), 12 (UI) |
| 3c dim unit CM/MM | 1, 4, 6, 7, 13 |
| 3d weight unit KG/GM | 1, 4, 6, 7 (persist), 8 (roll-up), 13 |
| volumeCbm always m³ | 1 (helper), 6 (generated col), 7 (e2e) |
| 4 datetime :00 | 14 |
| Docs alignment | 15 |
