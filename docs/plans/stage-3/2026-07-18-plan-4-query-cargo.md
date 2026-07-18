# Stage 3 — Plan 4: Query aggregate + Cargo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **Query aggregate root** + **Cargo rows** + **completeness checklist** + **MSDS file assets**, wiring the now-built Extensibility Core (persist `Query.status` through `QueryStatusProjector`; route every Query/Cargo field edit through `ChangeMediator.apply`; declare Query/Cargo impact classes via `ImpactRegistry.declare`). Backend + `@svyft/shared` only — **no web** (wizard UI is Plan 6). Per Technical Design §4.2/§4.4/§4.5/§5.2/§8.4/§8.6 and Functional Spec §7.1–§7.3, §7.5, §9, §13.

**Architecture:** Three new NestJS modules — `queries` (aggregate root), `cargo` (rows + export + MSDS endpoint), `files` (storage-backed `FileAsset`) — on the Plan 0–3 foundation. New Prisma models `Query`, `CargoItem`, `QueryChecklistItem`, `FileAsset`, `QuerySequence` (migration #4). `queryCode` `YALYY-NNNN` is minted on first persist from a row-locked `QuerySequence` (atomic `upsert` increment inside the create tx). `CargoItem.volumeCbm` is a **Postgres `GENERATED ALWAYS AS … STORED`** column (represented in Prisma as `@default(dbgenerated(...))` — verified drift-free). Query/Cargo mutations flow through the **`ChangeMediator`** (Free path only in Stage 3) with a real caller unit-of-work; each module `declare`s its field→impact-class map. `Query.status` is **never hand-written** — it is persisted only through `QueryStatusProjector.recompute()` (the derived/projection door, §7.2); `POST /queries/:id/create` sets the `rfqReadyAt` milestone and calls the projector, landing `RFQ_READY`. Isomorphic Zod schemas + a pure `collectCreateFindings` (create-phase field/cargo validation) live in `@svyft/shared`.

**Tech Stack:** NestJS 10 · Prisma 5.22 / PostgreSQL · `@nestjs/platform-express` (multer, bundled) + `@types/multer` · `exceljs` (export) · `zod` (shared) · Vitest (shared units) / Jest + `@nestjs/testing` + `supertest` (api e2e).

## Global Constraints

*(Every task's requirements implicitly include this section. Values copied verbatim from the Stage 3 handoff "Conventions & key learnings" and verified against the current tree.)*

- **Node** `>=20 <21`; **pnpm** `9.x`; **TypeScript** `^5.6`, `strict`. **Prettier:** double quotes, semicolons, `trailingComma: all`, `printWidth: 100` (`.prettierrc`).
- **Branch:** `feat/plan-4-query-cargo` (off `main`, already created). Plan doc + implementation ship as **one PR**. **Conventional Commits**, one commit per task. Every commit message ends with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- **SDD ledger:** `.superpowers/sdd/progress.md` (gitignored — start fresh for Plan 4).
- **Validation binds at PARAM level:** `@Body(new ZodValidationPipe(schema))` — **never** method-level `@UsePipes` (Nest applies a method-level pipe to `@Param()` too → validates the id against the body schema → wrong 400). See [clients.controller.ts](apps/api/src/modules/clients/clients.controller.ts).
- **Prisma errors:** the global `PrismaExceptionFilter` ([prisma-exception.filter.ts](apps/api/src/common/prisma-exception.filter.ts), registered in `main.ts`) maps `P2025→404`, `P2023→400` (malformed uuid), `P2002→409`, validation→400. **Do not hand-roll per-service 500s.** Services throw specific `HttpException`s (`NotFoundException`, `ConflictException`, `BadRequestException`, `ForbiddenException`) which run before the filter. **Note P2003 (FK violation) is NOT mapped** → verify referenced ids (`clientId`/`vesselId`/`assignedUserId`) exist in the service and throw `BadRequestException` instead of letting a 500 escape.
- **Env timing:** read env at DI/call time, **not** in a module top-level `const` (`ConfigModule` loads `.env` at init). E.g. `LocalDiskStorage` reads `process.env.UPLOADS_DIR` **inside** its method.
- **Lint** (`eslint.config.js`, tseslint recommended): `@typescript-eslint/no-explicit-any` and `no-unused-vars` are **on**; `argsIgnorePattern: "^_"` — prefix intentionally-unused params with `_`. Use typed generics, never `any`.
- **`@svyft/shared` resolution:** api **typecheck/build** resolve `@svyft/shared` from its **built `dist`**. After editing shared, run `pnpm --filter @svyft/shared build` **before** any api `typecheck`/`build`. api **jest** maps `@svyft/shared` → `packages/shared/src/index.ts` directly (`moduleNameMapper`), so api tests need no shared rebuild.
- **Shared "enums":** `const` object + `(typeof X)[keyof typeof X]` string-union + a companion `Object.values(...) as [X, ...X[]]` array **pinned by a `toEqual` test** — values matching the Prisma enum **exactly**. **Never** a TS `enum`. See [role.ts](packages/shared/src/role.ts), [change.ts](packages/shared/src/change.ts).
- **Extensibility Core golden rules (enforced by real code):**
  - **Never hand-write `Query.status`.** It is derived/projected — persist it only via `QueryStatusProjector.recompute()` ([query-status.projector.ts](apps/api/src/modules/status/query-status.projector.ts)). The initial `DRAFT` comes from the Prisma column default, not a write.
  - **Never raw-write a user-editable Query/Cargo field.** Route it through `ChangeMediator.apply(req, uow)` ([change-mediator.ts](apps/api/src/modules/changes/change-mediator.ts)); declare its impact class via `ImpactRegistry.declare(entity, map)`. (`POST /queries` initial create is the entity's birth — not a mediated edit. Cargo create/delete ARE mediated as `@create`/`@delete` structural changes to the query's cargo set.)
- **API tests** use the `*.e2e-spec.ts` suffix (jest `testRegex`), boot `AppModule` against the **local dev Postgres** (`apps/api/.env` → `postgresql://…@localhost:5433/svyft`, holds `JWT_ACCESS_SECRET`). First line of every spec, **before imports**: `process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";`. Auth cookie: `` `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub, role, tenantId: null })}` `` (see [clients.e2e-spec.ts](apps/api/test/clients.e2e-spec.ts)). **Shared tests** are **Vitest** `*.test.ts` co-located in `packages/shared/src/`.
- **CI runs a fresh migrated-but-UNSEEDED Postgres.** Every new test MUST be **seed-independent and self-cleaning**: upsert any reference rows it needs (`QuerySequence` year rows, the 9 `ChecklistDefinition` items via `seedReferenceData`), create its own users/clients, and delete its own rows by a **unique prefix** in `beforeAll`/`afterAll`. **Verify the whole branch against a fresh `pnpm --filter @svyft/api exec prisma migrate reset --schema ../../prisma/schema.prisma --force --skip-seed` DB before pushing**, then watch CI (`gh run watch`).
- **Migrations:** fourth migration (`query_cargo`). Run `prisma migrate dev` against **local** Postgres only; CI/prod apply via `prisma migrate deploy`. The `volumeCbm` generated column needs a **hand-edited migration** (Task 2, recipe verified).
- **No web changes** in this plan (`apps/web` untouched). **No new HTTP surface beyond §5.2's Plan-4 endpoints** (see below).
- **Scope boundaries — deferred, do NOT build (Plan 5/6):** Points/Legs/LegCargo tables; the `validateRoute` route-validation engine (§10 R1–R9); the full route-gated Create Query + leg-derived query-status rollup; cargo→leg scope fan-out in `ImpactClassifier`; the `All-Records` `GET /queries` list; the wizard/query-list **web UI**; Excel **import**; live email; freight-density / chargeable-weight computation (both stay **null/read-only**). Ship the ports/columns now (`rfqReadyAt`, `freightDensity`, `chargeableWeight`, `manifestSnapshot` is Plan 5) so later plans drop in without re-plumbing.

### Plan-4 endpoint surface (Technical Design §5.2)

| Method | Route | Auth | Notes |
|---|---|---|---|
| `POST` | `/queries` | any authenticated (Exec+) | First persist → mints `queryCode`; seeds 9 checklist items; `status=DRAFT`. **Not** mediated. |
| `GET` | `/queries/:id` | any | Returns query + cargo + checklist + files. |
| `PATCH` | `/queries/:id` | any (queryDate: **Admin only**) | Runs `ChangeMediator` **once per call** (per wizard step). |
| `POST` | `/queries/:id/create` | any | Create-phase field/cargo validation (F1/F5/F6) → on pass sets `rfqReadyAt` + projector → `RFQ_READY`; on block `422 { findings }`. **Route rules R1–R9 = Plan 5.** |
| `PATCH` | `/queries/:id/checklist` | any | Toggles `QueryChecklistItem.checked`. |
| `POST` | `/queries/:id/cargo` | any | Mediated `@create`; assigns `rowIndex`; re-syncs `dgIndicator`. |
| `PATCH` | `/queries/:id/cargo/:cid` | any | Mediated field edit; re-syncs `dgIndicator`. |
| `DELETE` | `/queries/:id/cargo/:cid` | any | Mediated `@delete`. |
| `POST` | `/queries/:id/cargo/export` | any | `exceljs` stream, single worksheet **`Product`**. |
| `POST` | `/queries/:id/cargo/:cid/msds` | any | Multipart PDF → `FileAsset` → sets `msdsFileId` (mediated). |

---

## File structure

**`packages/shared/src/`** (isomorphic contracts)
- `query.ts` — `Priority`/`Incoterms`/`FileKind` enums (+ arrays); `querySaveSchema` (draft, lenient) + `checklistPatchSchema`; `QueryDto`, `ChecklistItemStateDto`; `collectCreateFindings` (pure create-phase validation) + its input interfaces.
- `cargo.ts` — `ReferenceTag` enum (+ array); `cargoCreateSchema`/`cargoUpdateSchema`; `CargoDto`.
- `status.ts` — **modify:** add `rfqReady?` to `QueryMilestones`; extend `deriveQueryStatus` zero-legs branch (additive).
- `index.ts` — **modify:** export `./query`, `./cargo`.
- `query.test.ts`, `cargo.test.ts` (new Vitest); `status.test.ts` (extend).

**`prisma/`**
- `schema.prisma` — **modify:** enums `Priority`/`Incoterms`/`ReferenceTag`/`FileKind`; models `Query`, `CargoItem`, `QueryChecklistItem`, `FileAsset`, `QuerySequence`; back-relations on `User`/`Client`/`Vessel`.
- `migrations/<ts>_query_cargo/migration.sql` — generated, then **hand-edit** the `volumeCbm` column to `GENERATED ALWAYS AS … STORED`.

**`apps/api/src/modules/`**
- `files/` — `storage.ts` (`STORAGE` token + `StorageService` + `LocalDiskStorage`), `files.service.ts` (`FilesService.storeMsds`), `files.module.ts`.
- `queries/` — `query.impact.ts` (`queryImpactMap`), `queries.service.ts`, `queries.controller.ts`, `queries.module.ts`.
- `cargo/` — `cargo.impact.ts` (`cargoImpactMap`), `cargo.service.ts`, `cargo.controller.ts`, `cargo.module.ts`.
- `status/query-status.projector.ts` — **modify:** `recompute` persists `Query.status`.
- `app.module.ts` — **modify:** register `FilesModule`, `QueriesModule`, `CargoModule`.

**`apps/api/test/`** — `query-cargo-model.e2e-spec.ts`, `files.e2e-spec.ts`, `queries.e2e-spec.ts`, `cargo.e2e-spec.ts`.

**Interfaces produced (referenced across tasks — exact names/types):**
- Shared enums: `Priority` (`LOW·MEDIUM·HIGH·URGENT`), `Incoterms` (`EXW·FCA·FAS·FOB·CFR·CIF·CPT·CIP·DAP·DPU·DDP`), `ReferenceTag` (`HEAVY·FRAGILE·NON_STACKABLE`), `FileKind` (`MSDS`) — each with companion `*_VALUES` array.
- `collectCreateFindings(q: QueryForValidation, cargo: CargoForValidation[]) => Finding[]`.
- `QueriesService`: `create(input, user)`, `get(id)`, `patch(id, patch, user)`, `createQuery(id, user)`, `patchChecklist(id, input)`, `syncDgIndicator(queryId, tx)` (exported for `CargoService`).
- `CargoService`: `create(queryId, input, user)`, `update(queryId, cid, input, user)`, `remove(queryId, cid, user)`, `exportXlsx(queryId)`, `attachMsds(queryId, cid, file, user)`.
- `FilesService.storeMsds(queryId, file, uploadedById) => Promise<FileAsset>`.
- `QueryStatusProjector.recompute(queryId?, client?) => Promise<void>` (now persists).

---

### Task 1: Shared contracts — enums, schemas, create-phase validation, milestone/projection extension

**Files:**
- Create: `packages/shared/src/query.ts`, `packages/shared/src/cargo.ts`
- Create: `packages/shared/src/query.test.ts`, `packages/shared/src/cargo.test.ts`
- Modify: `packages/shared/src/status.ts`, `packages/shared/src/index.ts`, `packages/shared/src/status.test.ts`

**Interfaces:**
- Produces every shared enum/schema/type/function listed above. Consumed by all api tasks and (later) web.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/cargo.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ReferenceTag, REFERENCE_TAGS, cargoCreateSchema } from "./cargo";

describe("ReferenceTag vocabulary", () => {
  it("pins the tag order", () => {
    expect(REFERENCE_TAGS).toEqual(["HEAVY", "FRAGILE", "NON_STACKABLE"]);
  });
});

describe("cargoCreateSchema", () => {
  const base = {
    poReference: "PO-1",
    productName: "Widget",
    packageType: "Pallet",
    qty: 10,
    dimL: 120,
    dimW: 80,
    dimH: 100,
    grossWt: 500,
  };
  it("accepts a minimal valid row", () => {
    expect(cargoCreateSchema.safeParse(base).success).toBe(true);
  });
  it("rejects qty <= 0 (F5)", () => {
    expect(cargoCreateSchema.safeParse({ ...base, qty: 0 }).success).toBe(false);
  });
  it("rejects netWt > grossWt (F5)", () => {
    expect(cargoCreateSchema.safeParse({ ...base, netWt: 600 }).success).toBe(false);
  });
  it("accepts referenceTags from the enum and rejects unknown tags", () => {
    expect(cargoCreateSchema.safeParse({ ...base, referenceTags: ["HEAVY"] }).success).toBe(true);
    expect(cargoCreateSchema.safeParse({ ...base, referenceTags: ["NUCLEAR"] }).success).toBe(false);
  });
});
```

`packages/shared/src/query.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  Incoterms,
  INCOTERMS,
  Priority,
  PRIORITIES,
  querySaveSchema,
  collectCreateFindings,
} from "./query";

describe("Query vocabularies", () => {
  it("pins the 11 Incoterms", () => {
    expect(INCOTERMS).toEqual([
      "EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP",
    ]);
  });
  it("pins priorities", () => {
    expect(PRIORITIES).toEqual(["LOW", "MEDIUM", "HIGH", "URGENT"]);
  });
});

describe("querySaveSchema (draft — lenient, format-validated)", () => {
  it("accepts an empty draft patch", () => {
    expect(querySaveSchema.safeParse({}).success).toBe(true);
  });
  it("validates email + incoterms when present", () => {
    expect(querySaveSchema.safeParse({ contactEmail: "not-email" }).success).toBe(false);
    expect(querySaveSchema.safeParse({ incoterms: "ZZZ" }).success).toBe(false);
    expect(querySaveSchema.safeParse({ incoterms: Incoterms.FOB, priority: Priority.HIGH }).success).toBe(true);
  });
  it("rejects a shipmentDescription over 200 chars", () => {
    expect(querySaveSchema.safeParse({ shipmentDescription: "x".repeat(201) }).success).toBe(false);
  });
});

describe("collectCreateFindings (F1 mandatory + F6 DG→MSDS; route rules are Plan 5)", () => {
  const ready = {
    id: "q1",
    clientId: "c1",
    contactName: "Jo",
    contactEmail: "jo@acme.test",
    contactPhone: "+911234567890",
    readyDate: new Date(),
    targetDelivery: new Date(),
    incoterms: "FOB" as const,
  };
  it("returns no findings when all mandatory fields present + no DG cargo", () => {
    expect(collectCreateFindings(ready, [])).toEqual([]);
  });
  it("flags each missing mandatory field with rule F1", () => {
    const f = collectCreateFindings({ ...ready, clientId: null, incoterms: null }, []);
    expect(f.map((x) => x.rule)).toEqual(["F1", "F1"]);
    expect(f.every((x) => x.severity === "blocking")).toBe(true);
  });
  it("flags a DG cargo row missing its MSDS with rule F6", () => {
    const f = collectCreateFindings(ready, [
      { id: "cg1", isDangerous: true, msdsFileId: null, poReference: "PO-9" },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "F6", severity: "blocking", scope: { type: "cargo", id: "cg1" } });
  });
});
```

Append to `packages/shared/src/status.test.ts` (inside the existing `deriveQueryStatus` describe or a new one):
```ts
describe("deriveQueryStatus — zero-leg query-level milestones (Plan 4)", () => {
  it("stays DRAFT with no legs and no milestones", () => {
    expect(deriveQueryStatus([])).toBe(QueryStatus.DRAFT);
  });
  it("is CREATED with no legs when only the created milestone is set", () => {
    expect(deriveQueryStatus([], { created: true })).toBe(QueryStatus.CREATED);
  });
  it("is RFQ_READY with no legs when the rfqReady milestone is set", () => {
    expect(deriveQueryStatus([], { rfqReady: true })).toBe(QueryStatus.RFQ_READY);
  });
  it("downstream milestones still override the zero-leg branch", () => {
    expect(deriveQueryStatus([], { rfqReady: true, closed: true })).toBe(QueryStatus.CLOSED);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @svyft/shared test`
Expected: FAIL — `./query` and `./cargo` do not exist; `deriveQueryStatus([], { rfqReady: true })` returns `DRAFT`.

- [ ] **Step 3: Extend `status.ts` (additive — do not change the non-empty-legs behaviour)**

In `packages/shared/src/status.ts`, add `rfqReady?` to `QueryMilestones`:
```ts
export interface QueryMilestones {
  created?: boolean;
  rfqReady?: boolean;
  awaitingClientDecision?: boolean;
  won?: boolean;
  lost?: boolean;
  closed?: boolean;
}
```
Replace the single zero-legs line `if (legStatuses.length === 0) return QueryStatus.DRAFT;` with:
```ts
  if (legStatuses.length === 0) {
    // No legs yet (Plan 4): query-level milestones drive status until the leg
    // rollup lands in Plan 5. Downstream milestones are already handled above.
    if (milestones.rfqReady) return QueryStatus.RFQ_READY;
    if (milestones.created) return QueryStatus.CREATED;
    return QueryStatus.DRAFT;
  }
```
Leave the `switch (leastAdvanced(...))` block and the `default` `TODO(Plan 5)` untouched.

- [ ] **Step 4: Create `packages/shared/src/cargo.ts`**

```ts
import { z } from "zod";

// §7.3 reference tags (multi-badge).
export const ReferenceTag = {
  HEAVY: "HEAVY",
  FRAGILE: "FRAGILE",
  NON_STACKABLE: "NON_STACKABLE",
} as const;
export type ReferenceTag = (typeof ReferenceTag)[keyof typeof ReferenceTag];
export const REFERENCE_TAGS = Object.values(ReferenceTag) as [ReferenceTag, ...ReferenceTag[]];

// A cargo row (§7.3). Core fields required (a row is atomic data entry + volumeCbm
// is a generated column needing non-null dims/qty). freightDensity/chargeableWeight
// are Stage-4 (never sent here); volumeCbm is DB-generated (never sent here).
export const cargoCreateSchema = z
  .object({
    poReference: z.string().min(1).max(120),
    productName: z.string().min(1).max(200),
    referenceTags: z.array(z.enum(REFERENCE_TAGS)).optional(),
    hsCode: z.string().max(40).optional(),
    packageType: z.string().min(1).max(60),
    isDangerous: z.boolean().optional(),
    qty: z.number().int().positive(), // F5: qty > 0
    dimL: z.number().positive(),
    dimW: z.number().positive(),
    dimH: z.number().positive(),
    netWt: z.number().nonnegative().optional(),
    grossWt: z.number().positive(), // F5: gross present
  })
  .refine((c) => c.netWt === undefined || c.netWt <= c.grossWt, {
    message: "Net weight must be ≤ gross weight",
    path: ["netWt"],
  });
export type CargoCreateInput = z.infer<typeof cargoCreateSchema>;

// Update: all fields optional; keep the Net ≤ Gross guard when both are present.
export const cargoUpdateSchema = z
  .object({
    poReference: z.string().min(1).max(120),
    productName: z.string().min(1).max(200),
    referenceTags: z.array(z.enum(REFERENCE_TAGS)),
    hsCode: z.string().max(40).nullable(),
    packageType: z.string().min(1).max(60),
    isDangerous: z.boolean(),
    qty: z.number().int().positive(),
    dimL: z.number().positive(),
    dimW: z.number().positive(),
    dimH: z.number().positive(),
    netWt: z.number().nonnegative().nullable(),
    grossWt: z.number().positive(),
  })
  .partial()
  .refine((c) => c.netWt == null || c.grossWt == null || c.netWt <= c.grossWt, {
    message: "Net weight must be ≤ gross weight",
    path: ["netWt"],
  });
export type CargoUpdateInput = z.infer<typeof cargoUpdateSchema>;

export interface CargoDto {
  id: string;
  rowIndex: number;
  poReference: string;
  productName: string;
  referenceTags: ReferenceTag[];
  hsCode: string | null;
  packageType: string;
  isDangerous: boolean;
  msdsFileId: string | null;
  qty: number;
  dimL: string;
  dimW: string;
  dimH: string;
  netWt: string | null;
  grossWt: string;
  volumeCbm: string | null; // Prisma Decimal serialises to string
  freightDensity: string | null; // null in Stage 3
  chargeableWeight: string | null; // null in Stage 3
}
```

- [ ] **Step 5: Create `packages/shared/src/query.ts`**

```ts
import { z } from "zod";
import type { Finding } from "./findings";

export const Priority = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", URGENT: "URGENT" } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];
export const PRIORITIES = Object.values(Priority) as [Priority, ...Priority[]];

// §7.2 — fixed 11-value Incoterms enum.
export const Incoterms = {
  EXW: "EXW", FCA: "FCA", FAS: "FAS", FOB: "FOB", CFR: "CFR", CIF: "CIF",
  CPT: "CPT", CIP: "CIP", DAP: "DAP", DPU: "DPU", DDP: "DDP",
} as const;
export type Incoterms = (typeof Incoterms)[keyof typeof Incoterms];
export const INCOTERMS = Object.values(Incoterms) as [Incoterms, ...Incoterms[]];

export const FileKind = { MSDS: "MSDS" } as const;
export type FileKind = (typeof FileKind)[keyof typeof FileKind];
export const FILE_KINDS = Object.values(FileKind) as [FileKind, ...FileKind[]];

const isoDate = z.string().datetime({ offset: true });

// Draft save (POST /queries, PATCH /queries/:id). Lenient: every field optional so a
// Draft persists with no completeness gate (§13); formats validated WHEN present (F2/F3/F4).
// The full mandatory gate is collectCreateFindings, run only at Create Query.
export const querySaveSchema = z
  .object({
    priority: z.enum(PRIORITIES),
    queryDate: isoDate, // Admin-only backdate, enforced in the service
    responseDeadline: isoDate,
    responseDeadlineRemarks: z.string().max(200),
    clientId: z.string().uuid(),
    contactName: z.string().min(1).max(160),
    contactDesignation: z.string().max(120),
    contactEmail: z.string().email(), // F2
    contactPhone: z.string().regex(/^\+?[1-9]\d{6,14}$/, "Phone must be E.164"), // F2
    whatsappEnabled: z.boolean(),
    faxNumber: z.string().max(40),
    vesselId: z.string().uuid(),
    vesselName: z.string().max(200),
    imoNumber: z.string().regex(/^\d{7}$/, "IMO must be 7 digits"), // F2
    eta: isoDate,
    etb: isoDate,
    etd: isoDate,
    portOfCall: z.string().max(160),
    incoterms: z.enum(INCOTERMS),
    shipmentDescription: z.string().max(200),
    dgIndicator: z.boolean(),
    readyDate: isoDate,
    targetDelivery: isoDate,
    internalNotes: z.string().max(500),
    assignedUserId: z.string().uuid(),
  })
  .partial()
  // F3: ETA < ETB < ETD when all present.
  .refine((q) => !(q.eta && q.etb) || q.eta < q.etb, { message: "ETA must be before ETB", path: ["eta"] })
  .refine((q) => !(q.etb && q.etd) || q.etb < q.etd, { message: "ETB must be before ETD", path: ["etb"] });
export type QuerySaveInput = z.infer<typeof querySaveSchema>;

export const checklistPatchSchema = z.object({
  items: z.array(z.object({ itemKey: z.string().min(1), checked: z.boolean() })).min(1),
});
export type ChecklistPatchInput = z.infer<typeof checklistPatchSchema>;

export interface ChecklistItemStateDto {
  itemKey: string;
  checked: boolean;
}

// ── Create-phase field/cargo validation (§10.1 F1/F5/F6) ────────────────────────
// Pure + isomorphic (reused by the Plan-6 wizard). Route rules R1–R9 + temporal T1–T3
// need legs → Plan 5; NOT included here.
export interface QueryForValidation {
  id: string;
  clientId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  readyDate: Date | string | null;
  targetDelivery: Date | string | null;
  incoterms: Incoterms | null;
}
export interface CargoForValidation {
  id: string;
  isDangerous: boolean;
  msdsFileId: string | null;
  poReference: string;
}

export function collectCreateFindings(
  q: QueryForValidation,
  cargo: CargoForValidation[],
): Finding[] {
  const findings: Finding[] = [];
  const need = (present: unknown, message: string) => {
    if (present === null || present === undefined || present === "") {
      findings.push({ rule: "F1", severity: "blocking", scope: { type: "query", id: q.id }, message });
    }
  };
  need(q.clientId, "Client is required");
  need(q.contactName, "Contact person is required");
  need(q.contactEmail, "Contact email is required");
  need(q.contactPhone, "Contact phone is required");
  need(q.readyDate, "Ready Date is required");
  need(q.targetDelivery, "Target Delivery is required");
  need(q.incoterms, "Incoterms is required");
  for (const c of cargo) {
    if (c.isDangerous && !c.msdsFileId) {
      findings.push({
        rule: "F6",
        severity: "blocking",
        scope: { type: "cargo", id: c.id },
        message: `Cargo ${c.poReference}: a dangerous-goods row requires an MSDS (PDF)`,
      });
    }
  }
  return findings;
}

export interface QueryDto {
  id: string;
  queryCode: string;
  queryDate: string;
  priority: Priority;
  status: string;
  dgIndicator: boolean;
  // …snapshot + shipment fields returned as-is from Prisma (dates ISO strings).
}
```

- [ ] **Step 6: Export from `index.ts`**

Append to `packages/shared/src/index.ts`:
```ts
export * from "./query";
export * from "./cargo";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @svyft/shared test`
Expected: PASS (all suites, including the extended `status.test.ts`).

- [ ] **Step 8: Build shared (so api typecheck/build see the new exports later)**

Run: `pnpm --filter @svyft/shared build`
Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/query.ts packages/shared/src/cargo.ts \
  packages/shared/src/query.test.ts packages/shared/src/cargo.test.ts \
  packages/shared/src/status.ts packages/shared/src/status.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): query/cargo contracts + create-phase validation + zero-leg milestone projection"
```

---

### Task 2: Prisma models + migration #4 (with the `volumeCbm` generated column)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_query_cargo/migration.sql` (generated, then hand-edited)
- Test: `apps/api/test/query-cargo-model.e2e-spec.ts`

**Interfaces:**
- Produces models `Query`, `CargoItem`, `QueryChecklistItem`, `FileAsset`, `QuerySequence`. Consumed by every api task.
- **`CargoItem.volumeCbm`** is a Postgres `GENERATED ALWAYS AS (dimL·dimW·dimH·qty/1e6) STORED` column — represented in Prisma as `@default(dbgenerated(...))`. **Verified drift-free** (the `@default(dbgenerated(...))` string below is the exact `db pull` canonical form; `migrate diff` returns an empty migration against it).

- [ ] **Step 1: Write the failing test**

`apps/api/test/query-cargo-model.e2e-spec.ts`:
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { formatQueryCode } from "@svyft/shared";

const PFX = "p4-model-";

describe("Query/Cargo model (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.query.deleteMany({ where: { queryCode: { startsWith: "YAL" }, shipmentDescription: { startsWith: PFX } } });
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("mints a YALYY-NNNN code from a row-locked QuerySequence, atomically", async () => {
    const year = new Date().getFullYear();
    await prisma.querySequence.upsert({ where: { year }, create: { year, lastNumber: 0 }, update: {} });
    const before = (await prisma.querySequence.findUnique({ where: { year } }))!.lastNumber;
    const q = await prisma.$transaction(async (tx) => {
      const seq = await tx.querySequence.upsert({
        where: { year },
        create: { year, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      });
      return tx.query.create({
        data: { queryCode: formatQueryCode(year, seq.lastNumber), shipmentDescription: `${PFX}mint` },
      });
    });
    expect(q.queryCode).toMatch(/^YAL\d{2}-\d{4}$/);
    expect((await prisma.querySequence.findUnique({ where: { year } }))!.lastNumber).toBe(before + 1);
    expect(q.status).toBe("DRAFT"); // column default, not hand-written
  });

  it("computes volumeCbm as a generated column and rejects a direct write to it", async () => {
    const q = await prisma.query.create({ data: { queryCode: `Z${Date.now()}`.slice(0, 12), shipmentDescription: `${PFX}vol` } });
    const c = await prisma.cargoItem.create({
      data: {
        queryId: q.id, rowIndex: 1, poReference: "PO-1", productName: "W", packageType: "Pallet",
        referenceTags: ["HEAVY", "FRAGILE"], qty: 10, dimL: 120, dimW: 80, dimH: 100, grossWt: 500,
      },
    });
    expect(Number(c.volumeCbm)).toBeCloseTo(9.6, 6); // (120*80*100*10)/1e6
    expect(c.referenceTags).toEqual(["HEAVY", "FRAGILE"]);
    await expect(
      prisma.$executeRaw`INSERT INTO "CargoItem" (id, "queryId", "rowIndex", "poReference", "productName", "packageType", qty, "dimL", "dimW", "dimH", "grossWt", "volumeCbm") VALUES (gen_random_uuid(), ${q.id}::uuid, 2, 'PO-2', 'W', 'Box', 1, 1, 1, 1, 1, 5.0)`,
    ).rejects.toThrow();
  });

  it("cascade-deletes cargo + checklist + files when the query is deleted", async () => {
    const q = await prisma.query.create({ data: { queryCode: `Z${Date.now() + 1}`.slice(0, 12), shipmentDescription: `${PFX}cascade` } });
    await prisma.cargoItem.create({ data: { queryId: q.id, rowIndex: 1, poReference: "P", productName: "W", packageType: "Box", qty: 1, dimL: 1, dimW: 1, dimH: 1, grossWt: 1 } });
    await prisma.queryChecklistItem.create({ data: { queryId: q.id, itemKey: "weight-confirmed" } });
    await prisma.fileAsset.create({ data: { queryId: q.id, kind: "MSDS", filename: "x.pdf", mime: "application/pdf", sizeBytes: 1, storageKey: "k" } });
    await prisma.query.delete({ where: { id: q.id } });
    expect(await prisma.cargoItem.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.queryChecklistItem.count({ where: { queryId: q.id } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { queryId: q.id } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- query-cargo-model`
Expected: FAIL — `prisma.query`/`prisma.cargoItem` etc. don't exist on the client.

- [ ] **Step 3: Edit `prisma/schema.prisma` — add enums + models + back-relations**

Add enums (near the other enums). **`QueryStatus` must exist as a Prisma enum** for the `Query.status` column — values match `@svyft/shared`'s `QUERY_STATUSES` exactly:
```prisma
enum QueryStatus {
  DRAFT
  CREATED
  RFQ_READY
  RFQ_SENT
  QUOTED
  AWAITING_CLIENT_DECISION
  WON
  LOST
  CLOSED
}

enum Priority {
  LOW
  MEDIUM
  HIGH
  URGENT
}

enum Incoterms {
  EXW
  FCA
  FAS
  FOB
  CFR
  CIF
  CPT
  CIP
  DAP
  DPU
  DDP
}

enum ReferenceTag {
  HEAVY
  FRAGILE
  NON_STACKABLE
}

enum FileKind {
  MSDS
}
```

Add models:
```prisma
model QuerySequence {
  year       Int @id
  lastNumber Int @default(0)
}

model Query {
  id                      String     @id @default(uuid()) @db.Uuid
  tenantId                String?    @db.Uuid
  queryCode               String     @unique
  queryDate               DateTime   @default(now())
  priority                Priority   @default(MEDIUM)
  responseDeadline        DateTime?
  responseDeadlineRemarks String?
  clientId                String?    @db.Uuid
  client                  Client?    @relation(fields: [clientId], references: [id])
  // client-contact snapshot (never writes back to the master — §7.1)
  contactName             String?
  contactDesignation      String?
  contactEmail            String?
  contactPhone            String?
  whatsappEnabled         Boolean    @default(false)
  faxNumber               String?
  // vessel block (snapshot)
  vesselId                String?    @db.Uuid
  vessel                  Vessel?    @relation(fields: [vesselId], references: [id])
  vesselName              String?
  imoNumber               String?
  eta                     DateTime?
  etb                     DateTime?
  etd                     DateTime?
  portOfCall              String?
  // shipment
  incoterms               Incoterms?
  shipmentDescription     String?
  dgIndicator             Boolean    @default(false)
  // dates
  readyDate               DateTime?
  targetDelivery          DateTime?
  // notes + assignment + system status
  internalNotes           String?
  status                  QueryStatus @default(DRAFT)
  rfqReadyAt              DateTime?
  // Soft reference (nullable uuid, NO relation) — same convention as StatusTransition.actorId
  // and FileAsset.uploadedById: decoupled + keeps synthetic-jwt test subjects valid.
  assignedUserId          String?    @db.Uuid
  createdAt               DateTime   @default(now())
  updatedAt               DateTime   @updatedAt

  cargo     CargoItem[]
  checklist QueryChecklistItem[]
  files     FileAsset[]

  @@index([tenantId])
  @@index([clientId])
  @@index([assignedUserId])
}

model CargoItem {
  id               String         @id @default(uuid()) @db.Uuid
  tenantId         String?        @db.Uuid
  queryId          String         @db.Uuid
  query            Query          @relation(fields: [queryId], references: [id], onDelete: Cascade)
  rowIndex         Int
  poReference      String
  productName      String
  referenceTags    ReferenceTag[]
  hsCode           String?
  packageType      String
  isDangerous      Boolean        @default(false)
  msdsFileId       String?        @db.Uuid
  msdsFile         FileAsset?     @relation("CargoMsds", fields: [msdsFileId], references: [id])
  qty              Int
  dimL             Decimal        @db.Decimal(10, 2)
  dimW             Decimal        @db.Decimal(10, 2)
  dimH             Decimal        @db.Decimal(10, 2)
  netWt            Decimal?       @db.Decimal(12, 3)
  grossWt          Decimal        @db.Decimal(12, 3)
  // GENERATED ALWAYS AS ((dimL*dimW*dimH*qty)/1e6) STORED — see the hand-edited migration.
  // @default(dbgenerated(...)) is the exact `db pull` form → drift-free; never written by the app.
  volumeCbm        Decimal?       @default(dbgenerated("((((\"dimL\" * \"dimW\") * \"dimH\") * (qty)::numeric) / (1000000)::numeric)")) @db.Decimal(14, 6)
  freightDensity   Decimal?       @db.Decimal(12, 3) // null in Stage 3 (D4)
  chargeableWeight Decimal?       @db.Decimal(12, 3) // null in Stage 3 (D4)
  createdAt        DateTime       @default(now())
  updatedAt        DateTime       @updatedAt

  @@index([queryId])
  @@index([tenantId])
}

model QueryChecklistItem {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String?  @db.Uuid
  queryId   String   @db.Uuid
  query     Query    @relation(fields: [queryId], references: [id], onDelete: Cascade)
  itemKey   String
  checked   Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([queryId, itemKey])
  @@index([queryId])
}

model FileAsset {
  id           String      @id @default(uuid()) @db.Uuid
  tenantId     String?     @db.Uuid
  queryId      String      @db.Uuid
  query        Query       @relation(fields: [queryId], references: [id], onDelete: Cascade)
  kind         FileKind
  filename     String
  mime         String
  sizeBytes    Int
  storageKey   String
  uploadedById String?     @db.Uuid
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  msdsForCargo CargoItem[] @relation("CargoMsds")

  @@index([queryId])
  @@index([tenantId])
}
```

Add the back-relations to the existing models (no new SQL columns — the FK lives on `Query`). **Only `Client` and `Vessel`** — `assignedUserId` is a soft reference (no relation), so `User` is **not** modified:
- `Client` — add: `queries Query[]`
- `Vessel` — add: `queries Query[]`

- [ ] **Step 4: Generate the migration (create-only) and hand-edit the generated column**

Run (from repo root):
```bash
pnpm --filter @svyft/api exec prisma migrate dev --schema ../../prisma/schema.prisma --create-only --name query_cargo
```
Open the new `prisma/migrations/<ts>_query_cargo/migration.sql`. Prisma emits `volumeCbm` with an **invalid** column-referencing `DEFAULT`:
```sql
    "volumeCbm" DECIMAL(14,6) DEFAULT (((("dimL" * "dimW") * "dimH") * (qty)::numeric) / (1000000)::numeric),
```
Replace **that one line** with a STORED generated column:
```sql
    "volumeCbm" DECIMAL(14,6) GENERATED ALWAYS AS ("dimL" * "dimW" * "dimH" * "qty" / 1000000) STORED,
```
Leave the rest of the migration (tables, enums, FKs, indexes) exactly as generated.

- [ ] **Step 5: Apply the migration**

Run:
```bash
pnpm --filter @svyft/api exec prisma migrate dev --schema ../../prisma/schema.prisma
pnpm --filter @svyft/api exec prisma generate --schema ../../prisma/schema.prisma
```
Expected: "Your database is now in sync with your schema." (applies cleanly — no drift prompt, because the schema's `@default(dbgenerated(...))` matches the DB).

- [ ] **Step 6: Verify no drift**

Run:
```bash
pnpm --filter @svyft/api exec prisma migrate diff \
  --from-url "$(grep '^DATABASE_URL' apps/api/.env | cut -d'"' -f2)" \
  --to-schema-datamodel prisma/schema.prisma --script
```
Expected: `-- This is an empty migration.` (zero drift).

- [ ] **Step 7: Run the model test**

Run: `pnpm --filter @svyft/api test -- query-cargo-model`
Expected: PASS (volumeCbm = 9.6; direct write to volumeCbm rejected; cascade deletes; DRAFT default; row-locked mint).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/test/query-cargo-model.e2e-spec.ts
git commit -m "feat(prisma): Query/Cargo/Checklist/FileAsset/QuerySequence models + volumeCbm generated column (migration #4)"
```

---

### Task 3: Files module — storage service + `FilesService.storeMsds`

**Files:**
- Create: `apps/api/src/modules/files/storage.ts`, `apps/api/src/modules/files/files.service.ts`, `apps/api/src/modules/files/files.module.ts`
- Modify: `.gitignore` (add `uploads/`)
- Test: `apps/api/test/files.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, the `FileAsset` model (Task 2).
- Produces: `FilesService.storeMsds(queryId: string, file: MsdsUpload, uploadedById: string | null) => Promise<FileAsset>`; `MsdsUpload = { originalname: string; mimetype: string; size: number; buffer: Buffer }` (a structural subset of `Express.Multer.File`); the `STORAGE` DI token + `StorageService` port. `FilesModule` exports `FilesService`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/files.e2e-spec.ts`:
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.UPLOADS_DIR = mkdtempSync(join(tmpdir(), "svyft-uploads-"));

import { BadRequestException, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { FilesService } from "../src/modules/files/files.service";

const PFX = "p4-files-";

describe("FilesService (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let files: FilesService;
  let queryId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    files = moduleRef.get(FilesService);
    const q = await prisma.query.create({ data: { queryCode: `Z${Date.now()}`.slice(0, 12), shipmentDescription: `${PFX}q` } });
    queryId = q.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("stores a PDF on disk and records a FileAsset", async () => {
    const buffer = Buffer.from("%PDF-1.4\n%mock pdf\n");
    const asset = await files.storeMsds(queryId, { originalname: "msds.pdf", mimetype: "application/pdf", size: buffer.length, buffer }, null);
    expect(asset.kind).toBe("MSDS");
    expect(asset.mime).toBe("application/pdf");
    expect(existsSync(join(process.env.UPLOADS_DIR!, asset.storageKey))).toBe(true);
    expect(readFileSync(join(process.env.UPLOADS_DIR!, asset.storageKey)).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("rejects a non-PDF (mime or magic bytes)", async () => {
    await expect(
      files.storeMsds(queryId, { originalname: "x.png", mimetype: "image/png", size: 3, buffer: Buffer.from("PNG") }, null),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      files.storeMsds(queryId, { originalname: "fake.pdf", mimetype: "application/pdf", size: 3, buffer: Buffer.from("JPG") }, null),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- files`
Expected: FAIL — `FilesService` does not exist.

- [ ] **Step 3: Create `storage.ts`**

```ts
import { Injectable } from "@nestjs/common";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STORAGE = Symbol("STORAGE");

export interface StorageService {
  put(key: string, data: Buffer): Promise<void>;
  path(key: string): string;
}

// Local disk in dev → S3-compatible object store later (§8.4). UPLOADS_DIR read at
// CALL TIME (ConfigModule loads .env at init; a top-level const would capture stale env).
@Injectable()
export class LocalDiskStorage implements StorageService {
  private root(): string {
    return process.env.UPLOADS_DIR ?? join(process.cwd(), "uploads");
  }
  async put(key: string, data: Buffer): Promise<void> {
    const full = join(this.root(), key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  path(key: string): string {
    return join(this.root(), key);
  }
}
```

- [ ] **Step 4: Create `files.service.ts`**

```ts
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { FileAsset } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { STORAGE, type StorageService } from "./storage";

// Structural subset of Express.Multer.File (avoids a hard @types/multer dep here).
export interface MsdsUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageService,
  ) {}

  // MSDS is PDF-only (§7.3 F6). Validate BOTH the declared mime and the %PDF magic bytes.
  async storeMsds(
    queryId: string,
    file: MsdsUpload | undefined,
    uploadedById: string | null,
  ): Promise<FileAsset> {
    if (!file) throw new BadRequestException("No file uploaded");
    const isPdf =
      file.mimetype === "application/pdf" &&
      file.buffer.subarray(0, 5).toString("latin1") === "%PDF-";
    if (!isPdf) throw new BadRequestException("MSDS must be a PDF file");

    const storageKey = `msds/${queryId}/${randomUUID()}.pdf`;
    await this.storage.put(storageKey, file.buffer);
    return this.prisma.fileAsset.create({
      data: {
        queryId,
        kind: "MSDS",
        filename: file.originalname,
        mime: file.mimetype,
        sizeBytes: file.size,
        storageKey,
        uploadedById,
      },
    });
  }
}
```

- [ ] **Step 5: Create `files.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { FilesService } from "./files.service";
import { STORAGE, LocalDiskStorage } from "./storage";

@Module({
  providers: [FilesService, { provide: STORAGE, useClass: LocalDiskStorage }],
  exports: [FilesService],
})
export class FilesModule {}
```

- [ ] **Step 6: Register `FilesModule` in `app.module.ts`**

Add `import { FilesModule } from "./modules/files/files.module";` and add `FilesModule` to the `imports` array (after `ChangesModule`).

- [ ] **Step 7: Ignore the dev uploads dir**

Append to `.gitignore` under the "Misc" section:
```
# Local MSDS uploads (dev)
uploads/
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @svyft/api test -- files`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/files apps/api/src/app.module.ts apps/api/test/files.e2e-spec.ts .gitignore
git commit -m "feat(files): storage-backed FilesService with PDF-validated MSDS storage"
```

---

### Task 4: Queries module — create + get + impact declarations + wiring

**Files:**
- Create: `apps/api/src/modules/queries/query.impact.ts`, `queries.service.ts`, `queries.controller.ts`, `queries.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/queries.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `ChangeMediator` + `ImpactRegistry` (from `ChangesModule`); `QueryStatusProjector` (from `StatusModule`); `@CurrentUser()` → `RequestUser { userId, role, tenantId }`.
- Produces: `QueriesService.create(input, user)`, `.get(id)`, `.syncDgIndicator(queryId, tx)`; `queryImpactMap: EntityImpactMap`; `QueriesModule` (imports `ChangesModule`, `StatusModule`; declares `'query'` impacts on init; exports `QueriesService`).

- [ ] **Step 1: Write the failing test**

`apps/api/test/queries.e2e-spec.ts` (this suite grows in Tasks 5, 6, 10 — write the create/get slice now):
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

const PFX = "p4-queries-";

describe("Queries (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let clientId: string;
  // sub is a UUID: it lands in @db.Uuid columns (assignedUserId). A synthetic non-uuid
  // sub would P2023 on insert.
  const EXEC_ID = "11111111-1111-1111-1111-111111111111";
  const cookie = (role: Role, sub = EXEC_ID) => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma); // 9 checklist definitions (CI is unseeded)
    const client = await prisma.client.create({ data: { clientCode: `${PFX}CL`, companyName: `${PFX}Client`, country: "IN" } });
    clientId = client.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await prisma.client.deleteMany({ where: { companyName: { startsWith: PFX } } });
    await app.close();
  });

  it("401s an unauthenticated create", async () => {
    await request(app.getHttpServer()).post("/api/queries").send({}).expect(401);
  });

  it("mints a YALYY-NNNN code, seeds the 9 checklist items, assigns the creator, status DRAFT", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE, EXEC_ID))
      .send({ clientId, shipmentDescription: `${PFX}first`, incoterms: "FOB" })
      .expect(201);
    expect(res.body.queryCode).toMatch(/^YAL\d{2}-\d{4}$/);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.assignedUserId).toBe(EXEC_ID);
    const got = await request(app.getHttpServer())
      .get(`/api/queries/${res.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(got.body.checklist).toHaveLength(9);
    expect(got.body.checklist.every((c: { checked: boolean }) => c.checked === false)).toBe(true);
  });

  it("400s an invalid draft (bad email / bad incoterms)", async () => {
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ contactEmail: "nope", shipmentDescription: `${PFX}bad` })
      .expect(400);
  });

  it("400s a non-existent clientId (FK guarded, not a 500)", async () => {
    await request(app.getHttpServer())
      .post("/api/queries")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .send({ clientId: "00000000-0000-0000-0000-000000000000", shipmentDescription: `${PFX}fk` })
      .expect(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- queries`
Expected: FAIL — no `/api/queries` route.

- [ ] **Step 3: Create `query.impact.ts` (every editable field MUST have a class — §7.3/§11.1)**

```ts
import { ImpactClass } from "@svyft/shared";
import type { EntityImpactMap } from "../changes/impact.registry";

// Field → impact class for the Query aggregate. Must cover EVERY field in
// querySaveSchema, or the classifier throws. All Free-path in Stage 3 (no downstream
// work); classes gate the fork once Stage 4 RFQs exist.
export const queryImpactMap: EntityImpactMap = {
  // Internal — no downstream cost (§11.1)
  priority: ImpactClass.Internal,
  responseDeadline: ImpactClass.Internal,
  responseDeadlineRemarks: ImpactClass.Internal,
  internalNotes: ImpactClass.Internal,
  assignedUserId: ImpactClass.Internal,
  queryDate: ImpactClass.Internal,
  // Corrective — cosmetic contact/vessel edits (§11.1)
  contactName: ImpactClass.Corrective,
  contactDesignation: ImpactClass.Corrective,
  contactEmail: ImpactClass.Corrective,
  contactPhone: ImpactClass.Corrective,
  whatsappEnabled: ImpactClass.Corrective,
  faxNumber: ImpactClass.Corrective,
  vesselId: ImpactClass.Corrective,
  vesselName: ImpactClass.Corrective,
  imoNumber: ImpactClass.Corrective,
  eta: ImpactClass.Corrective,
  etb: ImpactClass.Corrective,
  etd: ImpactClass.Corrective,
  portOfCall: ImpactClass.Corrective,
  shipmentDescription: ImpactClass.Corrective,
  // RfqDefining — FFs quote against these (§11.1)
  clientId: ImpactClass.RfqDefining,
  incoterms: ImpactClass.RfqDefining,
  dgIndicator: ImpactClass.RfqDefining,
  readyDate: ImpactClass.RfqDefining,
  targetDelivery: ImpactClass.RfqDefining,
};
```

- [ ] **Step 4: Create `queries.service.ts` (create + get + dg-sync; PATCH/create/checklist land in Tasks 5/6/10)**

```ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatQueryCode, type QuerySaveInput } from "@svyft/shared";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";

// Fields the create/patch payload may carry that are stored 1:1 on Query.
type QueryWritable = Omit<QuerySaveInput, "queryDate">;

@Injectable()
export class QueriesService {
  constructor(private readonly prisma: PrismaService) {}

  // Convert ISO-string date fields in the validated payload to Date for Prisma. Returns a
  // loose record (caller casts to the Prisma create/update input; if `tsc` rejects the
  // direct `as`, use `as unknown as Prisma.Query…Input`).
  private toData(input: Partial<QuerySaveInput>): Record<string, unknown> {
    const dateKeys = ["responseDeadline", "eta", "etb", "etd", "readyDate", "targetDelivery", "queryDate"] as const;
    const data: Record<string, unknown> = { ...input };
    for (const k of dateKeys) if (data[k] != null) data[k] = new Date(data[k] as string);
    return data;
  }

  // clientId/vesselId are real FKs (P2003 is NOT mapped by the filter → verify here).
  // assignedUserId is a soft reference (no FK) — the Zod schema already guarantees uuid shape.
  private async assertRefsExist(input: Partial<QuerySaveInput>): Promise<void> {
    if (input.clientId && !(await this.prisma.client.findUnique({ where: { id: input.clientId } })))
      throw new BadRequestException("Unknown clientId");
    if (input.vesselId && !(await this.prisma.vessel.findUnique({ where: { id: input.vesselId } })))
      throw new BadRequestException("Unknown vesselId");
  }

  // First persist (§5): mint queryCode from a row-locked QuerySequence (atomic upsert
  // increment = INSERT … ON CONFLICT DO UPDATE … RETURNING, row-locked), seed the 9
  // checklist items, assign the creator. NOT mediated (entity birth). status = DRAFT default.
  async create(input: QuerySaveInput, user: RequestUser) {
    await this.assertRefsExist(input);
    const year = new Date().getFullYear();
    const data = this.toData(input);
    delete data.queryDate; // set to now() by the column default; backdate is Admin-only via PATCH
    return this.prisma.$transaction(async (tx) => {
      const seq = await tx.querySequence.upsert({
        where: { year },
        create: { year, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      });
      const query = await tx.query.create({
        data: {
          queryCode: formatQueryCode(year, seq.lastNumber),
          assignedUserId: input.assignedUserId ?? user.userId,
          tenantId: user.tenantId,
          ...data,
        } as Prisma.QueryUncheckedCreateInput,
      });
      const defs = await tx.checklistDefinition.findMany({ orderBy: { order: "asc" } });
      if (defs.length)
        await tx.queryChecklistItem.createMany({
          data: defs.map((d) => ({ queryId: query.id, itemKey: d.itemKey, tenantId: user.tenantId })),
        });
      await this.syncDgIndicator(query.id, tx);
      return this.getWithin(tx, query.id);
    });
  }

  async get(id: string) {
    return this.getWithin(this.prisma, id);
  }

  private async getWithin(client: Prisma.TransactionClient | PrismaService, id: string) {
    const query = await client.query.findUnique({
      where: { id },
      include: {
        cargo: { orderBy: { rowIndex: "asc" } },
        checklist: { orderBy: { itemKey: "asc" } },
        files: true,
      },
    });
    if (!query) throw new NotFoundException("Query not found");
    return query;
  }

  // dgIndicator is auto-TRUE when any cargo is DG; manual true stands; never auto-cleared
  // (§4.5 / §7.2). Called after any cargo mutation and at create.
  async syncDgIndicator(queryId: string, tx: Prisma.TransactionClient): Promise<void> {
    const dgCount = await tx.cargoItem.count({ where: { queryId, isDangerous: true } });
    if (dgCount > 0) await tx.query.update({ where: { id: queryId }, data: { dgIndicator: true } });
  }
}
```

- [ ] **Step 5: Create `queries.controller.ts` (create + get now; more routes in later tasks)**

```ts
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { querySaveSchema, type QuerySaveInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { QueriesService } from "./queries.service";

@Controller("queries")
export class QueriesController {
  constructor(private readonly queries: QueriesService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(querySaveSchema)) body: QuerySaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.queries.create(body, user);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.queries.get(id);
  }
}
```

- [ ] **Step 6: Create `queries.module.ts` (declare `'query'` impacts on init)**

```ts
import { Module, type OnModuleInit } from "@nestjs/common";
import { ImpactRegistry } from "../changes/impact.registry";
import { ChangesModule } from "../changes/changes.module";
import { StatusModule } from "../status/status.module";
import { QueriesService } from "./queries.service";
import { QueriesController } from "./queries.controller";
import { queryImpactMap } from "./query.impact";

@Module({
  imports: [ChangesModule, StatusModule],
  controllers: [QueriesController],
  providers: [QueriesService],
  exports: [QueriesService],
})
export class QueriesModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("query", queryImpactMap);
  }
}
```
> `ChangesModule` exports `ImpactRegistry` + `ChangeMediator`; `StatusModule` exports `QueryStatusProjector`. Both are needed by Tasks 5/6.

- [ ] **Step 7: Register `QueriesModule` in `app.module.ts`**

Add the import and add `QueriesModule` to `imports` (after `FilesModule`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @svyft/api test -- queries`
Expected: PASS (mint, checklist seed, assignment, DRAFT, 401, 400s).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/queries apps/api/src/app.module.ts apps/api/test/queries.e2e-spec.ts
git commit -m "feat(queries): Query aggregate create/get, code minting, checklist seed, impact declarations"
```

---

### Task 5: Queries PATCH through the Change Mediator + dgIndicator + backdate guard

**Files:**
- Modify: `apps/api/src/modules/queries/queries.service.ts`, `queries.controller.ts`
- Test: extend `apps/api/test/queries.e2e-spec.ts`

**Interfaces:**
- Consumes: `ChangeMediator.apply(req: ChangeRequest, uow: UnitOfWork)`, `ImpactRegistry.classOf`, `IMPACT_RANK`.
- Produces: `QueriesService.patch(id, input, user)` — runs the mediator **once per PATCH** (per wizard step), representative field = highest-impact changed field, uow applies the full validated patch + re-syncs `dgIndicator` in one tx.

- [ ] **Step 1: Write the failing test (append to the `Queries (e2e)` describe)**

```ts
it("patches fields through the Free-path mediator and returns the updated query", async () => {
  const created = await request(app.getHttpServer())
    .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
    .send({ clientId, shipmentDescription: `${PFX}patch` }).expect(201);
  const res = await request(app.getHttpServer())
    .patch(`/api/queries/${created.body.id}`).set("Cookie", cookie(Role.EXECUTIVE))
    .send({ priority: "HIGH", incoterms: "CIF", internalNotes: "hello" }).expect(200);
  expect(res.body.priority).toBe("HIGH");
  expect(res.body.incoterms).toBe("CIF");
  expect(res.body.internalNotes).toBe("hello");
});

it("403s a non-Admin backdating queryDate, but lets an Admin", async () => {
  const created = await request(app.getHttpServer())
    .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
    .send({ shipmentDescription: `${PFX}backdate` }).expect(201);
  await request(app.getHttpServer())
    .patch(`/api/queries/${created.body.id}`).set("Cookie", cookie(Role.EXECUTIVE))
    .send({ queryDate: "2020-01-01T00:00:00.000Z" }).expect(403);
  await request(app.getHttpServer())
    .patch(`/api/queries/${created.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ queryDate: "2020-01-01T00:00:00.000Z" }).expect(200);
});

it("404s a PATCH to a missing query", async () => {
  await request(app.getHttpServer())
    .patch(`/api/queries/00000000-0000-0000-0000-000000000000`).set("Cookie", cookie(Role.EXECUTIVE))
    .send({ priority: "LOW" }).expect(404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- queries`
Expected: FAIL — no PATCH route.

- [ ] **Step 3: Extend `queries.service.ts`**

Add imports:
```ts
import { ForbiddenException } from "@nestjs/common";
import { IMPACT_RANK, type ChangeRequest } from "@svyft/shared";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
```
Update the constructor:
```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
  ) {}
```
Add the representative-field helper + `patch`:
```ts
  // Highest-impact changed field names the ChangeRequest (Stage-3 is always Free path,
  // but this is the class that would gate the Stage-4 fork). Rejects any field with no
  // declared impact class with a 400 (never a classifier 500).
  private representativeField(entity: string, fields: string[]): string {
    return fields.reduce((hi, f) => {
      const c = this.impacts.classOf(entity, f);
      if (!c) throw new BadRequestException(`Field '${f}' is not editable`);
      const hc = this.impacts.classOf(entity, hi);
      return hc && IMPACT_RANK[c] > IMPACT_RANK[hc] ? f : hi;
    }, fields[0]);
  }

  async patch(id: string, input: QuerySaveInput, user: RequestUser) {
    const existing = await this.prisma.query.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException("Query not found");

    if (input.queryDate !== undefined && user.role !== "ADMINISTRATOR") {
      throw new ForbiddenException("Only an Administrator may edit the Query Date");
    }
    await this.assertRefsExist(input);

    const fields = Object.keys(input);
    if (fields.length === 0) return this.get(id);
    const data = this.toData(input);

    // One mediator call per PATCH (= per wizard step). The uow applies the whole patch +
    // re-syncs dgIndicator inside the strategy's transaction (Free path → apply → revalidate → log).
    await this.mediator.apply(
      { entity: "query", id, field: this.representativeField("query", fields), patch: input, queryId: id, actorId: user.userId },
      async (tx) => {
        await tx.query.update({ where: { id }, data: data as Prisma.QueryUncheckedUpdateInput });
        await this.syncDgIndicator(id, tx);
      },
    );
    return this.get(id);
  }
```
> `ChangeRequest` is imported for typing intent; the object literal is inferred. Keep it if lint flags the unused import — otherwise drop it.

- [ ] **Step 4: Add the PATCH route to `queries.controller.ts`**

```ts
import { Patch } from "@nestjs/common";
// …
  @Patch(":id")
  patch(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(querySaveSchema)) body: QuerySaveInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.queries.patch(id, body, user);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @svyft/api test -- queries`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/queries apps/api/test/queries.e2e-spec.ts
git commit -m "feat(queries): PATCH through the Change Mediator (Free path) + Admin-only queryDate backdate"
```

---

### Task 6: `POST /queries/:id/create` — create-phase validation → `RFQ_READY` via the projector

**Files:**
- Modify: `apps/api/src/modules/status/query-status.projector.ts` (persist `Query.status`)
- Modify: `apps/api/src/modules/queries/queries.service.ts`, `queries.controller.ts`
- Test: extend `apps/api/test/queries.e2e-spec.ts`

**Interfaces:**
- Consumes: `collectCreateFindings` (Task 1); `QueryStatusProjector.recompute(queryId, client)`.
- Produces: `QueriesService.createQuery(id, user)` → `{ id, status }` on success (`RFQ_READY`), throws `HttpException({ findings }, 422)` when blocked. `QueryStatusProjector.recompute` now loads the query + persists `deriveQueryStatus([], { created: !!rfqReadyAt, rfqReady: !!rfqReadyAt })`.

- [ ] **Step 1: Write the failing test (append to `Queries (e2e)`)**

```ts
it("422s Create Query with F1/F6 findings when mandatory fields are missing", async () => {
  const created = await request(app.getHttpServer())
    .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
    .send({ shipmentDescription: `${PFX}incomplete` }).expect(201);
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${created.body.id}/create`).set("Cookie", cookie(Role.EXECUTIVE))
    .expect(422);
  expect(res.body.findings.length).toBeGreaterThan(0);
  expect(res.body.findings.every((f: { severity: string }) => f.severity === "blocking")).toBe(true);
  const still = await prisma.query.findUnique({ where: { id: created.body.id } });
  expect(still!.status).toBe("DRAFT"); // unchanged on block
});

it("sets RFQ_READY through the projector when all mandatory fields are present", async () => {
  const created = await request(app.getHttpServer())
    .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
    .send({
      clientId, shipmentDescription: `${PFX}complete`, incoterms: "FOB",
      contactName: "Jo", contactEmail: "jo@acme.test", contactPhone: "+911234567890",
      readyDate: "2026-08-01T00:00:00.000Z", targetDelivery: "2026-08-20T00:00:00.000Z",
    }).expect(201);
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${created.body.id}/create`).set("Cookie", cookie(Role.EXECUTIVE))
    .expect(201);
  expect(res.body.status).toBe("RFQ_READY");
  const row = await prisma.query.findUnique({ where: { id: created.body.id } });
  expect(row!.status).toBe("RFQ_READY");
  expect(row!.rfqReadyAt).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- queries`
Expected: FAIL — no `/create` route.

- [ ] **Step 3: Make `QueryStatusProjector.recompute` persist (Plan-4 impl)**

Replace the body of `apps/api/src/modules/status/query-status.projector.ts` `recompute` and inject Prisma. Full file:
```ts
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { deriveQueryStatus } from "@svyft/shared";
import type { LegStatus, QueryMilestones, QueryStatus } from "@svyft/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { StatusChangedEvent } from "./status.service";

// Derived/rollup query status is a PROJECTION, not a machine (§7.2). THE one door that
// persists Query.status. Plan 4 has no legs, so status is driven by query-level
// milestones (rfqReadyAt); the leg rollup fills in when legs land (Plan 5).
@Injectable()
export class QueryStatusProjector {
  private readonly logger = new Logger(QueryStatusProjector.name);
  constructor(private readonly prisma: PrismaService) {}

  project(legStatuses: LegStatus[], milestones: QueryMilestones = {}): QueryStatus {
    return deriveQueryStatus(legStatuses, milestones);
  }

  @OnEvent("leg.status.changed")
  async onLegStatusChanged(event: StatusChangedEvent): Promise<void> {
    try {
      await this.recompute(event.queryId);
    } catch (err) {
      this.logger.error(`query-status recompute failed for ${event.queryId}`, err as Error);
    }
  }

  // Persist the projected status. `client` lets a caller (Create Query) run this inside
  // its own transaction. Plan 5 will load real leg statuses instead of [].
  async recompute(
    queryId?: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    if (!queryId) return;
    const q = await client.query.findUnique({ where: { id: queryId }, select: { rfqReadyAt: true } });
    if (!q) return;
    const legStatuses: LegStatus[] = []; // Plan 5: load the query's leg statuses
    const status = this.project(legStatuses, { created: !!q.rfqReadyAt, rfqReady: !!q.rfqReadyAt });
    await client.query.update({ where: { id: queryId }, data: { status } });
  }
}
```
> The existing `status-machine.e2e-spec` test spies on `recompute` (called with `"q-42"`); the assertion `toHaveBeenCalledWith("q-42")` still holds (single arg — the default `client` is not passed explicitly). Any DB error for the synthetic `q-42` id is swallowed by `onLegStatusChanged`'s try/catch.

- [ ] **Step 4: Add `createQuery` to `queries.service.ts`**

Add imports:
```ts
import { HttpException, HttpStatus } from "@nestjs/common";
import { collectCreateFindings } from "@svyft/shared";
import { QueryStatusProjector } from "../status/query-status.projector";
```
Add `QueryStatusProjector` to the constructor:
```ts
    private readonly projector: QueryStatusProjector,
```
Add the method:
```ts
  // Create Query (§13): run the create-phase field/cargo catalogue (F1/F6; F2–F5 already
  // enforced at save). Route rules R1–R9 + the leg rollup are Plan 5. On pass, set the
  // rfqReadyAt milestone and let the projector persist RFQ_READY (never hand-write status).
  async createQuery(id: string, user: RequestUser) {
    const q = await this.prisma.query.findUnique({
      where: { id },
      include: { cargo: { select: { id: true, isDangerous: true, msdsFileId: true, poReference: true } } },
    });
    if (!q) throw new NotFoundException("Query not found");

    const findings = collectCreateFindings(
      {
        id: q.id, clientId: q.clientId, contactName: q.contactName, contactEmail: q.contactEmail,
        contactPhone: q.contactPhone, readyDate: q.readyDate, targetDelivery: q.targetDelivery,
        incoterms: q.incoterms,
      },
      q.cargo,
    );
    if (findings.length > 0) throw new HttpException({ findings }, HttpStatus.UNPROCESSABLE_ENTITY);

    await this.prisma.$transaction(async (tx) => {
      await tx.query.update({ where: { id }, data: { rfqReadyAt: new Date() } });
      await this.projector.recompute(id, tx); // persists RFQ_READY
    });
    const updated = await this.prisma.query.findUnique({ where: { id }, select: { id: true, status: true } });
    return updated!;
  }
```

- [ ] **Step 5: Add the route to `queries.controller.ts`**

```ts
import { HttpCode } from "@nestjs/common";
// …
  @Post(":id/create")
  @HttpCode(201)
  createQuery(@Param("id") id: string, @CurrentUser() user: RequestUser) {
    return this.queries.createQuery(id, user);
  }
```
> Order the decorators so `@Post(":id/create")` is declared; Nest routes the more specific static segment fine alongside `@Post()`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @svyft/api test -- queries status-machine`
Expected: PASS (both suites — the projector change keeps `status-machine` green).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/queries apps/api/src/modules/status/query-status.projector.ts apps/api/test/queries.e2e-spec.ts
git commit -m "feat(queries): Create Query validation → RFQ_READY persisted via QueryStatusProjector"
```

---

### Task 7: Cargo module — CRUD through the mediator + rowIndex + dgIndicator sync

**Files:**
- Create: `apps/api/src/modules/cargo/cargo.impact.ts`, `cargo.service.ts`, `cargo.controller.ts`, `cargo.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/cargo.e2e-spec.ts`

**Interfaces:**
- Consumes: `ChangeMediator`, `ImpactRegistry`, `QueriesService.syncDgIndicator` (from `QueriesModule`), `FilesService` (from `FilesModule`, used in Task 8).
- Produces: `CargoService.create/update/remove`; `cargoImpactMap`; `CargoModule` (imports `ChangesModule`, `QueriesModule`, `FilesModule`; declares `'cargo'` impacts; controller under `queries/:id/cargo`).

- [ ] **Step 1: Write the failing test**

`apps/api/test/cargo.e2e-spec.ts` (grows in Tasks 8, 9 — the `UPLOADS_DIR` header is set now because Task 8 appends an MSDS-upload test to this suite):
```ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.UPLOADS_DIR = process.env.UPLOADS_DIR ?? mkdtempSync(joinPath(tmpdir(), "svyft-uploads-"));

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";
import { seedReferenceData } from "../src/seed/reference-seed";

const PFX = "p4-cargo-";

describe("Cargo (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let queryId: string;
  // UUID sub — user.userId lands in @db.Uuid columns (FileAsset.uploadedById on MSDS upload).
  const USER_ID = "22222222-2222-2222-2222-222222222222";
  const cookie = (role: Role) => `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: USER_ID, role, tenantId: null })}`;
  const baseRow = { poReference: "PO-1", productName: "Widget", packageType: "Pallet", qty: 10, dimL: 120, dimW: 80, dimH: 100, grossWt: 500 };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(prisma);
    const q = await prisma.query.create({ data: { queryCode: `Z${Date.now()}`.slice(0, 12), shipmentDescription: `${PFX}q` } });
    queryId = q.id;
  });
  afterAll(async () => {
    await prisma.query.deleteMany({ where: { shipmentDescription: { startsWith: PFX } } });
    await app.close();
  });

  it("creates a cargo row (mediated @create), auto-numbers rowIndex, computes volumeCbm", async () => {
    const r1 = await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie(Role.EXECUTIVE)).send(baseRow).expect(201);
    expect(r1.body.rowIndex).toBe(1);
    expect(Number(r1.body.volumeCbm)).toBeCloseTo(9.6, 3);
    const r2 = await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie(Role.EXECUTIVE)).send(baseRow).expect(201);
    expect(r2.body.rowIndex).toBe(2);
  });

  it("auto-sets the query dgIndicator when a DG cargo row is added", async () => {
    await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie(Role.EXECUTIVE)).send({ ...baseRow, isDangerous: true }).expect(201);
    const q = await prisma.query.findUnique({ where: { id: queryId } });
    expect(q!.dgIndicator).toBe(true);
  });

  it("updates a row (mediated) and rejects qty <= 0", async () => {
    const created = await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie(Role.EXECUTIVE)).send(baseRow).expect(201);
    await request(app.getHttpServer()).patch(`/api/queries/${queryId}/cargo/${created.body.id}`).set("Cookie", cookie(Role.EXECUTIVE)).send({ productName: "Renamed" }).expect(200);
    await request(app.getHttpServer()).patch(`/api/queries/${queryId}/cargo/${created.body.id}`).set("Cookie", cookie(Role.EXECUTIVE)).send({ qty: 0 }).expect(400);
  });

  it("deletes a row (mediated @delete)", async () => {
    const created = await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie(Role.EXECUTIVE)).send(baseRow).expect(201);
    await request(app.getHttpServer()).delete(`/api/queries/${queryId}/cargo/${created.body.id}`).set("Cookie", cookie(Role.EXECUTIVE)).expect(204);
    expect(await prisma.cargoItem.findUnique({ where: { id: created.body.id } })).toBeNull();
  });

  it("404s cargo under a mismatched query", async () => {
    const created = await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie(Role.EXECUTIVE)).send(baseRow).expect(201);
    await request(app.getHttpServer()).patch(`/api/queries/00000000-0000-0000-0000-000000000000/cargo/${created.body.id}`).set("Cookie", cookie(Role.EXECUTIVE)).send({ productName: "X" }).expect(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- cargo`
Expected: FAIL — no cargo routes.

- [ ] **Step 3: Create `cargo.impact.ts`**

```ts
import { ImpactClass } from "@svyft/shared";
import type { EntityImpactMap } from "../changes/impact.registry";

// Cargo field → impact class (§11.1). Weight/dims/DG = RfqDefining (FFs quote against
// them); labels/refs/docs = Corrective; add/remove a row = Structural. volumeCbm is
// generated and freightDensity/chargeableWeight are Stage-4 → never edited here.
export const cargoImpactMap: EntityImpactMap = {
  poReference: ImpactClass.Corrective,
  productName: ImpactClass.Corrective,
  referenceTags: ImpactClass.Corrective,
  hsCode: ImpactClass.Corrective,
  msdsFileId: ImpactClass.Corrective,
  packageType: ImpactClass.RfqDefining,
  isDangerous: ImpactClass.RfqDefining,
  qty: ImpactClass.RfqDefining,
  dimL: ImpactClass.RfqDefining,
  dimW: ImpactClass.RfqDefining,
  dimH: ImpactClass.RfqDefining,
  netWt: ImpactClass.RfqDefining,
  grossWt: ImpactClass.RfqDefining,
  "@create": ImpactClass.Structural,
  "@delete": ImpactClass.Structural,
};
```

- [ ] **Step 4: Create `cargo.service.ts`**

```ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { IMPACT_RANK, type CargoCreateInput, type CargoUpdateInput } from "@svyft/shared";
import { randomUUID } from "node:crypto";
import type { RequestUser } from "../auth/types";
import { PrismaService } from "../../prisma/prisma.service";
import { ChangeMediator } from "../changes/change-mediator";
import { ImpactRegistry } from "../changes/impact.registry";
import { QueriesService } from "../queries/queries.service";

@Injectable()
export class CargoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediator: ChangeMediator,
    private readonly impacts: ImpactRegistry,
    private readonly queries: QueriesService,
  ) {}

  private async assertQueryExists(queryId: string): Promise<void> {
    if (!(await this.prisma.query.findUnique({ where: { id: queryId }, select: { id: true } })))
      throw new NotFoundException("Query not found");
  }

  private async load(queryId: string, cid: string) {
    const row = await this.prisma.cargoItem.findFirst({ where: { id: cid, queryId } });
    if (!row) throw new NotFoundException("Cargo row not found");
    return row;
  }

  private representativeField(fields: string[]): string {
    return fields.reduce((hi, f) => {
      const c = this.impacts.classOf("cargo", f);
      if (!c) throw new BadRequestException(`Field '${f}' is not editable`);
      const hc = this.impacts.classOf("cargo", hi);
      return hc && IMPACT_RANK[c] > IMPACT_RANK[hc] ? f : hi;
    }, fields[0]);
  }

  // Mediated @create: assign the next rowIndex, persist the row, re-sync dgIndicator — all
  // inside the Free-path strategy's transaction.
  async create(queryId: string, input: CargoCreateInput, user: RequestUser) {
    await this.assertQueryExists(queryId);
    const id = randomUUID();
    let created: unknown;
    await this.mediator.apply(
      { entity: "cargo", id, action: "@create", queryId, actorId: user.userId },
      async (tx) => {
        const max = await tx.cargoItem.aggregate({ where: { queryId }, _max: { rowIndex: true } });
        created = await tx.cargoItem.create({
          data: {
            id, queryId, tenantId: user.tenantId, rowIndex: (max._max.rowIndex ?? 0) + 1,
            poReference: input.poReference, productName: input.productName,
            referenceTags: input.referenceTags ?? [], hsCode: input.hsCode ?? null,
            packageType: input.packageType, isDangerous: input.isDangerous ?? false,
            qty: input.qty, dimL: input.dimL, dimW: input.dimW, dimH: input.dimH,
            netWt: input.netWt ?? null, grossWt: input.grossWt,
          },
        });
        await this.queries.syncDgIndicator(queryId, tx);
      },
    );
    return created;
  }

  async update(queryId: string, cid: string, input: CargoUpdateInput, user: RequestUser) {
    await this.load(queryId, cid);
    const fields = Object.keys(input);
    if (fields.length === 0) return this.load(queryId, cid);
    let updated: unknown;
    await this.mediator.apply(
      { entity: "cargo", id: cid, field: this.representativeField(fields), patch: input, queryId, actorId: user.userId },
      async (tx) => {
        updated = await tx.cargoItem.update({ where: { id: cid }, data: input as Prisma.CargoItemUncheckedUpdateInput });
        await this.queries.syncDgIndicator(queryId, tx);
      },
    );
    return updated;
  }

  async remove(queryId: string, cid: string, user: RequestUser) {
    await this.load(queryId, cid);
    await this.mediator.apply(
      { entity: "cargo", id: cid, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.cargoItem.delete({ where: { id: cid } });
        await this.queries.syncDgIndicator(queryId, tx);
      },
    );
  }
}
```

- [ ] **Step 5: Create `cargo.controller.ts` (export + msds added in Tasks 8/9)**

```ts
import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { cargoCreateSchema, cargoUpdateSchema, type CargoCreateInput, type CargoUpdateInput } from "@svyft/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../auth/types";
import { CargoService } from "./cargo.service";

@Controller("queries/:id/cargo")
export class CargoController {
  constructor(private readonly cargo: CargoService) {}

  @Post()
  create(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(cargoCreateSchema)) body: CargoCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.cargo.create(id, body, user);
  }

  @Patch(":cid")
  update(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @Body(new ZodValidationPipe(cargoUpdateSchema)) body: CargoUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.cargo.update(id, cid, body, user);
  }

  @Delete(":cid")
  @HttpCode(204)
  async remove(@Param("id") id: string, @Param("cid") cid: string, @CurrentUser() user: RequestUser) {
    await this.cargo.remove(id, cid, user);
  }
}
```

- [ ] **Step 6: Create `cargo.module.ts`**

```ts
import { Module, type OnModuleInit } from "@nestjs/common";
import { ChangesModule } from "../changes/changes.module";
import { ImpactRegistry } from "../changes/impact.registry";
import { QueriesModule } from "../queries/queries.module";
import { FilesModule } from "../files/files.module";
import { CargoService } from "./cargo.service";
import { CargoController } from "./cargo.controller";
import { cargoImpactMap } from "./cargo.impact";

@Module({
  imports: [ChangesModule, QueriesModule, FilesModule],
  controllers: [CargoController],
  providers: [CargoService],
})
export class CargoModule implements OnModuleInit {
  constructor(private readonly impacts: ImpactRegistry) {}
  onModuleInit(): void {
    this.impacts.declare("cargo", cargoImpactMap);
  }
}
```

- [ ] **Step 7: Register `CargoModule` in `app.module.ts`** (add import + add to `imports` after `QueriesModule`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @svyft/api test -- cargo`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/cargo apps/api/src/app.module.ts apps/api/test/cargo.e2e-spec.ts
git commit -m "feat(cargo): mediated CRUD with rowIndex + dgIndicator sync"
```

---

### Task 8: Cargo MSDS upload (multipart PDF)

**Files:**
- Modify: `apps/api/src/modules/cargo/cargo.service.ts`, `cargo.controller.ts`, `cargo.module.ts`
- Modify: `apps/api/package.json` (add `@types/multer` devDependency)
- Test: extend `apps/api/test/cargo.e2e-spec.ts`

**Interfaces:**
- Consumes: `FilesService.storeMsds`; `FileInterceptor` from `@nestjs/platform-express` (multer bundled).
- Produces: `CargoService.attachMsds(queryId, cid, file, user)` — stores the PDF + `FileAsset`, links `cargo.msdsFileId` through the mediator (Corrective).

- [ ] **Step 1: Add `@types/multer`**

Run: `pnpm --filter @svyft/api add -D @types/multer`
Expected: `apps/api/package.json` gains `@types/multer`; lockfile updates.

- [ ] **Step 2: Write the failing test (append to `Cargo (e2e)`)**

```ts
it("uploads an MSDS PDF, links it to the row, and rejects a non-PDF", async () => {
  const created = await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie(Role.EXECUTIVE)).send({ ...baseRow, isDangerous: true }).expect(201);
  const pdf = Buffer.from("%PDF-1.4\n%mock\n");
  const up = await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/cargo/${created.body.id}/msds`)
    .set("Cookie", cookie(Role.EXECUTIVE))
    .attach("file", pdf, "msds.pdf")
    .expect(201);
  expect(up.body.msdsFileId).toBeTruthy();
  const asset = await prisma.fileAsset.findUnique({ where: { id: up.body.msdsFileId } });
  expect(asset!.kind).toBe("MSDS");
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/cargo/${created.body.id}/msds`)
    .set("Cookie", cookie(Role.EXECUTIVE))
    .attach("file", Buffer.from("PNG"), "x.png")
    .expect(400);
});
```
> `UPLOADS_DIR` is already set by the suite header added in Task 7 (a temp dir), so the upload writes to a throwaway location.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- cargo`
Expected: FAIL — no `/msds` route.

- [ ] **Step 4: Add `attachMsds` to `cargo.service.ts`**

Add the import + `FilesService` (and its `MsdsUpload` type) to the constructor:
```ts
import { FilesService, type MsdsUpload } from "../files/files.service";
// constructor: … private readonly files: FilesService,
```
```ts
  // Store the PDF + FileAsset, then link cargo.msdsFileId through the mediator (Corrective).
  async attachMsds(queryId: string, cid: string, file: MsdsUpload | undefined, user: RequestUser) {
    await this.load(queryId, cid);
    const asset = await this.files.storeMsds(queryId, file, user.userId); // 400s a non-PDF/no-file
    let updated: unknown;
    await this.mediator.apply(
      { entity: "cargo", id: cid, field: "msdsFileId", patch: { msdsFileId: asset.id }, queryId, actorId: user.userId },
      async (tx) => {
        updated = await tx.cargoItem.update({ where: { id: cid }, data: { msdsFileId: asset.id } });
      },
    );
    return updated;
  }
```

- [ ] **Step 5: Add the route to `cargo.controller.ts`**

```ts
import { UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { MsdsUpload } from "../files/files.service";
// …
  @Post(":cid/msds")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadMsds(
    @Param("id") id: string,
    @Param("cid") cid: string,
    @UploadedFile() file: MsdsUpload,
    @CurrentUser() user: RequestUser,
  ) {
    return this.cargo.attachMsds(id, cid, file, user);
  }
```
> `FileInterceptor`'s default memory storage populates `file.buffer` (a structural `MsdsUpload`), so no `@types/multer`-typed `Express.Multer.File` is required in the signature; `@types/multer` is added so the interceptor's own types resolve during `tsc`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @svyft/api test -- cargo`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/cargo apps/api/package.json ../../pnpm-lock.yaml apps/api/test/cargo.e2e-spec.ts
git commit -m "feat(cargo): multipart MSDS PDF upload linked via the mediator"
```

---

### Task 9: Cargo Excel export (`exceljs`, worksheet `Product`)

**Files:**
- Modify: `apps/api/src/modules/cargo/cargo.service.ts`, `cargo.controller.ts`
- Modify: `apps/api/package.json` (add `exceljs`)
- Test: extend `apps/api/test/cargo.e2e-spec.ts`

**Interfaces:**
- Produces: `CargoService.exportXlsx(queryId) => Promise<Buffer>`; `POST /queries/:id/cargo/export` streams the workbook.

- [ ] **Step 1: Add `exceljs`**

Run: `pnpm --filter @svyft/api add exceljs`
Expected: `apps/api/package.json` gains `exceljs`; lockfile updates.

- [ ] **Step 2: Write the failing test (append to `Cargo (e2e)`)**

```ts
it("exports cargo to an .xlsx workbook whose single worksheet is named Product", async () => {
  await request(app.getHttpServer()).post(`/api/queries/${queryId}/cargo`).set("Cookie", cookie(Role.EXECUTIVE)).send(baseRow).expect(201);
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/cargo/export`)
    .set("Cookie", cookie(Role.EXECUTIVE))
    .buffer(true)
    .parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); })
    .expect(201);
  expect(res.headers["content-type"]).toContain("spreadsheetml");
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  expect(wb.worksheets.map((w) => w.name)).toEqual(["Product"]);
  expect(wb.getWorksheet("Product")!.getRow(1).getCell(1).value).toBe("#");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- cargo`
Expected: FAIL — no `/export` route.

- [ ] **Step 4: Add `exportXlsx` to `cargo.service.ts`**

```ts
import ExcelJS from "exceljs";
// …
  // Server-side exceljs stream, single worksheet "Product" (§7.3, §8.6). Import is out of scope.
  async exportXlsx(queryId: string): Promise<Buffer> {
    await this.assertQueryExists(queryId);
    const rows = await this.prisma.cargoItem.findMany({ where: { queryId }, orderBy: { rowIndex: "asc" } });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Product");
    ws.columns = [
      { header: "#", key: "rowIndex", width: 6 },
      { header: "PO / Reference", key: "poReference", width: 18 },
      { header: "Product Name", key: "productName", width: 24 },
      { header: "Reference Tags", key: "referenceTags", width: 20 },
      { header: "HS / HSN Code", key: "hsCode", width: 14 },
      { header: "Package Type", key: "packageType", width: 14 },
      { header: "DG", key: "isDangerous", width: 6 },
      { header: "Qty", key: "qty", width: 8 },
      { header: "Dim L (cm)", key: "dimL", width: 12 },
      { header: "Dim W (cm)", key: "dimW", width: 12 },
      { header: "Dim H (cm)", key: "dimH", width: 12 },
      { header: "Net Wt (kg)", key: "netWt", width: 12 },
      { header: "Gross Wt (kg)", key: "grossWt", width: 12 },
      { header: "Volume (CBM)", key: "volumeCbm", width: 14 },
      { header: "Freight Density", key: "freightDensity", width: 14 },
      { header: "Chargeable Wt (T)", key: "chargeableWeight", width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        rowIndex: r.rowIndex, poReference: r.poReference, productName: r.productName,
        referenceTags: r.referenceTags.join(", "), hsCode: r.hsCode ?? "", packageType: r.packageType,
        isDangerous: r.isDangerous ? "Yes" : "No", qty: r.qty,
        dimL: Number(r.dimL), dimW: Number(r.dimW), dimH: Number(r.dimH),
        netWt: r.netWt == null ? "" : Number(r.netWt), grossWt: Number(r.grossWt),
        volumeCbm: r.volumeCbm == null ? "" : Number(r.volumeCbm),
        freightDensity: "", chargeableWeight: "", // null/read-only in Stage 3 (D4)
      });
    }
    return (await wb.xlsx.writeBuffer()) as Buffer;
  }
```

- [ ] **Step 5: Add the route to `cargo.controller.ts`**

```ts
import { Header, Res } from "@nestjs/common";
import type { Response } from "express";
// …
  @Post("export")
  @HttpCode(201)
  async export(@Param("id") id: string, @Res() res: Response) {
    const buf = await this.cargo.exportXlsx(id);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="query-${id}-cargo.xlsx"`);
    res.send(buf);
  }
```
> Declare `@Post("export")` **before** `@Post()`? No — they differ by path (`export` vs empty). Nest matches `queries/:id/cargo/export` to this handler and `queries/:id/cargo` to `create` unambiguously. Keep `:cid` routes (`@Patch(":cid")`, `@Post(":cid/msds")`) — `export` is a static segment so it will not be captured by a `:cid` param on a different method.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @svyft/api test -- cargo`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/cargo apps/api/package.json ../../pnpm-lock.yaml apps/api/test/cargo.e2e-spec.ts
git commit -m "feat(cargo): Excel export (exceljs, worksheet Product)"
```

---

### Task 10: Checklist PATCH

**Files:**
- Modify: `apps/api/src/modules/queries/queries.service.ts`, `queries.controller.ts`
- Test: extend `apps/api/test/queries.e2e-spec.ts`

**Interfaces:**
- Produces: `QueriesService.patchChecklist(id, input)` — toggles `QueryChecklistItem.checked` per `itemKey`; ignores keys not on the query (or 400s an unknown key — see below).

- [ ] **Step 1: Write the failing test (append to `Queries (e2e)`)**

```ts
it("toggles checklist item checked state", async () => {
  const created = await request(app.getHttpServer())
    .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
    .send({ clientId, shipmentDescription: `${PFX}checklist` }).expect(201);
  const res = await request(app.getHttpServer())
    .patch(`/api/queries/${created.body.id}/checklist`).set("Cookie", cookie(Role.EXECUTIVE))
    .send({ items: [{ itemKey: "weight-confirmed", checked: true }, { itemKey: "packing-list", checked: true }] })
    .expect(200);
  const checked = res.body.checklist.filter((c: { checked: boolean }) => c.checked).map((c: { itemKey: string }) => c.itemKey).sort();
  expect(checked).toEqual(["packing-list", "weight-confirmed"]);
});

it("400s an unknown checklist itemKey", async () => {
  const created = await request(app.getHttpServer())
    .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
    .send({ shipmentDescription: `${PFX}checklist2` }).expect(201);
  await request(app.getHttpServer())
    .patch(`/api/queries/${created.body.id}/checklist`).set("Cookie", cookie(Role.EXECUTIVE))
    .send({ items: [{ itemKey: "not-a-real-item", checked: true }] })
    .expect(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/api test -- queries`
Expected: FAIL — no checklist route.

- [ ] **Step 3: Add `patchChecklist` to `queries.service.ts`**

Add the import:
```ts
import type { ChecklistPatchInput } from "@svyft/shared";
```
```ts
  async patchChecklist(id: string, input: ChecklistPatchInput) {
    const existing = await this.prisma.queryChecklistItem.findMany({ where: { queryId: id }, select: { itemKey: true } });
    if (existing.length === 0) throw new NotFoundException("Query not found");
    const known = new Set(existing.map((e) => e.itemKey));
    for (const item of input.items) {
      if (!known.has(item.itemKey)) throw new BadRequestException(`Unknown checklist item '${item.itemKey}'`);
    }
    await this.prisma.$transaction(
      input.items.map((item) =>
        this.prisma.queryChecklistItem.updateMany({
          where: { queryId: id, itemKey: item.itemKey },
          data: { checked: item.checked },
        }),
      ),
    );
    return this.get(id);
  }
```

- [ ] **Step 4: Add the route to `queries.controller.ts`**

```ts
import { checklistPatchSchema, type ChecklistPatchInput } from "@svyft/shared";
// …
  @Patch(":id/checklist")
  patchChecklist(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(checklistPatchSchema)) body: ChecklistPatchInput,
  ) {
    return this.queries.patchChecklist(id, body);
  }
```
> Nest distinguishes `PATCH queries/:id/checklist` from `PATCH queries/:id` by path depth — no ordering hazard.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @svyft/api test -- queries`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/queries apps/api/test/queries.e2e-spec.ts
git commit -m "feat(queries): checklist PATCH toggling QueryChecklistItem state"
```

---

### Task 11: Docs, env, and whole-branch verification

**Files:**
- Modify: `apps/api/.env.example` (`UPLOADS_DIR`), `README.md` (uploads note), `docker-compose.prod.yml` + `docker-compose.caddy.yml` (mount an uploads volume + set `UPLOADS_DIR`)
- Verify: full CI green against a fresh unseeded DB

- [ ] **Step 1: Document `UPLOADS_DIR`**

Add to `apps/api/.env.example` (near `PORT`):
```
# Local MSDS uploads (dev). Prod mounts a named volume here (see docker-compose.prod.yml).
UPLOADS_DIR="./uploads"
```
Add a one-line note to `README.md` where env vars / local dev are described: MSDS PDFs are written under `UPLOADS_DIR` (defaults to `./uploads`, gitignored).

- [ ] **Step 2: Persist uploads in prod compose**

In `docker-compose.prod.yml` (and `docker-compose.caddy.yml`) add a named volume for the api service so MSDS files survive redeploys, and set `UPLOADS_DIR=/uploads`:
```yaml
    environment:
      # …existing…
      UPLOADS_DIR: /uploads
    volumes:
      - uploads:/uploads
# …at the file's top-level:
volumes:
  uploads:
```
> Match the existing indentation/service key in each file. Technical Design §11.2/§11.8 call for a named uploads volume.

- [ ] **Step 3: Confirm every new module is registered**

`apps/api/src/app.module.ts` `imports` must include `FilesModule`, `QueriesModule`, `CargoModule` (added in Tasks 3/4/7). Verify by reading the file.

- [ ] **Step 4: Fresh-DB verification (the CI-parity gate)**

Run from repo root:
```bash
pnpm --filter @svyft/api exec prisma migrate reset --schema ../../prisma/schema.prisma --force --skip-seed
pnpm --filter @svyft/shared build
pnpm run ci
```
Expected: `lint`, `typecheck`, `test`, `build` all pass against the **unseeded** migrated DB. (Every Plan-4 test seeds its own `ChecklistDefinition`/`QuerySequence`/client rows, so no seed step is needed.)

- [ ] **Step 5: Update the SDD ledger + push**

Update `.superpowers/sdd/progress.md`, then:
```bash
git add apps/api/.env.example README.md docker-compose.prod.yml docker-compose.caddy.yml
git commit -m "chore(plan-4): document UPLOADS_DIR + persist MSDS volume in prod compose"
git push -u origin feat/plan-4-query-cargo
gh run watch
```
Expected: CI green. Then open the PR (plan doc + implementation together).

---

## Self-review

**1. Spec coverage** (functional §7.1–§7.3, §7.5, §9, §13; technical §4.2/§4.4/§4.5/§5.2/§8.4/§8.6):

| Spec item | Task |
|---|---|
| Query root: queryCode `YALYY-NNNN` minted on first persist, row-locked `QuerySequence`, yearly reset (§4.4) | 2 (model + mint), 4 (service) |
| priority (default MEDIUM), responseDeadline (+remarks), queryDate (Admin backdate) | 1 (schema), 2 (default), 4/5 (service + guard) |
| client-contact + vessel **snapshots** (master edits never rewrite history, §7.1) | 2 (columns), 4 (client-supplied snapshot; API never writes master) |
| incoterms, shipmentDescription, **dgIndicator synced** (auto-true, manual override) | 1, 2, 4 (`syncDgIndicator`), 7 (re-sync on cargo change) |
| readyDate/targetDelivery, internalNotes, assignedUserId, system-only status | 2, 4 |
| Cargo atomic rows; referenceTags; hsCode; packageType; isDangerous + MSDS; qty/dims/weights | 1 (schema), 2 (model), 7 (CRUD), 8 (MSDS) |
| **volumeCbm generated column**; freightDensity/chargeableWeight null/read-only | 2 (generated column, verified), 1/9 (never written; exported blank) |
| Completeness checklist over the 9 seeded `ChecklistDefinition` | 2 (model), 4 (seed on create), 10 (PATCH) |
| FileAsset behind a storage service (local disk dev) | 3 |
| Persist `Query.status` via `QueryStatusProjector` (Draft→Created→RFQ Ready milestones) | 1 (milestone projection), 6 (projector persists + create flow) |
| Every Query/Cargo field edit via `ChangeMediator.apply` (Free path) | 5 (query PATCH), 7 (cargo CRUD), 8 (msds link) |
| Declare Query/Cargo impact classes via `ImpactRegistry.declare` | 4 (`query`), 7 (`cargo`) |
| Endpoints §5.2 (POST/GET/PATCH /queries, /create, cargo CRUD + export + msds, /checklist) | 4/5/6/7/8/9/10 |
| Excel export xlsx worksheet `Product` (§8.6) | 9 |
| Create Query field/cargo validation → status (route R1–R9 + rollup = Plan 5) | 6 |

**2. Placeholder scan:** No `TBD`/`add validation`/`similar to`—every code step carries real code, exact schemas, exact SQL, and exact test assertions. The single hardest unknown (the generated column) is a **verified recipe** (drift diff = empty; math = 9.6; write rejected), not a guess.

**3. Type consistency:** `syncDgIndicator(queryId, tx)` (Task 4) is consumed identically in Task 7. `representativeField` uses `ImpactRegistry.classOf` + `IMPACT_RANK` (both exist in the tree). `MsdsUpload` (Task 3) is the exact param type used in Tasks 7/8 controller/service. `QueryStatusProjector.recompute(queryId, client?)` (Task 6) matches the call in `createQuery` and the existing `status-machine.e2e-spec` single-arg spy. `EntityImpactMap` import path (`../changes/impact.registry`) matches Task 4/7 impact files. Enum values (`Priority`/`Incoterms`/`ReferenceTag`/`FileKind`) match Prisma enums (Task 1 ↔ Task 2). `querySaveSchema` field set ⊇ `queryImpactMap` keys (every editable field has a declared class — verified: schema fields = impact-map keys, minus `queryDate` which IS in the map).

**Scope-boundary check:** no Points/Legs/LegCargo, no `validateRoute`, no route rules R1–R9, no leg rollup, no cargo→leg fan-out, no `GET /queries` list, no web — all confirmed deferred to Plan 5/6.
