# Stage 3 — Cargo Packing-List Re-model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `CargoItem` with a `Query → Cargo → Package → Item` hierarchy so a logistics executive enters a packing list once — packages (freight units) and their items (commercial/customs lines) — with derived roll-ups, tag-union DG, and package-grain leg mapping.

**Architecture:** Bottom-up. `@svyft/shared` (Zod schemas + enums + canonical-unit helpers + tag union, TDD units) → one hand-authored Prisma migration that **renames `CargoItem` → `Package`** (so `LegCargo`/`QuoteCargoLine` keep their FK target) and adds thin `Cargo` parent + `Item` child → NestJS `cargo`/`package`/`item` services (canonical cm/kg storage, derived headers, `ChangeMediator`-routed) → React nested-popup UI (main table = cargo rows, two-level expansion) → docs. Dims/weights are stored **canonical cm/kg**; `volumeCbm` is a simplified generated column `dimL*dimW*dimH/1e6`; header totals H4–H8 are **derived on read, never stored**.

**Tech Stack:** pnpm monorepo · `@svyft/shared` (Zod + const-enums) · NestJS 10 + Prisma 5.22 / PostgreSQL (Neon 15) · `exceljs` · Vite + React + shadcn/Radix + RHF · Vitest (shared/web) / Jest + supertest (api e2e).

**Design source:** `docs/superpowers/specs/2026-08-05-stage3-cargo-packing-list-design.md` (decisions C1–C14, open items O1–O5). Citations like C6/V‑5/H4 point into that spec.

## Global Constraints

*(Every task's requirements implicitly include this section. Values verified against the current tree and the Stage-3 handoff.)*

- **Node** `>=20 <21`; **pnpm** `9.x`; **TypeScript** `^5.6`, `strict`. **Prettier:** double quotes, semicolons, `trailingComma: all`, `printWidth: 100`.
- **Branch:** `feat/stage-3-cargo-packing-list` (off `main`). Plan doc + implementation ship as **one PR**. **Conventional Commits**, one commit per task, each ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Typecheck per task:** vitest/jest (esbuild) do **not** type-check. After each task run `pnpm --filter @svyft/shared typecheck` / `--filter @svyft/api typecheck` / `--filter @svyft/web typecheck` as relevant — type errors otherwise pile up silently in test files.
- **`@svyft/shared` resolution:** api/web **typecheck/build** resolve `@svyft/shared` from its **built `dist`** → run `pnpm --filter @svyft/shared build` **before** any api/web typecheck/build that depends on new shared code. api **jest** maps `@svyft/shared` → `packages/shared/src/index.ts` (no rebuild needed for api tests).
- **Shared "enums":** `const` object + `(typeof X)[keyof typeof X]` union + `Object.values(...) as [X, ...X[]]` array, **pinned by a `toEqual` test**. **Never** a TS `enum`. See [role.ts](packages/shared/src/role.ts), [cargo.ts](packages/shared/src/cargo.ts).
- **Validation binds at PARAM level:** `@Body(new ZodValidationPipe(schema))` — **never** method-level `@UsePipes` (Nest applies it to `@Param()` too). See [cargo.controller.ts](apps/api/src/modules/cargo/cargo.controller.ts).
- **Prisma errors:** global `PrismaExceptionFilter` maps `P2025→404`, `P2023→400` (bad uuid), `P2002→409`. **`P2003` (FK) is NOT mapped** → verify referenced ids in the service and throw `BadRequestException`. Don't hand-roll 500s.
- **Mediation:** never raw-write a user-editable Cargo/Package/Item field — route through `ChangeMediator.apply(req, uow)` ([change-mediator.ts](apps/api/src/modules/changes/change-mediator.ts)); declare impact via `ImpactRegistry.declare(entity, map)`. Initial `POST` create is the entity's birth (not mediated); create/delete of packages/items ARE mediated `@create`/`@delete`. **Never hand-write `Query.status`** (projector only).
- **RBAC:** cargo/package/item are **workflow-write** endpoints → **auth-only (Exec+), no `@Roles`** (matches today's cargo endpoints; only master-data writes gate to Admin/Manager).
- **API tests** use `*.e2e-spec.ts`, boot `AppModule` against **local dev Postgres** (`apps/api/.env` → `postgresql://…@localhost:5433/svyft`). First line, **before imports**: `process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";`. Auth cookie: `` `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub, role, tenantId: null })}` `` (see [cargo.e2e-spec.ts](apps/api/test/cargo.e2e-spec.ts)). `sub` must be a **uuid** (lands in `@db.Uuid` columns).
- **CI runs a fresh migrated-but-UNSEEDED Postgres.** Every test is **seed-independent + self-cleaning**: `seedReferenceData(prisma)` for the 9 checklist items, create its own users/clients, delete its own rows by a **unique prefix** in `beforeAll`/`afterAll`. Verify the whole branch against `prisma migrate reset --force --skip-seed` before pushing, then `gh run watch`.
- **Migrations:** Prisma cannot express the **generated column**, an **enum `ADD VALUE`**, or a table/column **rename that preserves data** → those migrations are **hand-authored** (Postgres 12+; Neon is 15). Run `migrate dev` against **local** only; CI/prod use `migrate deploy`.
- **Web tests:** `renderWithProviders` + `mockFetch`; Radix `Select` is jsdom-flaky → drive the hidden native `<select>` / assert values (see [CargoRowForm](apps/web/src/features/query-wizard/steps/cargo/CargoRowForm.tsx) tests).

## File structure

**`packages/shared/src/`**
- `cargo.ts` — **rewrite**: add `PackageType`/`UnitOfMeasure` enums, `DG` tag, `TONNE` unit; canonical helpers (`toCanonicalDim`/`fromCanonicalDim`, `toCanonicalWeight`/`fromCanonicalWeight`, `cbmFromCanonical`); `effectiveTags`; `cargoSchema`/`packageSchema`/`itemSchema` (+ update variants); `CargoDto`/`PackageDto`/`ItemDto`; update `collectCreateFindings` inputs.
- `query.ts` — **modify:** `collectCreateFindings` cargo arm → per-package DG→MSDS + dims/gross present.
- `cargo.test.ts`, `query.test.ts` — extend.

**`prisma/`**
- `schema.prisma` — enums + `Cargo`/`Package`(ex-`CargoItem`)/`Item` + `LegPackage`(ex-`LegCargo`) + `QuoteCargoLine.packageId`.
- `migrations/20260805_cargo_packing_list/migration.sql` — **hand-authored**.

**`apps/api/src/modules/`**
- `cargo/` — repurpose to the **Cargo grouping** (`cargo.service.ts`, `cargo.controller.ts`, `cargo.impact.ts`, `cargo.module.ts`).
- `cargo/package.*` + `cargo/item.*` — new services/controllers/impact under the cargo module (co-located; one domain).
- `legs/legs.service.ts`, `legs/leg.impact.ts` — repoint `assignedCargoIds`→`assignedPackageIds`, `LegCargo`→`LegPackage`.
- `queries/queries.service.ts` — leg roll-up simplify + `assignedPackageIds` projection.

**`apps/web/src/features/query-wizard/steps/`**
- `cargo/` — `useCargo.ts` (cargo grouping) + `usePackages.ts` + `useItems.ts`; `Step3Cargo.tsx` (main table + expansion); `cargo/CargoPopup.tsx`, `cargo/PackageEditor.tsx`, `cargo/ItemsMiniTable.tsx` (replace `CargoRowForm.tsx`).
- `legs/CargoAssignmentControl.tsx`, `legs/cargoConflicts.ts`, `legs/useLegs.ts` — package grain.

---

## Phase 1 — Shared contracts

### Task 1: Shared — enums + canonical-unit helpers

**Files:**
- Modify: `packages/shared/src/cargo.ts`
- Test: `packages/shared/src/cargo.test.ts`

**Interfaces — Produces:**
- `PackageType` (`BOX·PALLET·CRATE·CARTON·DRUM·BUNDLE`) + `PACKAGE_TYPES`; `UnitOfMeasure` (`PC·SET·BOX·KG·M·ROLL`) + `UOMS`.
- `ReferenceTag` gains `DG`; `WeightUnit` gains `TONNE`.
- `toCanonicalDim(v:number, u:DimUnit):number` (→ cm), `fromCanonicalDim(vCm:number, u:DimUnit):number`.
- `toCanonicalWeight(v:number, u:WeightUnit):number` (→ kg), `fromCanonicalWeight(vKg:number, u:WeightUnit):number`.
- `cbmFromCanonical(dimLcm, dimWcm, dimHcm):number` (m³).
- `packageTypeLabel`, `uomLabel`, `weightUnitLabel` (`GM`→"g", `TONNE`→"tonne").

- [ ] **Step 1: Write the failing test** (append to `cargo.test.ts`)

```ts
import {
  PACKAGE_TYPES, UOMS, REFERENCE_TAGS, WEIGHT_UNITS,
  toCanonicalDim, fromCanonicalDim, toCanonicalWeight, fromCanonicalWeight,
  cbmFromCanonical, weightUnitLabel,
} from "./cargo";

describe("packing-list vocabularies", () => {
  it("pins package types + UoMs", () => {
    expect(PACKAGE_TYPES).toEqual(["BOX", "PALLET", "CRATE", "CARTON", "DRUM", "BUNDLE"]);
    expect(UOMS).toEqual(["PC", "SET", "BOX", "KG", "M", "ROLL"]);
  });
  it("adds DG and TONNE", () => {
    expect(REFERENCE_TAGS).toContain("DG");
    expect(WEIGHT_UNITS).toEqual(["KG", "TONNE", "GM"]);
  });
});

describe("canonical unit helpers", () => {
  it("dims round-trip cm/mm to canonical cm", () => {
    expect(toCanonicalDim(100, "CM")).toBe(100);
    expect(toCanonicalDim(1000, "MM")).toBe(100);          // 1000 mm = 100 cm
    expect(fromCanonicalDim(100, "MM")).toBe(1000);        // 100 cm shown as 1000 mm
    expect(fromCanonicalDim(toCanonicalDim(37, "MM"), "MM")).toBeCloseTo(37, 9); // V-6 round-trip
  });
  it("weights round-trip kg/tonne/g to canonical kg", () => {
    expect(toCanonicalWeight(5, "KG")).toBe(5);
    expect(toCanonicalWeight(2, "TONNE")).toBe(2000);
    expect(toCanonicalWeight(5000, "GM")).toBe(5);
    expect(fromCanonicalWeight(2000, "TONNE")).toBe(2);
  });
  it("cbmFromCanonical returns m³ from cm dims", () => {
    expect(cbmFromCanonical(100, 50, 40)).toBeCloseTo(0.2, 9); // one package, no ×qty
  });
  it("labels g and tonne", () => {
    expect(weightUnitLabel("GM")).toBe("g");
    expect(weightUnitLabel("TONNE")).toBe("tonne");
    expect(weightUnitLabel("KG")).toBe("kg");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts`
Expected: FAIL — `PACKAGE_TYPES`/`toCanonicalDim`/etc. not exported; `WEIGHT_UNITS` lacks `TONNE`; `REFERENCE_TAGS` lacks `DG`.

- [ ] **Step 3: Implement in `cargo.ts`** (add near the existing enums; extend `ReferenceTag`/`WeightUnit`)

```ts
export const PackageType = {
  BOX: "BOX", PALLET: "PALLET", CRATE: "CRATE", CARTON: "CARTON", DRUM: "DRUM", BUNDLE: "BUNDLE",
} as const;
export type PackageType = (typeof PackageType)[keyof typeof PackageType];
export const PACKAGE_TYPES = Object.values(PackageType) as [PackageType, ...PackageType[]];

export const UnitOfMeasure = {
  PC: "PC", SET: "SET", BOX: "BOX", KG: "KG", M: "M", ROLL: "ROLL",
} as const;
export type UnitOfMeasure = (typeof UnitOfMeasure)[keyof typeof UnitOfMeasure];
export const UOMS = Object.values(UnitOfMeasure) as [UnitOfMeasure, ...UnitOfMeasure[]];
```

Extend the existing const objects (keep order stable; append new members):
- `ReferenceTag` — add `DG: "DG"`.
- `WeightUnit` — add `TONNE: "TONNE"` **between** `KG` and `GM` so `WEIGHT_UNITS` = `["KG","TONNE","GM"]`.

Add helpers (canonical = cm, kg; volume m³):

```ts
export function toCanonicalDim(v: number, u: DimUnit): number {
  return u === "MM" ? v / 10 : v;            // mm → cm
}
export function fromCanonicalDim(vCm: number, u: DimUnit): number {
  return u === "MM" ? vCm * 10 : vCm;
}
export function toCanonicalWeight(v: number, u: WeightUnit): number {
  if (u === "TONNE") return v * 1000;
  if (u === "GM") return v / 1000;
  return v;                                   // KG
}
export function fromCanonicalWeight(vKg: number, u: WeightUnit): number {
  if (u === "TONNE") return vKg / 1000;
  if (u === "GM") return vKg * 1000;
  return vKg;
}
/** Volume in m³ from a single package's canonical-cm dims (no ×qty). */
export function cbmFromCanonical(dimLcm: number, dimWcm: number, dimHcm: number): number {
  return (dimLcm * dimWcm * dimHcm) / 1e6;
}

const PACKAGE_TYPE_LABELS: Record<PackageType, string> = {
  BOX: "Box", PALLET: "Pallet", CRATE: "Crate", CARTON: "Carton", DRUM: "Drum", BUNDLE: "Bundle",
};
export function packageTypeLabel(t: PackageType): string { return PACKAGE_TYPE_LABELS[t] ?? t; }
const UOM_LABELS: Record<UnitOfMeasure, string> = {
  PC: "pc", SET: "set", BOX: "box", KG: "kg", M: "m", ROLL: "roll",
};
export function uomLabel(u: UnitOfMeasure): string { return UOM_LABELS[u] ?? u; }
export function weightUnitLabel(u: WeightUnit): string {
  return u === "GM" ? "g" : u === "TONNE" ? "tonne" : "kg";
}
```

Add `DG` to the existing `REFERENCE_TAG_LABELS` (`DG: "Dangerous Goods"`).

- [ ] **Step 4: Run the tests to verify they pass** — same command; Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @svyft/shared typecheck
git add packages/shared/src/cargo.ts packages/shared/src/cargo.test.ts
git commit -m "feat(shared): PackageType/UnitOfMeasure enums, DG tag, TONNE unit, canonical-unit helpers"
```

---

### Task 2: Shared — Cargo/Package/Item schemas, DTOs, tag union, create-validation

**Files:**
- Modify: `packages/shared/src/cargo.ts`, `packages/shared/src/query.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/cargo.test.ts`, `packages/shared/src/query.test.ts`

**Interfaces — Produces:**
- `cargoCreateSchema`/`cargoUpdateSchema` (`poReference?`, `label?`, `dimUnit`, `weightUnit`).
- `packageCreateSchema`/`packageUpdateSchema` (`packageNo`, `packageType`(enum), `dimL/W/H`, `grossWt`, `netWt?`, `tags[]`) — **entry-unit values** (converted server-side).
- `itemCreateSchema`/`itemUpdateSchema` (`product?`, `qty?`, `uom?`, `hsCode?`, `tags[]`) with V‑4 refine (`qty ⇒ uom`).
- `CargoDto` (+ derived header block), `PackageDto`, `ItemDto`.
- `effectiveTags(pkg: { tags: ReferenceTag[]; items: { tags: ReferenceTag[] }[] }): ReferenceTag[]` — union, deduped, order-stable.
- `collectCreateFindings` cargo arm → per-package DG→MSDS + dims/gross present.

- [ ] **Step 1: Write the failing test** (append to `cargo.test.ts`)

```ts
import {
  packageCreateSchema, itemCreateSchema, cargoCreateSchema, effectiveTags,
} from "./cargo";

describe("packing-list schemas", () => {
  it("cargo accepts optional PO + requires units with defaults", () => {
    expect(cargoCreateSchema.safeParse({}).success).toBe(true);
    const r = cargoCreateSchema.parse({});
    expect(r.dimUnit).toBe("CM");
    expect(r.weightUnit).toBe("KG");
  });
  it("package requires packageNo + type + dims + gross", () => {
    const base = { packageNo: "P-1", packageType: "PALLET", dimL: 120, dimW: 100, dimH: 140, grossWt: 420 };
    expect(packageCreateSchema.safeParse(base).success).toBe(true);
    expect(packageCreateSchema.safeParse({ ...base, packageType: "NUCLEAR" }).success).toBe(false);
    expect(packageCreateSchema.safeParse({ ...base, dimL: 0 }).success).toBe(false); // V-1
    expect(packageCreateSchema.safeParse({ ...base, netWt: 500 }).success).toBe(false); // V-2 net>gross
  });
  it("item requires UoM only when qty present (V-4)", () => {
    expect(itemCreateSchema.safeParse({ product: "Paint" }).success).toBe(true);        // qty absent → ok
    expect(itemCreateSchema.safeParse({ product: "Paint", qty: 8 }).success).toBe(false); // qty w/o uom
    expect(itemCreateSchema.safeParse({ product: "Paint", qty: 8, uom: "PC" }).success).toBe(true);
  });
});

describe("effectiveTags (BL-3 union)", () => {
  it("unions package + item tags, deduped, order-stable", () => {
    expect(effectiveTags({ tags: ["HEAVY"], items: [{ tags: ["DG"] }, { tags: ["HEAVY", "FRAGILE"] }] }))
      .toEqual(["HEAVY", "DG", "FRAGILE"]);
  });
});
```

Append to `query.test.ts`:

```ts
import { collectCreateFindings } from "./query";
it("flags a package with a DG item but no MSDS (F6, per package)", () => {
  const ready = { id: "q1", clientId: "c1", contactName: "Jo", contactEmail: "j@a.co",
    contactPhone: "+911234567890", readyDate: new Date(), targetDelivery: new Date(), incoterms: "FOB" as const };
  const f = collectCreateFindings(ready, [
    { id: "pk1", effectiveTags: ["DG"], msdsFileId: null, packageNo: "P-1", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 },
  ]);
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ rule: "F6", severity: "blocking", scope: { type: "package", id: "pk1" } });
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @svyft/shared exec vitest run src/cargo.test.ts src/query.test.ts` → FAIL.

- [ ] **Step 3: Implement schemas + DTOs in `cargo.ts`**

Replace the old `cargoCreateSchema`/`cargoUpdateSchema`/`CargoDto` with the three-level set:

```ts
export const cargoCreateSchema = z.object({
  poReference: z.string().trim().max(120).optional(),
  label: z.string().trim().max(160).optional(),
  dimUnit: z.enum(DIM_UNITS).default("CM"),
  weightUnit: z.enum(WEIGHT_UNITS).default("KG"),
});
export type CargoCreateInput = z.infer<typeof cargoCreateSchema>;
export const cargoUpdateSchema = cargoCreateSchema.partial();
export type CargoUpdateInput = z.infer<typeof cargoUpdateSchema>;

// Package dims/weights arrive in the CARGO's entry unit; the service converts to canonical.
export const packageCreateSchema = z.object({
  packageNo: z.string().trim().min(1).max(60),
  packageType: z.enum(PACKAGE_TYPES),
  dimL: z.number().positive().max(100000),
  dimW: z.number().positive().max(100000),
  dimH: z.number().positive().max(100000),
  grossWt: z.number().positive().max(1000000000),
  netWt: z.number().nonnegative().max(1000000000).optional(),
  tags: z.array(z.enum(REFERENCE_TAGS)).optional(),
}).refine((p) => p.netWt === undefined || p.netWt <= p.grossWt, {
  message: "Net weight must be ≤ gross weight", path: ["netWt"],   // V-2
});
export type PackageCreateInput = z.infer<typeof packageCreateSchema>;
export const packageUpdateSchema = z.object({
  packageNo: z.string().trim().min(1).max(60),
  packageType: z.enum(PACKAGE_TYPES),
  dimL: z.number().positive().max(100000),
  dimW: z.number().positive().max(100000),
  dimH: z.number().positive().max(100000),
  grossWt: z.number().positive().max(1000000000),
  netWt: z.number().nonnegative().max(1000000000).nullable(),
  tags: z.array(z.enum(REFERENCE_TAGS)),
  reason: z.string().trim().min(1).max(500),   // SB6 change-order metadata (stripped before Prisma)
}).partial().refine((p) => p.netWt == null || p.grossWt == null || p.netWt <= p.grossWt, {
  message: "Net weight must be ≤ gross weight", path: ["netWt"],
});
export type PackageUpdateInput = z.infer<typeof packageUpdateSchema>;

export const itemCreateSchema = z.object({
  product: z.string().trim().max(200).optional(),
  qty: z.number().positive().max(1000000000).optional(),
  uom: z.enum(UOMS).optional(),
  hsCode: z.string().trim().max(40).optional(),
  tags: z.array(z.enum(REFERENCE_TAGS)).optional(),
}).refine((i) => i.qty === undefined || i.uom !== undefined, {
  message: "Unit of measure is required when a quantity is entered", path: ["uom"],   // V-4
});
export type ItemCreateInput = z.infer<typeof itemCreateSchema>;
export const itemUpdateSchema = z.object({
  product: z.string().trim().max(200).nullable(),
  qty: z.number().positive().max(1000000000).nullable(),
  uom: z.enum(UOMS).nullable(),
  hsCode: z.string().trim().max(40).nullable(),
  tags: z.array(z.enum(REFERENCE_TAGS)),
}).partial().refine((i) => i.qty == null || i.uom != null, {
  message: "Unit of measure is required when a quantity is entered", path: ["uom"],
});
export type ItemUpdateInput = z.infer<typeof itemUpdateSchema>;

export interface ItemDto {
  id: string; rowIndex: number;
  product: string | null; qty: string | null; uom: UnitOfMeasure | null;
  hsCode: string | null; tags: ReferenceTag[];
}
export interface PackageDto {
  id: string; rowIndex: number; packageNo: string; packageType: PackageType;
  dimL: string; dimW: string; dimH: string;      // canonical cm (Decimal → string)
  grossWt: string; netWt: string | null;         // canonical kg
  volumeCbm: string | null;                       // m³
  tags: ReferenceTag[];                           // own tags
  effectiveTags: ReferenceTag[];                  // own ∪ item tags (derived)
  msdsFileId: string | null;
  items: ItemDto[];
}
export interface CargoDto {
  id: string; rowIndex: number;
  poReference: string | null; label: string | null;
  dimUnit: DimUnit; weightUnit: WeightUnit;
  packages: PackageDto[];
  // derived header (H4–H8) — computed by the service, never stored
  packageCount: number; grossWeightKg: string; volumeCbm: string;
  tags: ReferenceTag[]; chargeableWeight: null;
}

export function effectiveTags(pkg: { tags: ReferenceTag[]; items: { tags: ReferenceTag[] }[] }): ReferenceTag[] {
  const seen = new Set<ReferenceTag>();
  const out: ReferenceTag[] = [];
  for (const t of [...pkg.tags, ...pkg.items.flatMap((i) => i.tags)]) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}
```

- [ ] **Step 4: Update `collectCreateFindings` in `query.ts`**

Change the `CargoForValidation` interface + the cargo loop to package grain:

```ts
export interface PackageForValidation {
  id: string; effectiveTags: ReferenceTag[]; msdsFileId: string | null;
  packageNo: string; dimL: number; dimW: number; dimH: number; grossWt: number;
}
// in collectCreateFindings, replace the cargo arm:
for (const p of packages) {
  if (p.effectiveTags.includes("DG") && !p.msdsFileId) {
    findings.push({ rule: "F6", severity: "blocking", scope: { type: "package", id: p.id },
      message: `Package ${p.packageNo}: a dangerous-goods package requires an MSDS (PDF)` });
  }
}
```

(Import `ReferenceTag` from `./cargo`. Update the function's second parameter type + its callers in Task 4/5.)

- [ ] **Step 5: Export + run + build**

Ensure `index.ts` still `export * from "./cargo"`. Run `pnpm --filter @svyft/shared exec vitest run` (whole shared suite — the DTO/type changes ripple). Expected: PASS. Then `pnpm --filter @svyft/shared typecheck` and `pnpm --filter @svyft/shared build`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/cargo.ts packages/shared/src/query.ts packages/shared/src/cargo.test.ts packages/shared/src/query.test.ts
git commit -m "feat(shared): cargo/package/item schemas + DTOs + effectiveTags union + per-package DG create-finding"
```

---

## Phase 2 — Prisma model + migration

### Task 3: Prisma — Cargo/Package/Item models + hand-authored migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260805_cargo_packing_list/migration.sql`
- Test: `apps/api/test/cargo-packing-model.e2e-spec.ts`

**Interfaces — Produces:** models `Cargo`, `Package` (ex-`CargoItem`), `Item`, `LegPackage` (ex-`LegCargo`); `QuoteCargoLine.packageId`; enums `PackageType`/`UnitOfMeasure`; `ReferenceTag.DG`; `WeightUnit.TONNE`. `Package.volumeCbm` = `GENERATED ALWAYS AS (dimL*dimW*dimH/1e6) STORED`.

- [ ] **Step 1: Write the failing test** `apps/api/test/cargo-packing-model.e2e-spec.ts`

```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

const PFX = "cpl-model-";
describe("Cargo/Package/Item model (e2e)", () => {
  let app: INestApplication; let prisma: PrismaService;
  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication(); await app.init(); prisma = m.get(PrismaService);
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("computes volumeCbm = L*W*H/1e6 (no ×qty) and cascades cargo→package→item", async () => {
    const q = await prisma.query.create({ data: { queryCode: `Z${Date.now()}`.slice(0, 12), shipmentDescription: `${PFX}a` } });
    const cargo = await prisma.cargo.create({ data: { queryId: q.id, rowIndex: 0, poReference: "PO-1", dimUnit: "CM", weightUnit: "KG" } });
    const pkg = await prisma.package.create({ data: {
      queryId: q.id, cargoId: cargo.id, rowIndex: 0, packageNo: "P-1", packageType: "PALLET",
      dimL: 120, dimW: 100, dimH: 140, grossWt: 420, tags: ["DG"] } });
    expect(Number(pkg.volumeCbm)).toBeCloseTo(1.68, 6);           // 120*100*140/1e6
    await prisma.item.create({ data: { packageId: pkg.id, rowIndex: 0, product: "Deck paint", qty: 8, uom: "PC", hsCode: "32081090" } });
    await prisma.query.delete({ where: { id: q.id } });
    expect(await prisma.package.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.item.count({ where: { packageId: pkg.id } })).toBe(0);
  });

  it("enforces packageNo uniqueness per query (V-5)", async () => {
    const q = await prisma.query.create({ data: { queryCode: `Z${Date.now() + 1}`.slice(0, 12), shipmentDescription: `${PFX}b` } });
    const c = await prisma.cargo.create({ data: { queryId: q.id, rowIndex: 0 } });
    await prisma.package.create({ data: { queryId: q.id, cargoId: c.id, rowIndex: 0, packageNo: "DUP", packageType: "BOX", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } });
    await expect(prisma.package.create({ data: { queryId: q.id, cargoId: c.id, rowIndex: 1, packageNo: "DUP", packageType: "BOX", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @svyft/api test -- cargo-packing-model` → FAIL (`prisma.cargo`/`prisma.package`/`prisma.item` undefined).

- [ ] **Step 3: Edit `schema.prisma`**

Add enums `PackageType { BOX PALLET CRATE CARTON DRUM BUNDLE }`, `UnitOfMeasure { PC SET BOX KG M ROLL }`; add `DG` to `ReferenceTag`; add `TONNE` to `WeightUnit` (between `KG` and `GM`).

Replace `model CargoItem` with `model Package` and add `Cargo`/`Item`:

```prisma
model Cargo {
  id         String     @id @default(uuid()) @db.Uuid
  tenantId   String?    @db.Uuid
  queryId    String     @db.Uuid
  query      Query      @relation(fields: [queryId], references: [id], onDelete: Cascade)
  rowIndex   Int
  poReference String?
  label      String?
  dimUnit    DimUnit    @default(CM)
  weightUnit WeightUnit @default(KG)
  createdAt  DateTime   @default(now())
  updatedAt  DateTime   @updatedAt
  packages   Package[]
  @@index([queryId])
  @@index([tenantId])
}

model Package {
  id            String         @id @default(uuid()) @db.Uuid
  tenantId      String?        @db.Uuid
  queryId       String         @db.Uuid
  query         Query          @relation(fields: [queryId], references: [id], onDelete: Cascade)
  cargoId       String         @db.Uuid
  cargo         Cargo          @relation(fields: [cargoId], references: [id], onDelete: Cascade)
  rowIndex      Int
  packageNo     String
  packageType   PackageType
  dimL          Decimal        @db.Decimal(10, 2)
  dimW          Decimal        @db.Decimal(10, 2)
  dimH          Decimal        @db.Decimal(10, 2)
  grossWt       Decimal        @db.Decimal(12, 3)
  netWt         Decimal?       @db.Decimal(12, 3)
  tags          ReferenceTag[]
  msdsFileId    String?        @db.Uuid
  msdsFile      FileAsset?     @relation("PackageMsds", fields: [msdsFileId], references: [id])
  volumeCbm     Decimal?       @default(dbgenerated("((((\"dimL\" * \"dimW\") * \"dimH\")) / (1000000)::numeric)")) @db.Decimal(14, 6)
  packageCount  Int            @default(1)
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
  items           Item[]
  legPackages     LegPackage[]
  quoteCargoLines QuoteCargoLine[]
  @@unique([queryId, packageNo])
  @@index([queryId])
  @@index([cargoId])
  @@index([tenantId])
}

model Item {
  id        String         @id @default(uuid()) @db.Uuid
  tenantId  String?        @db.Uuid
  packageId String         @db.Uuid
  package   Package        @relation(fields: [packageId], references: [id], onDelete: Cascade)
  rowIndex  Int
  product   String?
  qty       Decimal?       @db.Decimal(14, 3)
  uom       UnitOfMeasure?
  hsCode    String?
  tags      ReferenceTag[]
  createdAt DateTime       @default(now())
  updatedAt DateTime       @updatedAt
  @@index([packageId])
  @@index([tenantId])
}
```

Rename `model LegCargo` → `model LegPackage`; rename its `cargoItemId`/`cargoItem` fields to `packageId`/`package` (relation → `Package`), and `@@unique([legId, packageId])`. In `QuoteCargoLine`, rename `cargoItemId`/`cargoItem` → `packageId`/`package` (relation → `Package`), `@@unique([quoteId, packageId])`. Update back-relations: `Query` gains `cargos Cargo[]` and keeps `packages Package[]`; `FileAsset` relation name `CargoMsds` → `PackageMsds`; `Leg.legCargo` → `legPackages LegPackage[]`.

- [ ] **Step 4: Hand-author the migration** `prisma/migrations/20260805_cargo_packing_list/migration.sql`

```sql
-- Enums
CREATE TYPE "PackageType" AS ENUM ('BOX','PALLET','CRATE','CARTON','DRUM','BUNDLE');
CREATE TYPE "UnitOfMeasure" AS ENUM ('PC','SET','BOX','KG','M','ROLL');
ALTER TYPE "ReferenceTag" ADD VALUE 'DG';
ALTER TYPE "WeightUnit" ADD VALUE 'TONNE' AFTER 'KG';

-- Cargo parent
CREATE TABLE "Cargo" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID, "queryId" UUID NOT NULL, "rowIndex" INTEGER NOT NULL,
  "poReference" TEXT, "label" TEXT,
  "dimUnit" "DimUnit" NOT NULL DEFAULT 'CM', "weightUnit" "WeightUnit" NOT NULL DEFAULT 'KG',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Cargo_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Cargo_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "Query"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Cargo_queryId_idx" ON "Cargo"("queryId");
CREATE INDEX "Cargo_tenantId_idx" ON "Cargo"("tenantId");

-- CargoItem → Package (rename table, drop the generated col first, reshape, re-add generated col)
ALTER TABLE "CargoItem" DROP COLUMN "volumeCbm";
ALTER TABLE "CargoItem" RENAME TO "Package";
ALTER TABLE "Package" RENAME CONSTRAINT "CargoItem_pkey" TO "Package_pkey";
-- new columns (nullable/temp defaults; pre-go-live test data so a NULL cargoId is acceptable to backfill or reset)
ALTER TABLE "Package" ADD COLUMN "cargoId" UUID;
ALTER TABLE "Package" ADD COLUMN "packageNo" TEXT;
ALTER TABLE "Package" ADD COLUMN "packageType" "PackageType";
ALTER TABLE "Package" ADD COLUMN "packageCount" INTEGER NOT NULL DEFAULT 1;
-- drop moved/unused columns
ALTER TABLE "Package" DROP COLUMN "poReference", DROP COLUMN "productName", DROP COLUMN "qty",
  DROP COLUMN "hsCode", DROP COLUMN "isDangerous", DROP COLUMN "dimUnit", DROP COLUMN "weightUnit",
  DROP COLUMN "freightDensity", DROP COLUMN "chargeableWeight";
-- simplified generated volume (canonical cm; no ×qty, no unit CASE)
ALTER TABLE "Package" ADD COLUMN "volumeCbm" DECIMAL(14,6)
  GENERATED ALWAYS AS ("dimL" * "dimW" * "dimH" / 1000000) STORED;
-- Package FKs/indexes
ALTER TABLE "Package" ADD CONSTRAINT "Package_cargoId_fkey" FOREIGN KEY ("cargoId") REFERENCES "Cargo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Package_cargoId_idx" ON "Package"("cargoId");
CREATE UNIQUE INDEX "Package_queryId_packageNo_key" ON "Package"("queryId","packageNo");
-- FileAsset relation name change is metadata-only (no SQL). msdsFileId column stays.

-- Item child
CREATE TABLE "Item" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID, "packageId" UUID NOT NULL, "rowIndex" INTEGER NOT NULL,
  "product" TEXT, "qty" DECIMAL(14,3), "uom" "UnitOfMeasure", "hsCode" TEXT,
  "tags" "ReferenceTag"[] NOT NULL DEFAULT ARRAY[]::"ReferenceTag"[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Item_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Item_packageId_idx" ON "Item"("packageId");
CREATE INDEX "Item_tenantId_idx" ON "Item"("tenantId");

-- LegCargo → LegPackage (rename table + FK column)
ALTER TABLE "LegCargo" RENAME COLUMN "cargoItemId" TO "packageId";
ALTER TABLE "LegCargo" RENAME TO "LegPackage";
ALTER TABLE "LegPackage" RENAME CONSTRAINT "LegCargo_pkey" TO "LegPackage_pkey";
-- (FK re-targets the same rows — CargoItem became Package; the referenced PK is unchanged.)

-- QuoteCargoLine FK column rename
ALTER TABLE "QuoteCargoLine" RENAME COLUMN "cargoItemId" TO "packageId";

-- Pre-go-live: reset any legacy cargo rows that can't satisfy the new NOT-NULLs (C14).
-- Test data only — no production preservation. Rows are re-entered via the new UI.
TRUNCATE "Item", "LegPackage", "QuoteCargoLine", "Package", "Cargo" CASCADE;
-- Now enforce NOT NULLs on Package's new required columns.
ALTER TABLE "Package" ALTER COLUMN "cargoId" SET NOT NULL;
ALTER TABLE "Package" ALTER COLUMN "packageNo" SET NOT NULL;
ALTER TABLE "Package" ALTER COLUMN "packageType" SET NOT NULL;
```

> **Note (C14):** this uses the **reset** path (design §11 fallback) — acceptable because it is pre-go-live test data. `ALTER TYPE … ADD VALUE` cannot run in the same transaction as a use of the new value; keep the enum `ADD VALUE`s at the top and do not reference `DG`/`TONNE` in this migration's data statements (we don't).

- [ ] **Step 5: Apply + verify drift**

```bash
pnpm --filter @svyft/api exec prisma migrate dev --schema ../../prisma/schema.prisma --name cargo_packing_list
pnpm --filter @svyft/api exec prisma generate --schema ../../prisma/schema.prisma
pnpm --filter @svyft/api exec prisma migrate diff --from-url "$(grep '^DATABASE_URL' apps/api/.env | cut -d'\"' -f2)" --to-schema-datamodel prisma/schema.prisma --script
```
Expected: applies clean; `migrate diff` prints `-- This is an empty migration.` (zero drift — confirms the `volumeCbm` `dbgenerated(...)` string matches).

- [ ] **Step 6: Run the model test** — `pnpm --filter @svyft/api test -- cargo-packing-model` → PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/test/cargo-packing-model.e2e-spec.ts
git commit -m "feat(prisma): Cargo/Package/Item models + LegPackage rename + simplified volumeCbm (migration)"
```

---

## Phase 3 — API

> All three services live under `apps/api/src/modules/cargo/`. Controllers mirror the existing [cargo.controller.ts](apps/api/src/modules/cargo/cargo.controller.ts) (auth-only guard, `@Body(new ZodValidationPipe(schema))` at param level, `@CurrentUser()`); modules register the impact map on init like [cargo.module.ts](apps/api/src/modules/cargo/cargo.module.ts). Each mutating write goes through `ChangeMediator.apply` (Free path in Stage 3).
>
> **Co-located DTO shapers (resolves cross-task references):** `shapeItem`/`shapePackage`/`shapeCargo` live together in a new `cargo/cargo-shape.ts`. **Task 4 creates all three** — `shapeItem`/`shapePackage` as thin skeletons returning base fields, `shapeCargo` composing them for the derived header. **Task 5** fleshes out `shapePackage` (canonical dims, `effectiveTags`, nested items); **Task 7** fleshes out `shapeItem`. So no task references a shaper before it exists.
>
> **Shared e2e helpers:** each task adds a thin POST wrapper alongside the endpoint it builds — `addCargo` (Task 4), `addPackage` (Task 5), `addItem` (Task 7), `addLeg` (Task 10) — plus `freshQuery`/`freshCargo`/`freshPackage` composed from them. Later tasks reuse these; a task's test only uses helpers whose endpoints already exist.

### Task 4: API — Cargo grouping service + derived header DTO

**Files:**
- Modify: `apps/api/src/modules/cargo/cargo.service.ts`, `cargo.controller.ts`, `cargo.impact.ts`, `cargo.module.ts`
- Test: `apps/api/test/cargo.e2e-spec.ts` (repurpose)

**Interfaces:**
- Consumes: `PrismaService`, `ChangeMediator`, `ImpactRegistry`, `@svyft/shared` schemas/DTOs (Task 2).
- Produces: `CargoService.create/update/remove/getTree(queryId)`; `shapeCargo(cargo, packages, items): CargoDto` with derived H4–H8; `cargoImpactMap` (`poReference`/`label`/`dimUnit`/`weightUnit`: `Corrective`; `@create`/`@delete`: `Structural`).

- [ ] **Step 1: Write the failing test** (add to `cargo.e2e-spec.ts`)

```ts
it("creates a cargo and returns a zeroed derived header before any packages exist", async () => {
  const { queryId } = await freshQuery();      // existing helper minting a query (cargo.e2e-spec)
  const cargo = await api().post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie())
    .send({ poReference: "PO-1", dimUnit: "CM", weightUnit: "KG" }).expect(201);
  expect(cargo.body.packageCount).toBe(0);
  expect(Number(cargo.body.grossWeightKg)).toBe(0);
  expect(cargo.body.chargeableWeight).toBeNull();               // H7 blank at Stage 3
  const list = await api().get(`/api/queries/${queryId}/cargo`).set("Cookie", cookie()).expect(200);
  expect(list.body.find((x: { id: string }) => x.id === cargo.body.id).poReference).toBe("PO-1");
});
// The POPULATED header (Σ gross/volume, packageCount, unioned tags over real packages) is
// verified in Task 5's package test, once the package-create endpoint + shapePackage exist.
```

- [ ] **Step 2: Run to verify it fails** → `pnpm --filter @svyft/api test -- cargo` → FAIL.

- [ ] **Step 3: Implement** `cargo.service.ts`

`getTree(queryId)` reads cargos with nested packages→items (Prisma `include`), then maps each via `shapeCargo`. `shapeCargo` computes the derived header:

```ts
import { effectiveTags, type CargoDto, type ReferenceTag } from "@svyft/shared";
// ...
private shapeCargo(cargo: CargoRow, packages: PackageWithItems[]): CargoDto {
  const shapedPkgs = packages.map((p) => this.shapePackage(p)); // shapePackage lives in Task 5
  const tagSet: ReferenceTag[] = [];
  for (const p of shapedPkgs) for (const t of p.effectiveTags) if (!tagSet.includes(t)) tagSet.push(t);
  return {
    id: cargo.id, rowIndex: cargo.rowIndex, poReference: cargo.poReference, label: cargo.label,
    dimUnit: cargo.dimUnit, weightUnit: cargo.weightUnit, packages: shapedPkgs,
    packageCount: shapedPkgs.length,
    grossWeightKg: shapedPkgs.reduce((s, p) => s + Number(p.grossWt), 0).toFixed(3),
    volumeCbm: shapedPkgs.reduce((s, p) => s + Number(p.volumeCbm ?? 0), 0).toFixed(6),
    tags: tagSet, chargeableWeight: null,
  };
}
```

`create` mints `rowIndex` (max+1 per query, same read-mitigated pattern as today's cargo) and inserts; `update`/`remove` go through `ChangeMediator.apply` with entity `"cargo"`. Declare `cargoImpactMap` in `cargo.impact.ts` (mirror the current file's shape) and `ImpactRegistry.declare("cargo", cargoImpactMap)` in `cargo.module.ts`. Controller: `GET/POST /queries/:id/cargo`, `PATCH/DELETE /queries/:id/cargo/:cid`.

- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @svyft/shared build && pnpm --filter @svyft/api typecheck
git add apps/api/src/modules/cargo apps/api/test/cargo.e2e-spec.ts
git commit -m "feat(api): Cargo grouping CRUD + derived header roll-ups (H4-H8)"
```

---

### Task 5: API — Package service (canonical storage, packageNo V-5, MSDS)

**Files:**
- Create: `apps/api/src/modules/cargo/package.service.ts`, `package.controller.ts`, `package.impact.ts`
- Modify: `cargo.module.ts` (register), `files/*` unchanged (reuse `FilesService.storeMsds`)
- Test: `apps/api/test/package.e2e-spec.ts`

**Interfaces:**
- Produces: `PackageService.create(queryId, cargoId, input, user)`, `.update`, `.remove`, `.attachMsds`, `shapePackage(pkgWithItems): PackageDto`. `packageImpactMap` (`packageType`/dims/`grossWt`/`netWt`: `RfqDefining`; `packageNo`/`tags`/`msdsFileId`: `Corrective`; `@create`/`@delete`: `Structural`).
- Consumes: `cargo.dimUnit`/`weightUnit` for canonical conversion (read the parent cargo).

- [ ] **Step 1: Write the failing test** `package.e2e-spec.ts`

```ts
it("stores dims/weights canonically (mm/tonne entry → cm/kg) and computes volumeCbm", async () => {
  const { queryId } = await freshQuery();
  const cargo = await addCargo(queryId, { dimUnit: "MM", weightUnit: "TONNE" });
  const p = await api().post(`/api/queries/${queryId}/cargo/${cargo.id}/packages`).set("Cookie", cookie())
    .send({ packageNo: "P-1", packageType: "CRATE", dimL: 1200, dimW: 1000, dimH: 1400, grossWt: 0.42 }).expect(201);
  expect(Number(p.body.dimL)).toBe(120);            // 1200 mm → 120 cm
  expect(Number(p.body.grossWt)).toBe(420);          // 0.42 t → 420 kg
  expect(Number(p.body.volumeCbm)).toBeCloseTo(1.68, 4);
});
it("rejects a duplicate packageNo within the query (V-5, case-insensitive/trimmed)", async () => {
  const { queryId } = await freshQuery(); const cargo = await addCargo(queryId, {});
  await addPackage(queryId, cargo.id, { packageNo: "P-1", packageType: "BOX", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 });
  await api().post(`/api/queries/${queryId}/cargo/${cargo.id}/packages`).set("Cookie", cookie())
    .send({ packageNo: " p-1 ", packageType: "BOX", dimL: 1, dimW: 1, dimH: 1, grossWt: 1 }).expect(409);
});
it("rolls packages into the cargo's derived header (C7: Σ gross/volume, packageCount)", async () => {
  const { queryId } = await freshQuery(); const cargo = await addCargo(queryId, { dimUnit: "CM", weightUnit: "KG" });
  await addPackage(queryId, cargo.id, { packageNo: "P-1", packageType: "PALLET", dimL: 120, dimW: 100, dimH: 140, grossWt: 420 });
  await addPackage(queryId, cargo.id, { packageNo: "P-2", packageType: "BOX", dimL: 100, dimW: 50, dimH: 40, grossWt: 30 });
  const list = await api().get(`/api/queries/${queryId}/cargo`).set("Cookie", cookie()).expect(200);
  const c = list.body.find((x: { id: string }) => x.id === cargo.id);
  expect(c.packageCount).toBe(2);
  expect(Number(c.grossWeightKg)).toBeCloseTo(450, 3);       // 420 + 30
  expect(Number(c.volumeCbm)).toBeCloseTo(1.88, 4);          // 1.68 + 0.20
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement** `package.service.ts`

On create/update, load the parent `cargo` for its units and convert with `toCanonicalDim`/`toCanonicalWeight` before writing; `shapePackage` converts **back** with `fromCanonical*` for display (using the cargo's units) — **no**, store canonical and return canonical strings (the web layer converts for display using the cargo units). Keep DTO canonical: return `dimL/W/H` (cm) and `grossWt`/`netWt` (kg) as-is. V‑5: before insert, `findFirst` a package in the same query where `lower(trim(packageNo)) = lower(trim(input.packageNo))`; throw `ConflictException` if found (belt-and-suspenders over the DB unique index which is case-sensitive). Mediate update/delete via `"package"`. `attachMsds` calls `FilesService.storeMsds` then sets `msdsFileId` (mediated `Corrective`). `shapePackage` sets `effectiveTags: effectiveTags(pkg)` and `items: pkg.items.map(shapeItem)`.

Controller routes: `POST /queries/:id/cargo/:cid/packages`, `PATCH/DELETE …/packages/:pid`, `POST …/packages/:pid/msds` (multipart, mirror the old cargo MSDS route). Register `packageImpactMap`.

- [ ] **Step 4: Run to verify it passes** → PASS.
- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @svyft/shared build && pnpm --filter @svyft/api typecheck
git add apps/api/src/modules/cargo apps/api/test/package.e2e-spec.ts
git commit -m "feat(api): Package CRUD — canonical cm/kg storage, packageNo V-5 uniqueness, MSDS attach"
```

---

### Task 6: API — "add N copies" package clone

**Files:** Modify `package.service.ts`, `package.controller.ts`; Test `apps/api/test/package.e2e-spec.ts`

**Interfaces:** Produces `PackageService.copy(queryId, pid, count, user): PackageDto[]` — clones a saved package `count` times (2..50), each with a fresh auto `packageNo` (`<base>-2`, `-3`, … or next free suffix) and copied items; mediated `@create` per clone.

- [ ] **Step 1: Write the failing test**

```ts
it("clones a package N times with unique packageNos and copied items", async () => {
  const { queryId } = await freshQuery(); const cargo = await addCargo(queryId, {});
  const p = await addPackage(queryId, cargo.id, { packageNo: "PLT", packageType: "PALLET", dimL: 120, dimW: 100, dimH: 140, grossWt: 420 });
  await addItem(queryId, cargo.id, p.id, { product: "Paint", qty: 8, uom: "PC" });
  const res = await api().post(`/api/queries/${queryId}/cargo/${cargo.id}/packages/${p.id}/copies`).set("Cookie", cookie())
    .send({ count: 2 }).expect(201);
  expect(res.body).toHaveLength(2);
  const nos = res.body.map((x: { packageNo: string }) => x.packageNo);
  expect(new Set(nos).size).toBe(2);
  expect(res.body[0].items).toHaveLength(1);
});
```

- [ ] **Step 2–4:** Run (FAIL) → implement `copy` (loop `count`, compute next free `packageNo` suffix per query, `create` package + items in a tx, mediate `@create`) → route `POST …/packages/:pid/copies` with a `{ count: z.number().int().min(2).max(50) }` body → run (PASS).
- [ ] **Step 5: Commit** — `git commit -m "feat(api): add-N-copies package clone with unique packageNos"`

---

### Task 7: API — Item service (V-4)

**Files:** Create `apps/api/src/modules/cargo/item.service.ts`, `item.controller.ts`, `item.impact.ts`; Modify `cargo.module.ts`; Test `apps/api/test/item.e2e-spec.ts`

**Interfaces:** Produces `ItemService.create/update/remove`, `shapeItem(item): ItemDto`; `itemImpactMap` (`product`/`qty`/`uom`/`hsCode`/`tags`: `Corrective`; `@create`/`@delete`: `Corrective`). Routes `POST …/packages/:pid/items`, `PATCH/DELETE …/items/:iid`.

- [ ] **Step 1: Write the failing test**

```ts
it("rejects an item with qty but no UoM (V-4) and discards an empty item", async () => {
  const { queryId, cargoId, packageId } = await freshPackage();
  await api().post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`).set("Cookie", cookie())
    .send({ product: "X", qty: 3 }).expect(400);                       // V-4: qty ⇒ uom
  await api().post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`).set("Cookie", cookie())
    .send({}).expect(400);                                              // no product & no qty → discarded/invalid
  const ok = await api().post(`/api/queries/${queryId}/cargo/${cargoId}/packages/${packageId}/items`).set("Cookie", cookie())
    .send({ product: "Paint", qty: 8, uom: "PC", hsCode: "32081090" }).expect(201);
  expect(ok.body.uom).toBe("PC");
});
```

- [ ] **Step 2–4:** Run (FAIL) → implement (the schema's V‑4 refine handles `qty⇒uom`; add a service guard rejecting `product == null && qty == null` with `BadRequestException` "empty item") → run (PASS).
- [ ] **Step 5: Commit** — `git commit -m "feat(api): Item CRUD with V-4 (qty⇒UoM, discard empty)"`

---

### Task 8: API — DG indicator derives from the tag union

**Files:** Modify `apps/api/src/modules/queries/queries.service.ts` (the `syncDgIndicator` helper); Test `apps/api/test/queries.e2e-spec.ts`

**Interfaces:** `syncDgIndicator(queryId, tx)` now sets `dgIndicator = true` iff any package **or item** under the query carries the `DG` tag (replaces the old `isDangerous` boolean scan). Called after package/item create/update/delete.

- [ ] **Step 1: Write the failing test**

```ts
it("sets query.dgIndicator when any item carries the DG tag", async () => {
  const { queryId, cargoId, packageId } = await freshPackage();
  await addItem(queryId, cargoId, packageId, { product: "Acid", tags: ["DG"] });
  const res = await api().get(`/api/queries/${queryId}`).set("Cookie", cookie()).expect(200);
  expect(res.body.dgIndicator).toBe(true);
});
```

- [ ] **Step 2–4:** Run (FAIL) → rewrite `syncDgIndicator` to query `package.findFirst({ where: { queryId, tags: { has: "DG" } } })` OR `item.findFirst({ where: { package: { queryId }, tags: { has: "DG" } } })`; call it from `PackageService`/`ItemService` mutations (inject `QueriesService`, same pattern as today's `CargoService`) → run (PASS).
- [ ] **Step 5: Commit** — `git commit -m "feat(api): derive query.dgIndicator from the DG tag union (package or item)"`

---

### Task 9: API — Excel export restructure (packing list)

**Files:** Modify `apps/api/src/modules/cargo/cargo.service.ts` (`exportXlsx`); Test `apps/api/test/cargo-export.e2e-spec.ts`

**Interfaces:** `exportXlsx(queryId)` → one worksheet `Packing List`, **one row per item**, cargo+package context repeated, packages-with-no-items emit a blank-item row, trailing totals row. Columns per design §8.3.

- [ ] **Step 1: Write the failing test** (parse the buffer with `ExcelJS`)

```ts
it("exports one row per item with package+cargo context and a totals row", async () => {
  const { queryId, cargoId, packageId } = await freshPackage({ packageNo: "P-1", grossWt: 420 });
  await addItem(queryId, cargoId, packageId, { product: "Paint", qty: 8, uom: "PC", hsCode: "32081090" });
  const buf = await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo/export`).set("Cookie", cookie()).expect(201).then((r) => r.body);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("Packing List")!;
  const header = ws.getRow(1).values as string[];
  expect(header).toEqual(expect.arrayContaining(["Package No", "HSN", "Volume (CBM)", "DG (Yes/No)"]));
  expect(ws.getCell("A2").value).toBeDefined();      // first data row present
});
```

- [ ] **Step 2–4:** Run (FAIL) → rewrite `exportXlsx`: read the cargo tree; for each cargo→package→item emit a row `{ cargoNo, poReference, packageNo, packageType, dimL, dimW, dimH, grossWt, netWt, volumeCbm, packageTags, sn, product, qty, uom, hsCode, itemTags, dg }`; DG = effectiveTags includes "DG"; append a totals row (Σ packages, Σ gross, Σ volume) → run (PASS).
- [ ] **Step 5: Commit** — `git commit -m "feat(api): restructure cargo export to a per-item packing list"`

---

### Task 10: API — leg mapping at package grain + roll-up simplification

**Files:** Modify `apps/api/src/modules/legs/legs.service.ts`, `legs/leg.impact.ts`, `queries/queries.service.ts`; Modify shared `packages/shared/src/legs.ts` (rename `assignedCargoIds`→`assignedPackageIds`); Test `apps/api/test/legs.e2e-spec.ts`, `apps/api/test/routing.e2e-spec.ts`

**Interfaces:** leg create/update body uses `assignedPackageIds`; join rows go to `LegPackage`; `assertCargoRefs`→`assertPackageRefs` (verify package ids belong to the query — throws `BadRequestException` on bad FK, P2003 is unmapped); leg roll-ups (`totalGrossWt`/`totalNetWt`/`totalCbm`) sum canonical values **directly** (drop `toKg`).

- [ ] **Step 1: Write the failing test**

```ts
it("assigns packages to a leg and sums canonical roll-ups directly", async () => {
  const { queryId, cargoId } = await freshCargo();
  const p1 = await addPackage(queryId, cargoId, { packageNo: "P-1", packageType: "BOX", dimL: 100, dimW: 50, dimH: 40, grossWt: 5 });
  const p2 = await addPackage(queryId, cargoId, { packageNo: "P-2", packageType: "BOX", dimL: 100, dimW: 50, dimH: 40, grossWt: 10 });
  const { legId } = await addLeg(queryId, { assignedPackageIds: [p1.id, p2.id] });
  const res = await api().get(`/api/queries/${queryId}`).set("Cookie", cookie()).expect(200);
  const leg = res.body.legs.find((l: { id: string }) => l.id === legId);
  expect(leg.assignedPackageIds).toEqual(expect.arrayContaining([p1.id, p2.id]));
  expect(leg.rollup.totalGrossWt).toBeCloseTo(15, 3);
});
```

- [ ] **Step 2–4:** Run (FAIL) → in `legs.service.ts` replace every `assignedCargoIds`/`cargoItemId`/`legCargo` with `assignedPackageIds`/`packageId`/`legPackage` (5 sites from the grep); in `queries.service.ts:326` project `assignedPackageIds: legPackage.map((lp) => lp.packageId)` and simplify the roll-up reducers to `s + Number(c.grossWt)` (values already canonical kg); `leg.impact.ts` rename the key → `assignedPackageIds: Structural` → run (PASS). Also update `apps/web/.../WizardShell.test.tsx` fixture field name in Task 16.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): leg mapping at package grain (LegPackage) + canonical leg roll-ups"`

---

## Phase 4 — Web

> Replaces `CargoRowForm.tsx` with a nested popup. Follow existing web patterns: `useCargo.ts` (TanStack Query mutations), `renderWithProviders`, and Radix `Select` driven via the hidden native `<select>` in tests.

### Task 11: Web — data hooks for cargo/package/item

**Files:** Create `apps/web/src/features/query-wizard/steps/cargo/usePackages.ts`, `useItems.ts`; Modify `cargo/useCargo.ts` (cargo grouping CRUD + export + `copyPackage`); Test `cargo/useCargo.test.ts`

**Interfaces:** Produces `useCargo(queryId)` → `{ add, update, remove, exportXlsx }`; `usePackages(queryId, cargoId)` → `{ add, update, remove, uploadMsds, copy }`; `useItems(queryId, cargoId, packageId)` → `{ add, update, remove }`. All invalidate the `["query", queryId]` detail query on success (same as today).

- [ ] **Step 1–5:** Test each hook posts to the right URL and invalidates (mirror the existing `useCargo.test.ts` mockFetch assertions); implement mirroring today's `useCargo`; typecheck; commit `feat(web): cargo/package/item data hooks`.

---

### Task 12: Web — Cargo Details main table + two-level expansion

**Files:** Modify `apps/web/src/features/query-wizard/steps/Step3Cargo.tsx`; Test `Step3Cargo.test.tsx`

**Interfaces:** Consumes `CargoDto[]` from `detail.cargo`. Renders one row per cargo with derived columns (`# · PO/Ref · Package Count · Contents · Σ Gross · Σ Volume · Tags · Chargeable(blank) · Actions`); a chevron expands to a **packages** sub-table; each package row expands to an **items** sub-table. `Edit`/`Remove` open/act at the cargo level.

- [ ] **Step 1: Write the failing test**

```ts
it("shows a cargo row with derived totals and expands to packages then items", async () => {
  renderStep3({ cargo: [oneCargoWithTwoPackages()] });   // fixture helper
  expect(await screen.findByText("PO-1")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();          // package count
  await userEvent.click(screen.getByLabelText("Expand cargo PO-1"));
  expect(await screen.findByText("P-1")).toBeInTheDocument(); // package row
  await userEvent.click(screen.getByLabelText("Expand package P-1"));
  expect(await screen.findByText("Deck paint")).toBeInTheDocument(); // item row
});
```

- [ ] **Step 2–5:** Run (FAIL) → implement the nested table (reuse `ReferenceTagIcons` for the unioned `tags`; contents = each package's items joined `product×qty`; values shown in the cargo's `dimUnit`/`weightUnit` via `fromCanonical*`) → run (PASS) → typecheck → commit `feat(web): cargo main table with two-level package/item expansion`.

---

### Task 13: Web — Cargo popup shell + one-transaction save

**Files:** Create `apps/web/src/features/query-wizard/steps/cargo/CargoPopup.tsx`; Modify `Step3Cargo.tsx` (open it from `+ Add Cargo`/`Edit`); Test `Step3Cargo.test.tsx`

**Interfaces:** `CargoPopup` renders cargo fields (**PO/Ref**, label, **Dimension Unit**, **Weight Unit** selects) + a `PackageEditor` list (Task 14). Add mode persists the cargo first (to get an id), then packages/items persist against it; Save closes on success.

- [ ] **Step 1–5:** Test: opening `+ Add Cargo` shows the unit selectors defaulting CM/KG and PATCHes/POSTs `dimUnit`/`weightUnit`; implement using RHF (units via native-select-driven Radix); typecheck; commit `feat(web): cargo popup shell with unit selectors`.

---

### Task 14: Web — Package editor (canonical-aware CBM, packageType dropdown, MSDS, copies)

**Files:** Create `cargo/PackageEditor.tsx`; Test `Step3Cargo.test.tsx`

**Interfaces:** Consumes the cargo's `dimUnit`/`weightUnit` (entry unit). Fields: `packageNo` (auto-suggested, editable), `packageType` (`PACKAGE_TYPES` dropdown), `dimL/W/H`, `grossWt`, `netWt`, `tags` (incl DG), a **live CBM** preview via `cbmFromCanonical(toCanonicalDim(...))`, an **MSDS upload** shown when the package is **effectively DG** (own DG tag or any item DG), and an **"Add N copies"** control (calls `usePackages().copy`).

- [ ] **Step 1: Write the failing test**

```ts
it("shows CBM in the cargo unit and reveals MSDS upload when a package is effectively DG", async () => {
  renderPackageEditor({ cargoUnits: { dimUnit: "MM", weightUnit: "KG" } });
  await fillPackage({ packageNo: "P-1", packageType: "CRATE", dimL: "1200", dimW: "1000", dimH: "1400", grossWt: "420" });
  expect(screen.getByLabelText("Volume (CBM)")).toHaveValue("1.6800");     // mm entry → 1.68 m³
  expect(screen.queryByLabelText("Upload MSDS PDF")).toBeNull();
  await toggleTag("DG");
  expect(screen.getByLabelText("Upload MSDS PDF")).toBeInTheDocument();
});
```

- [ ] **Step 2–5:** Run (FAIL) → implement (packageType via `PACKAGE_TYPES.map`; CBM preview converts entry→canonical then `cbmFromCanonical`; MSDS visibility = `effectiveTags(current).includes("DG")`; copies calls the Task 6 endpoint) → run (PASS) → typecheck → commit `feat(web): package editor — packageType dropdown, canonical CBM preview, DG MSDS, add-N-copies`.

---

### Task 15: Web — Items mini-table (V-4, DG tag)

**Files:** Create `cargo/ItemsMiniTable.tsx`; Test `Step3Cargo.test.tsx`

**Interfaces:** Inside `PackageEditor`. Add/edit/remove item lines: `product`, `qty`, `uom` (`UOMS` dropdown, required when qty), `hsCode`, `tags`. Marking an item DG flips the package's effective-DG (→ Task 14 MSDS shows).

- [ ] **Step 1: Write the failing test**

```ts
it("requires UoM when qty is entered and flags the package DG when an item is DG", async () => {
  renderPackageEditor({});
  await addItemLine({ product: "Paint", qty: "8" });     // no uom
  await clickSaveItem();
  expect(await screen.findByText(/Unit of measure is required/i)).toBeInTheDocument();
  await selectUom("PC"); await toggleItemTag("DG"); await clickSaveItem();
  expect(screen.getByLabelText("Upload MSDS PDF")).toBeInTheDocument();
});
```

- [ ] **Step 2–5:** Run (FAIL) → implement with `itemCreateSchema`/`itemUpdateSchema` resolver (V‑4 surfaces as the `uom` field error) → run (PASS) → typecheck → commit `feat(web): items mini-table with V-4 and DG tagging`.

---

### Task 16: Web — leg assignment control at package grain

**Files:** Modify `apps/web/src/features/query-wizard/steps/legs/CargoAssignmentControl.tsx`, `legs/cargoConflicts.ts`, `legs/useLegs.ts`, `WizardShell.test.tsx` fixture; Test `CargoAssignmentControl.test.tsx`, `cargoConflicts.test.ts`

**Interfaces:** The tick-list enumerates **packages** (grouped under their cargo's PO/Ref) instead of cargo rows; the leg body sends `assignedPackageIds`; `computeCargoConflicts` operates on `assignedPackageIds`/package ids (same parallel-fork/merge logic, renamed).

- [ ] **Step 1–5:** Update `cargoConflicts.ts` (rename `assignedCargoIds`→`assignedPackageIds`, param `cargoId`→`packageId`; keep the algorithm; update `cargoConflicts.test.ts`); update `CargoAssignmentControl` to list packages with a cargo-group header; update `useLegs.ts` + the `WizardShell.test.tsx` fixture field; run tests (PASS); typecheck; commit `feat(web): leg cargo-assignment at package grain`.

---

## Phase 5 — Docs

### Task 17: Docs — align Functional Spec + Technical Design + Handoff

**Files:** Modify `docs/Stage 3 - Create Query - Functional Spec.md` (§7.3 cargo), `docs/Stage 3 - Technical Design.md` (§4.2 entities, §4.5 derived, §5.2 endpoints), `docs/Stage 3 - Session Handoff.md`

- [ ] **Step 1:** Functional Spec §7.3 — replace the flat cargo table with the Cargo→Package→Item field tables; note DG-as-tag, package-level MSDS (DG-triggered), cargo-level units (cm/kg/tonne), derived H4–H8, V‑1…V‑8 mapping (V‑3 dropped).
- [ ] **Step 2:** Technical Design §4.2 — swap `CargoItem` for `Cargo`/`Package`/`Item` + `LegPackage`; §4.5 — leg roll-ups now pure Σ (canonical storage); §5.2 — new cargo/package/item endpoints.
- [ ] **Step 3:** Handoff — add a "Cargo packing-list re-model" entry (branch/PR, decisions C1–C14, open items O1–O5).
- [ ] **Step 4: Commit** — `git commit -m "docs(stage-3): align spec + technical design + handoff with the cargo packing-list re-model"`

---

## Final gate (before PR)

- [ ] `pnpm --filter @svyft/shared build` then `pnpm run ci` (shared + web + api build/typecheck/lint) green.
- [ ] `pnpm --filter @svyft/web typecheck` (vite build skips type errors).
- [ ] API e2e green on a fresh DB: `pnpm --filter @svyft/api exec prisma migrate reset --schema ../../prisma/schema.prisma --force --skip-seed` then the api e2e suite; then `gh run watch`.
- [ ] Opus whole-branch review (`/code-review`); fix Critical/Important before finishing.
- [ ] Finish via `superpowers:finishing-a-development-branch` → PR off `main` (`feat/stage-3-cargo-packing-list`).

## Self-review — spec coverage

| Spec section | Task(s) |
|---|---|
| C1/C2 three-level model, reuse CargoItem | 3 |
| C3 main table = cargo, expansion | 12 |
| C4 one-record-per-package + add N copies | 6, 14 |
| C5 packageCount parked | 3 (column) |
| C6 cargo-level units, canonical cm/kg, tonne | 1, 3, 5, 13 |
| C7 derived H4–H8 | 4, 12 |
| C8 DG tag + union + dgIndicator | 1, 2, 8 |
| C9 package net weight, V‑2, V‑3 dropped | 2, 5 |
| C10 MSDS per package, DG-triggered | 2, 5, 14 |
| C11 PO/Ref at cargo | 2, 4 |
| C12 no customs form (popup only) | 13–15 |
| C13 leg mapping at package grain | 10, 16 |
| C14 pre-go-live migration (reset path) | 3 |
| V‑4 qty⇒UoM | 2, 7, 15 |
| V‑5 packageNo uniqueness | 3, 5 |
| V‑6 unit round-trip | 1 |
| V‑7 tag non-removal (UI) | 14, 15 |
| Excel export restructure | 9 |
| Docs alignment | 17 |
