# Master Data Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Client, Freight Forwarder and Vessel masters, add a Warehouse master and an admin-managed Charge Line Catalogue, and put actor audit columns on every master table — without editing a single Stage-4 or Stage-5 file.

**Architecture:** Expand/migrate/contract. This plan is Phase 1 (expand) only: new columns and tables are added beside the ones the quote layer reads, and the old ones are kept populated by a pure derivation shared between the seed and the services. `resolveChargeConfig`, `rfq.service.ts` and the FF portal are untouched, so distribute keeps producing byte-identical snapshots.

**Tech Stack:** TypeScript, Prisma 5.22 + PostgreSQL, NestJS (api), React + react-hook-form + zod + TanStack Query (web), vitest (shared/web), jest + supertest (api e2e).

**Spec:** `docs/superpowers/specs/2026-08-25-master-data-expansion-design.md`

## Global Constraints

- **No file under `apps/api/src/modules/{rfq,ff-portal,quotes,legs,changes,status}`, `apps/web/src/features/{ff-portal,rfq-workspace,query-wizard}`, or `packages/shared/src/{charge-config,quote,quote-engine,quote-seed,ff-portal,rfq}.ts` may be modified.** If a task appears to require it, stop and report — that work belongs to the later Stage-4 pass.
- **Existing test files may not be edited.** New test files only. An existing test that fails means a regression, not an out-of-date test.
- `packages/shared` is consumed as a **built** package. After any edit under `packages/shared/src`, run `pnpm --filter @svyft/shared build` before typechecking or testing api/web.
- **vitest does not type-check.** Run `pnpm -r run typecheck` at the end of every task.
- **`prisma migrate dev` does not work in this repo** — it hard-errors non-interactively even with `--create-only`. Migrations are hand-written; see the recipe in Task 2, Step 3.
- Always pass `--schema prisma/schema.prisma`; the schema lives at the repo root, not under `apps/api`.
- Local database: `postgresql://svyft:svyft@localhost:5433/svyft_masters`, already migrated and seeded. `apps/api/.env` sets it.
- All master write endpoints are gated `@Roles(Role.ADMINISTRATOR, Role.MANAGER)`. Read endpoints are auth-only.
- Existing charge-line `key` values are immutable. Only new lines use the new key pattern.
- Branch: `worktree-feat+masters`. Verify with `git branch --show-current` before every commit — HEAD has drifted to main in past sessions.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/shared/src/masters/contacts.ts` | `PocLevel`, the nine-field contact schema and DTO shared by all three contact tables |
| `packages/shared/src/masters/client.ts` | Client create/update schemas and DTO |
| `packages/shared/src/masters/freight-forwarder.ts` | FF schemas, DTO, `PaymentTerm` |
| `packages/shared/src/masters/vessel.ts` | Vessel schemas and DTO |
| `packages/shared/src/masters/warehouse.ts` | Warehouse schemas, DTO, five new enums, conditional-by-type validation |
| `packages/shared/src/masters/charge-catalogue.ts` | `ChargeCategory`, `ChargeVariant`, `deriveZone`, `deriveRole`, catalogue schemas |
| `packages/shared/src/masters/index.ts` | Re-exports, so `@svyft/shared` import sites do not change |
| `apps/api/src/common/audit.ts` | `auditCreate(user)` / `auditUpdate(user)` — the only place actor columns are written |
| `apps/api/src/modules/warehouses/*` | Warehouse module, mirroring `modules/clients` |
| `apps/web/src/features/masters/warehouses/*` | Warehouse list and form pages |
| `apps/web/src/features/masters/charge-catalogue/*` | Catalogue list and form pages |
| `apps/web/src/features/masters/ContactList.tsx` | One contact editor, used by Client, FF and Warehouse forms |

**Modified:** `prisma/schema.prisma`; `apps/api/src/modules/{clients,vessels,freight-forwarders,config}/*`; `apps/api/src/seed/reference-seed.ts`; `apps/web/src/features/masters/{clients,vessels,freight-forwarders}/*`; `apps/web/src/App.tsx`.

**Deleted:** `packages/shared/src/masters.ts` (contents move into `masters/`).

---

### Task 1: Shared contact primitives, and split `masters.ts`

`packages/shared/src/masters.ts` is 134 lines and this work roughly triples it. Split it first, so every later task edits a focused file. The three contact tables share nine fields — define them once here.

**Files:**
- Create: `packages/shared/src/masters/contacts.ts`, `client.ts`, `freight-forwarder.ts`, `vessel.ts`, `index.ts`
- Create: `packages/shared/src/masters/contacts.test.ts`
- Delete: `packages/shared/src/masters.ts`
- Modify: `packages/shared/src/index.ts:5`

**Interfaces:**
- Produces: `PocLevel` (`"PRIMARY" | "SECONDARY" | "NONE"`), `POC_LEVELS`, `contactCoreSchema`, `contactCreateSchema`, `contactUpdateSchema`, `ContactCreateInput`, `ContactUpdateInput`, `ContactDto`. Every existing export of `masters.ts` keeps its name and type.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/masters/contacts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contactCreateSchema, POC_LEVELS } from "./contacts";

const valid = {
  name: "Asha Menon",
  email: "asha@example.com",
  contactNo: "+971501234567",
};

describe("contactCreateSchema", () => {
  it("accepts a minimal contact and defaults the channel flags to false", () => {
    const parsed = contactCreateSchema.parse(valid);
    expect(parsed.whatsappAvailable).toBe(false);
    expect(parsed.wechatAvailable).toBe(false);
    expect(parsed.botimAvailable).toBe(false);
  });

  it("defaults pocLevel to NONE and status to ACTIVE", () => {
    const parsed = contactCreateSchema.parse(valid);
    expect(parsed.pocLevel).toBe("NONE");
    expect(parsed.status).toBe("ACTIVE");
  });

  it("requires email and phone", () => {
    expect(contactCreateSchema.safeParse({ name: "No contact details" }).success).toBe(false);
  });

  it("rejects a phone number that is not E.164", () => {
    expect(contactCreateSchema.safeParse({ ...valid, contactNo: "0501234567" }).success).toBe(false);
  });

  it("exposes exactly three POC levels", () => {
    expect(POC_LEVELS).toEqual(["PRIMARY", "SECONDARY", "NONE"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/shared test contacts`
Expected: FAIL — `Failed to resolve import "./contacts"`.

- [ ] **Step 3: Create the contacts module**

Create `packages/shared/src/masters/contacts.ts`:

```ts
import { z } from "zod";

export const PocLevel = { PRIMARY: "PRIMARY", SECONDARY: "SECONDARY", NONE: "NONE" } as const;
export type PocLevel = (typeof PocLevel)[keyof typeof PocLevel];
export const POC_LEVELS: PocLevel[] = [PocLevel.PRIMARY, PocLevel.SECONDARY, PocLevel.NONE];

export const MasterStatus = { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" } as const;
export type MasterStatus = (typeof MasterStatus)[keyof typeof MasterStatus];
export const MASTER_STATUSES: MasterStatus[] = [MasterStatus.ACTIVE, MasterStatus.INACTIVE];

export const E164 = /^\+[1-9]\d{6,14}$/;

/** The nine fields every contact table carries — Client, Freight Forwarder and Warehouse. */
export const contactCoreSchema = z.object({
  name: z.string().min(1).max(160),
  designation: z.string().max(120).optional(),
  email: z.string().email(),
  contactNo: z.string().regex(E164, "Phone must be E.164, e.g. +971501234567"),
  whatsappAvailable: z.boolean().default(false),
  wechatAvailable: z.boolean().default(false),
  botimAvailable: z.boolean().default(false),
  pocLevel: z.enum(POC_LEVELS as [PocLevel, ...PocLevel[]]).default(PocLevel.NONE),
  status: z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).default(MasterStatus.ACTIVE),
});

export const contactCreateSchema = contactCoreSchema;
export const contactUpdateSchema = contactCoreSchema.partial();
export type ContactCreateInput = z.input<typeof contactCreateSchema>;
export type ContactUpdateInput = z.input<typeof contactUpdateSchema>;

export interface ContactDto {
  id: string;
  name: string;
  designation: string | null;
  email: string;
  contactNo: string;
  whatsappAvailable: boolean;
  wechatAvailable: boolean;
  botimAvailable: boolean;
  pocLevel: PocLevel;
  status: MasterStatus;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @svyft/shared test contacts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Move the remaining three masters into the directory**

Create `packages/shared/src/masters/client.ts`, `vessel.ts` and `freight-forwarder.ts` by moving the corresponding blocks out of `packages/shared/src/masters.ts` verbatim — `clientCreateSchema` / `clientUpdateSchema` / `ClientDto` into `client.ts`, the vessel block into `vessel.ts`, the freight-forwarder block into `freight-forwarder.ts`. Each imports what it needs from `./contacts` rather than redeclaring it:

```ts
// at the top of client.ts, vessel.ts and freight-forwarder.ts
import { z } from "zod";
import { MASTER_STATUSES, type MasterStatus } from "./contacts";

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();
```

Delete the now-duplicated `MasterStatus`, `MASTER_STATUSES`, `ContactDto`, `Paginated`, `contactCreateSchema` and `contactUpdateSchema` declarations from those three files — they live in `contacts.ts` now. Keep `VesselType` in `vessel.ts` (Task 3 removes it).

Create `packages/shared/src/masters/index.ts`:

```ts
export * from "./contacts";
export * from "./client";
export * from "./vessel";
export * from "./freight-forwarder";
```

Delete `packages/shared/src/masters.ts` and change `packages/shared/src/index.ts:5` from `export * from "./masters";` to `export * from "./masters/index";`.

- [ ] **Step 6: Verify nothing downstream moved**

Run: `pnpm --filter @svyft/shared build && pnpm -r run typecheck`
Expected: PASS. Every import site resolves unchanged, because the barrel re-exports the same names.

Run: `pnpm --filter @svyft/shared test`
Expected: PASS, including the pre-existing `masters.test.ts`. If that file cannot resolve its import, change only its import path — its assertions must not change.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must print worktree-feat+masters
git add packages/shared/src
git commit -m "refactor(shared): split masters.ts and add shared contact primitives"
```

---

### Task 2: Audit columns

Actor columns on the master tables, written in exactly one place so no service can forget them.

**Files:**
- Create: `apps/api/src/common/audit.ts`
- Create: `prisma/migrations/20260826090000_master_audit_columns/migration.sql`
- Modify: `prisma/schema.prisma` — `Client`, `ClientContact`, `Vessel`, `FreightForwarder`, `ChargeLineDefinition`
- Modify: `apps/api/src/modules/{clients,vessels,freight-forwarders}/*.{controller,service}.ts`
- Create: `apps/api/test/master-audit.e2e-spec.ts`

**Interfaces:**
- Consumes: `CurrentUser` from `../auth/decorators/current-user.decorator`, which yields `RequestUser` with a `sub` field holding the user id.
- Produces: `auditCreate(user)` → `{ createdById, updatedById }`; `auditUpdate(user)` → `{ updatedById }`. Both accept `RequestUser | undefined` and return `null` ids when absent.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/master-audit.e2e-spec.ts`. Copy the `beforeAll` / `afterAll` scaffolding from `apps/api/test/vessels.e2e-spec.ts:1-45` verbatim, substituting the constants below, then add:

```ts
const NAME = "Audit Columns E2E";

it("records the acting user on create and on update", async () => {
  const created = await request(app.getHttpServer())
    .post("/api/clients")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ companyName: NAME, country: "United Arab Emirates" })
    .expect(201);

  const afterCreate = await prisma.client.findUnique({ where: { id: created.body.id } });
  expect(afterCreate?.createdById).toBe("u-ADMINISTRATOR");
  expect(afterCreate?.updatedById).toBe("u-ADMINISTRATOR");

  await request(app.getHttpServer())
    .patch(`/api/clients/${created.body.id}`)
    .set("Cookie", cookie(Role.MANAGER))
    .send({ industry: "Chemicals" })
    .expect(200);

  const afterUpdate = await prisma.client.findUnique({ where: { id: created.body.id } });
  expect(afterUpdate?.createdById).toBe("u-ADMINISTRATOR");   // unchanged by the update
  expect(afterUpdate?.updatedById).toBe("u-MANAGER");
});
```

The cookie helper signs `{ sub: \`u-${role}\` }`, which is why the expected ids read `u-ADMINISTRATOR`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test master-audit`
Expected: FAIL — `Property 'createdById' does not exist`, because the column is not in the schema yet.

- [ ] **Step 3: Add the columns to the schema and hand-write the migration**

Add to `Client`, `ClientContact`, `Vessel`, `FreightForwarder` and `ChargeLineDefinition` in `prisma/schema.prisma`:

```prisma
  createdById String?  @db.Uuid
  updatedById String?  @db.Uuid
```

`prisma migrate dev` does not work here. Create `prisma/migrations/20260826090000_master_audit_columns/migration.sql` by hand:

```sql
ALTER TABLE "Client"               ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
ALTER TABLE "ClientContact"        ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
ALTER TABLE "Vessel"               ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
ALTER TABLE "FreightForwarder"     ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
ALTER TABLE "ChargeLineDefinition" ADD COLUMN "createdById" UUID, ADD COLUMN "updatedById" UUID;
```

No foreign key to `User`: the columns must accept ids from seeds and from users that may later be deleted, and a dangling actor id is better than a blocked delete.

Apply and regenerate:

```bash
pnpm exec prisma migrate deploy --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma
```

If `migrate deploy` reports drift rather than applying, derive the SQL instead with `prisma migrate diff --shadow-database-url <scratch-db>` and strip every `ALTER COLUMN "id" DROP DEFAULT` from the output — five earlier migrations wrote `DEFAULT gen_random_uuid()` in raw SQL while the schema uses `@default(uuid())`, so every derived diff carries about ten of those spurious statements.

- [ ] **Step 4: Write the audit helper**

Create `apps/api/src/common/audit.ts`:

```ts
import type { RequestUser } from "../modules/types";

/**
 * The only place actor columns are written. Services call these rather than setting
 * createdById/updatedById inline, so a missed write is a compile error at the call site
 * rather than a silently unaudited row.
 */
export function auditCreate(user?: RequestUser) {
  const id = user?.sub ?? null;
  return { createdById: id, updatedById: id };
}

export function auditUpdate(user?: RequestUser) {
  return { updatedById: user?.sub ?? null };
}
```

- [ ] **Step 5: Thread the actor through the three existing masters**

In each of `clients`, `vessels` and `freight-forwarders`, add the parameter to the controller's write handlers:

```ts
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { RequestUser } from "../types";

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(
    @Body(new ZodValidationPipe(clientCreateSchema)) body: ClientCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.clients.create(body, user);
  }
```

and spread the helper into the Prisma call in the service:

```ts
  async create(input: ClientCreateInput, user?: RequestUser) {
    // ...
        return tx.client.create({ data: { clientCode, ...input, ...auditCreate(user) } });
  }

  async update(id: string, input: ClientUpdateInput, user?: RequestUser) {
    // ...
    return this.prisma.client.update({ where: { id }, data: { ...input, ...auditUpdate(user) } });
  }
```

Do the same for every write method on all three services, contacts included.

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm --filter @svyft/api test master-audit`
Expected: PASS.

Run: `pnpm --filter @svyft/api test`
Expected: PASS — all pre-existing suites, unedited.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add prisma apps/api/src apps/api/test
git commit -m "feat(masters): actor audit columns on the master tables"
```

---

### Task 3: Vessel master

Two fields become mandatory and one enum becomes free text. `vesselType` has no consumer outside the vessels module — verified — so the enum can go.

**Files:**
- Modify: `prisma/schema.prisma` — `Vessel`, remove `enum VesselType`
- Create: `prisma/migrations/20260826091000_vessel_required_fields/migration.sql`
- Modify: `packages/shared/src/masters/vessel.ts`
- Modify: `apps/web/src/features/masters/vessels/VesselFormPage.tsx`
- Create: `apps/api/test/vessels-required.e2e-spec.ts`

**Interfaces:**
- Produces: `vesselCreateSchema` with `imoNumber`, `shippingLine` and `vesselType` all required; `vesselType` is now `string`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/vessels-required.e2e-spec.ts` using the scaffolding from `vessels.e2e-spec.ts:1-45`, with `const NAME = "MV Required E2E"; const IMO = "9999201";`:

```ts
it("rejects a vessel with no IMO number", async () => {
  await request(app.getHttpServer())
    .post("/api/vessels")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ name: NAME, shippingLine: "Maersk", vesselType: "Container Vessel" })
    .expect(400);
});

it("rejects a vessel with no shipping line", async () => {
  await request(app.getHttpServer())
    .post("/api/vessels")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ name: NAME, imoNumber: IMO, vesselType: "Container Vessel" })
    .expect(400);
});

it("accepts any vessel type string, not just the old enum values", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/vessels")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ name: NAME, imoNumber: IMO, shippingLine: "Maersk", vesselType: "Heavy Lift Vessel" })
    .expect(201);
  expect(res.body.vesselType).toBe("Heavy Lift Vessel");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test vessels-required`
Expected: FAIL — the first two return 201 because both fields are optional, and the third returns 400 because `"Heavy Lift Vessel"` is not in the enum.

- [ ] **Step 3: Migrate the data, then the constraints**

In `prisma/schema.prisma`, change `Vessel`:

```prisma
  imoNumber    String   @unique
  shippingLine String
  vesselType   String
```

and delete `enum VesselType` entirely.

Create `prisma/migrations/20260826091000_vessel_required_fields/migration.sql`. Backfill first, constrain second — the order matters, because the `NOT NULL` fails on any row still holding a null:

```sql
-- 1. vesselType: enum → text, with the old values rendered as the labels users will now type.
ALTER TABLE "Vessel" ALTER COLUMN "vesselType" TYPE TEXT USING (
  CASE "vesselType"::TEXT
    WHEN 'CONTAINER'     THEN 'Container Vessel'
    WHEN 'BULK_CARRIER'  THEN 'Bulk Carrier'
    WHEN 'TANKER'        THEN 'Tanker'
    WHEN 'RORO'          THEN 'RoRo'
    WHEN 'GENERAL_CARGO' THEN 'General Cargo'
    WHEN 'REEFER'        THEN 'Reefer'
    ELSE 'Other'
  END
);
DROP TYPE "VesselType";

-- 2. shippingLine: a vessel with no carrier recorded is marked, not invented.
UPDATE "Vessel" SET "shippingLine" = 'Unknown' WHERE "shippingLine" IS NULL OR "shippingLine" = '';
ALTER TABLE "Vessel" ALTER COLUMN "shippingLine" SET NOT NULL;

-- 3. imoNumber: generated, unique, seven digits, in the 8000000 block so backfilled rows are
--    identifiable — real IMO numbers in use start 9xxxxxx. The migration prints every row it
--    touches so the affected vessels can be corrected from the UI (spec D8).
DO $$
DECLARE v RECORD; n INT := 8000000;
BEGIN
  FOR v IN SELECT "id", "name" FROM "Vessel" WHERE "imoNumber" IS NULL ORDER BY "createdAt" LOOP
    LOOP
      n := n + 1;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Vessel" WHERE "imoNumber" = n::TEXT);
    END LOOP;
    UPDATE "Vessel" SET "imoNumber" = n::TEXT WHERE "id" = v."id";
    RAISE NOTICE 'IMO backfilled: vessel % (%) -> %', v."name", v."id", n;
  END LOOP;
END $$;
ALTER TABLE "Vessel" ALTER COLUMN "imoNumber" SET NOT NULL;
```

Apply with `pnpm exec prisma migrate deploy --schema prisma/schema.prisma`, then `pnpm exec prisma generate --schema prisma/schema.prisma`. Capture the `NOTICE` lines from the output — they are the list of vessels needing a real IMO, and they are the deliverable of Step 6.

- [ ] **Step 4: Update the shared schema**

In `packages/shared/src/masters/vessel.ts`, replace the vessel schema and drop `VesselType`:

```ts
export const vesselCreateSchema = z.object({
  name: z.string().min(1).max(200),
  imoNumber: z.string().regex(/^\d{7}$/, "IMO must be 7 digits"),
  shippingLine: z.string().min(1).max(160),
  vesselType: z.string().min(1).max(120),
  status: statusField,
});
export const vesselUpdateSchema = vesselCreateSchema.partial();
export type VesselCreateInput = z.infer<typeof vesselCreateSchema>;
export type VesselUpdateInput = z.infer<typeof vesselUpdateSchema>;

export interface VesselDto {
  id: string;
  vesselCode: string;
  name: string;
  imoNumber: string;
  shippingLine: string;
  vesselType: string;
  status: MasterStatus;
}
```

Delete the `VesselType` const, type and `VESSEL_TYPES` array. Then `pnpm --filter @svyft/shared build`.

- [ ] **Step 5: Update the form**

In `VesselFormPage.tsx`, replace the vessel-type `<select>` with a text input, and drop the `VESSEL_TYPES` import:

```tsx
      <div className="space-y-1">
        <Label htmlFor="vesselType">Vessel type</Label>
        <Input id="vesselType" placeholder="Container Vessel" {...register("vesselType")} />
        {errors.vesselType && (
          <p role="alert" className="text-sm text-destructive">{errors.vesselType.message}</p>
        )}
      </div>
```

- [ ] **Step 6: Run the tests and record the backfill**

Run: `pnpm --filter @svyft/api test vessels && pnpm --filter @svyft/api test vessels-required`
Expected: PASS both. `vessels.e2e-spec.ts` must pass **unedited** — if it fails because it posts a vessel without a shipping line, that is a real regression in this task's schema, not a stale test.

Run: `pnpm --filter @svyft/web test VesselForm && pnpm -r run typecheck`
Expected: PASS.

Append the captured `NOTICE` lines to `docs/superpowers/plans/2026-08-25-master-data-expansion.md` under a new `## Backfill log` heading at the end, so the vessels needing a real IMO are recorded in the repo rather than in a terminal.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add prisma packages/shared/src apps/web/src apps/api/test docs
git commit -m "feat(masters): vessel IMO and shipping line required, type becomes free text"
```

---

### Task 4: Client master

Three address fields the model has never had, and the contact table gains its five new fields.

**Files:**
- Modify: `prisma/schema.prisma` — `Client`, `ClientContact`
- Create: `prisma/migrations/20260826092000_client_address_and_contacts/migration.sql`
- Modify: `packages/shared/src/masters/client.ts`
- Modify: `apps/web/src/features/masters/clients/ClientFormPage.tsx`
- Create: `apps/web/src/features/masters/ContactList.tsx`
- Create: `apps/api/test/clients-address.e2e-spec.ts`

**Interfaces:**
- Consumes: `contactCreateSchema`, `PocLevel` from Task 1.
- Produces: `ContactList` React component, props `{ ownerPath: string; ownerId?: string }`, used again by Tasks 5 and 8. `clientCreateSchema` gaining `streetAddress`, `city`, `postalCode`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/clients-address.e2e-spec.ts` on the same scaffolding, `const NAME = "Client Address E2E";`:

```ts
it("requires street address and city", async () => {
  await request(app.getHttpServer())
    .post("/api/clients")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ companyName: NAME, country: "India" })
    .expect(400);
});

it("stores the full address", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/clients")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({
      companyName: NAME,
      country: "India",
      streetAddress: "12 Marine Drive",
      city: "Mumbai",
      postalCode: "400020",
    })
    .expect(201);
  expect(res.body.city).toBe("Mumbai");
  expect(res.body.postalCode).toBe("400020");
});

it("allows only one primary contact per client", async () => {
  const client = await request(app.getHttpServer())
    .post("/api/clients")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ companyName: `${NAME} primary`, country: "India", streetAddress: "1 A Road", city: "Pune" })
    .expect(201);

  const contact = (name: string) => ({
    name, email: `${name.replace(/\W/g, "")}@example.com`, contactNo: "+919812345678", pocLevel: "PRIMARY",
  });

  await request(app.getHttpServer())
    .post(`/api/clients/${client.body.id}/contacts`)
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send(contact("First"))
    .expect(201);

  await request(app.getHttpServer())
    .post(`/api/clients/${client.body.id}/contacts`)
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send(contact("Second"))
    .expect(409);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test clients-address`
Expected: FAIL on all three — the fields do not exist and nothing enforces one primary.

- [ ] **Step 3: Schema and migration**

In `prisma/schema.prisma`, add to `Client`:

```prisma
  streetAddress String
  city          String
  postalCode    String?
```

and change `ClientContact`:

```prisma
  email             String
  contactNo         String
  whatsappAvailable Boolean  @default(false)
  wechatAvailable   Boolean  @default(false)
  botimAvailable    Boolean  @default(false)
  pocLevel          PocLevel @default(NONE)
  status            MasterStatus @default(ACTIVE)
```

removing `isPrimary`. Add the enum:

```prisma
enum PocLevel {
  PRIMARY
  SECONDARY
  NONE
}
```

Create `prisma/migrations/20260826092000_client_address_and_contacts/migration.sql`:

```sql
CREATE TYPE "PocLevel" AS ENUM ('PRIMARY', 'SECONDARY', 'NONE');

ALTER TABLE "Client" ADD COLUMN "streetAddress" TEXT, ADD COLUMN "city" TEXT, ADD COLUMN "postalCode" TEXT;
UPDATE "Client" SET "streetAddress" = 'Not recorded' WHERE "streetAddress" IS NULL;
UPDATE "Client" SET "city" = 'Not recorded' WHERE "city" IS NULL;
ALTER TABLE "Client" ALTER COLUMN "streetAddress" SET NOT NULL, ALTER COLUMN "city" SET NOT NULL;

ALTER TABLE "ClientContact"
  ADD COLUMN "whatsappAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "wechatAvailable"   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "botimAvailable"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "pocLevel" "PocLevel" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE';

-- Carry the old boolean across before dropping it.
UPDATE "ClientContact" SET "pocLevel" = 'PRIMARY' WHERE "isPrimary" = TRUE;
ALTER TABLE "ClientContact" DROP COLUMN "isPrimary";

UPDATE "ClientContact" SET "email" = 'not.recorded@example.invalid' WHERE "email" IS NULL;
UPDATE "ClientContact" SET "contactNo" = '+10000000000' WHERE "contactNo" IS NULL;
ALTER TABLE "ClientContact" ALTER COLUMN "email" SET NOT NULL, ALTER COLUMN "contactNo" SET NOT NULL;

-- One primary per client. Prisma cannot express a partial unique index, so it is raw SQL.
CREATE UNIQUE INDEX "ClientContact_one_primary" ON "ClientContact" ("clientId") WHERE "pocLevel" = 'PRIMARY';
```

If more than one existing contact per client carries `isPrimary = true`, that index creation fails. Resolve by demoting all but the earliest: add `UPDATE "ClientContact" c SET "pocLevel" = 'SECONDARY' WHERE "pocLevel" = 'PRIMARY' AND "createdAt" > (SELECT MIN("createdAt") FROM "ClientContact" WHERE "clientId" = c."clientId" AND "pocLevel" = 'PRIMARY');` immediately before the `CREATE UNIQUE INDEX`.

Apply and regenerate as in Task 2.

- [ ] **Step 4: Shared schema**

In `packages/shared/src/masters/client.ts`:

```ts
export const clientCreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  industry: z.string().max(120).optional(),
  country: z.string().min(1).max(120),
  streetAddress: z.string().min(1).max(300),
  city: z.string().min(1).max(120),
  postalCode: z.string().max(20).optional(),
  status: statusField,
});
```

and extend `ClientDto` with `streetAddress: string; city: string; postalCode: string | null;`. Then `pnpm --filter @svyft/shared build`.

- [ ] **Step 5: Map the unique-index violation to 409**

`ClientsService.mapUnique` already converts Prisma's `P2002` into a `ConflictException`. Extend its message selection so the primary-contact index reads clearly:

```ts
  private mapUnique(e: unknown, fallback: string) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = String((e.meta as { target?: string })?.target ?? "");
      if (target.includes("one_primary")) {
        return new ConflictException("This client already has a primary contact");
      }
      return new ConflictException(fallback);
    }
    return e as Error;
  }
```

- [ ] **Step 6: Build the shared contact editor**

Create `apps/web/src/features/masters/ContactList.tsx`. It is used by Client, Freight Forwarder and Warehouse, so it takes the owner's API path rather than knowing which master it belongs to:

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { contactCreateSchema, POC_LEVELS, type ContactCreateInput, type ContactDto } from "@svyft/shared";
import { fetchJson, postJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ContactList({ ownerPath, ownerId }: { ownerPath: string; ownerId?: string }) {
  const qc = useQueryClient();
  const key = [ownerPath, ownerId, "contacts"];
  const contacts = useQuery({
    queryKey: key,
    queryFn: () => fetchJson<ContactDto[]>(`/api/${ownerPath}/${ownerId}/contacts`),
    enabled: Boolean(ownerId),
  });
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<ContactCreateInput>({ resolver: zodResolver(contactCreateSchema) });

  async function onAdd(values: ContactCreateInput) {
    await postJson(`/api/${ownerPath}/${ownerId}/contacts`, values);
    reset();
    await qc.invalidateQueries({ queryKey: key });
  }

  if (!ownerId) {
    return <p className="text-sm text-muted-foreground">Save this record before adding contacts.</p>;
  }

  return (
    <section aria-label="Contacts" className="space-y-4">
      <h2 className="font-display text-lg font-semibold tracking-tight">Contacts</h2>
      <ul className="space-y-1">
        {contacts.data?.map((c) => (
          <li key={c.id} className="text-sm">
            {c.name} — {c.email} — {c.contactNo}
            {c.pocLevel !== "NONE" && <span className="ml-2 text-muted-foreground">{c.pocLevel}</span>}
          </li>
        ))}
      </ul>
      <form onSubmit={handleSubmit(onAdd)} className="space-y-3" aria-label="Add contact">
        <div className="space-y-1">
          <Label htmlFor="contact-name">Name</Label>
          <Input id="contact-name" {...register("name")} />
          {errors.name && <p role="alert" className="text-sm text-destructive">{errors.name.message}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="contact-email">Email</Label>
          <Input id="contact-email" {...register("email")} />
          {errors.email && <p role="alert" className="text-sm text-destructive">{errors.email.message}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="contact-phone">Phone</Label>
          <Input id="contact-phone" placeholder="+971501234567" {...register("contactNo")} />
          {errors.contactNo && <p role="alert" className="text-sm text-destructive">{errors.contactNo.message}</p>}
        </div>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("whatsappAvailable")} /> WhatsApp
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("wechatAvailable")} /> WeChat
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("botimAvailable")} /> Botim
          </label>
        </div>
        <div className="space-y-1">
          <Label htmlFor="contact-level">POC level</Label>
          <select id="contact-level" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" {...register("pocLevel")}>
            {POC_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <Button type="submit" disabled={isSubmitting}>Add contact</Button>
      </form>
    </section>
  );
}
```

In `ClientFormPage.tsx`, add inputs for `streetAddress`, `city` and `postalCode` following the existing `companyName` block exactly, and render `<ContactList ownerPath="clients" ownerId={id} />` below the form.

- [ ] **Step 7: Run the tests and watch them pass**

Run: `pnpm --filter @svyft/api test clients && pnpm --filter @svyft/web test masters && pnpm -r run typecheck`
Expected: PASS, including the unedited `clients.e2e-spec.ts` and `ClientFormPage.test.tsx`.

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add prisma packages/shared/src apps/api apps/web/src
git commit -m "feat(masters): client address fields and contact channels"
```

---

### Task 5: Freight Forwarder master

The one task with a genuine dual-write. `rfq.service.ts` snapshots `pic`, `contactNumber`, `email` and `whLocation`, so those columns stay and are rewritten whenever the primary contact changes.

**Files:**
- Modify: `prisma/schema.prisma` — `FreightForwarder`, new `FreightForwarderContact`, new `PaymentTerm`
- Create: `prisma/migrations/20260826093000_ff_contacts_and_terms/migration.sql`
- Modify: `packages/shared/src/masters/freight-forwarder.ts`
- Modify: `apps/api/src/modules/freight-forwarders/*`
- Modify: `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx`
- Create: `apps/api/test/ff-contacts.e2e-spec.ts`

**Interfaces:**
- Consumes: `contactCreateSchema`, `ContactList` from Tasks 1 and 4.
- Produces: `PAYMENT_TERMS` (ten values), `syncPrimaryContactColumns(tx, ffId)` on `FreightForwardersService`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/ff-contacts.e2e-spec.ts`, `const NAME = "FF Contacts E2E";`:

```ts
const base = {
  companyName: NAME,
  companyAddress: "Plot 5, Jebel Ali",
  country: "United Arab Emirates",
  city: "Dubai",
  availableCountries: ["AE"],
  modes: ["SEA"],
  pic: "Legacy Contact",
  contactNumber: "+971500000000",
  email: "legacy@example.com",
  paymentTerms: "NET_30",
};

it("rewrites the snapshot columns when the primary contact changes", async () => {
  const ff = await request(app.getHttpServer())
    .post("/api/freight-forwarders")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send(base)
    .expect(201);

  await request(app.getHttpServer())
    .post(`/api/freight-forwarders/${ff.body.id}/contacts`)
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({
      name: "Priya Nair",
      email: "priya@example.com",
      contactNo: "+971509876543",
      pocLevel: "PRIMARY",
    })
    .expect(201);

  const row = await prisma.freightForwarder.findUnique({ where: { id: ff.body.id } });
  expect(row?.pic).toBe("Priya Nair");
  expect(row?.email).toBe("priya@example.com");
  expect(row?.contactNumber).toBe("+971509876543");
});

it("rejects a payment term outside the ten allowed values", async () => {
  await request(app.getHttpServer())
    .post("/api/freight-forwarders")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ ...base, companyName: `${NAME} terms`, paymentTerms: "whenever" })
    .expect(400);
});

it("stores typical lead time as a number", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/freight-forwarders")
    .set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ ...base, companyName: `${NAME} lead`, typicalLeadTime: 14 })
    .expect(201);
  expect(res.body.typicalLeadTime).toBe(14);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test ff-contacts`
Expected: FAIL — no contacts endpoint, `paymentTerms` accepts any string, `typicalLeadTime` is text.

- [ ] **Step 3: Schema and migration**

In `prisma/schema.prisma`, add the enum and the contact model, and change `FreightForwarder`:

```prisma
enum PaymentTerm {
  CREDIT_7
  CREDIT_15
  CREDIT_30
  CREDIT_45
  CREDIT_60
  ADVANCE_100
  ADVANCE_50_BALANCE_50
  ADVANCE_30_BALANCE_70
  ADVANCE_70_BALANCE_30
  AFTER_DELIVERY_100
}

model FreightForwarderContact {
  id                 String   @id @default(uuid()) @db.Uuid
  tenantId           String?  @db.Uuid
  freightForwarderId String   @db.Uuid
  freightForwarder   FreightForwarder @relation(fields: [freightForwarderId], references: [id], onDelete: Cascade)
  name               String
  designation        String?
  email              String
  contactNo          String
  whatsappAvailable  Boolean  @default(false)
  wechatAvailable    Boolean  @default(false)
  botimAvailable     Boolean  @default(false)
  pocLevel           PocLevel @default(NONE)
  status             MasterStatus @default(ACTIVE)
  createdById        String?  @db.Uuid
  updatedById        String?  @db.Uuid
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@index([freightForwarderId])
}
```

On `FreightForwarder`: `companyAddress String`, `country String`, `city String`, `paymentTerms PaymentTerm?`, `typicalLeadTime Int?`, and add `contacts FreightForwarderContact[]`. **Keep `pic`, `contactNumber`, `email` and `whLocation` exactly as they are** — `rfq.service.ts:228` reads all four.

Create `prisma/migrations/20260826093000_ff_contacts_and_terms/migration.sql`:

```sql
CREATE TYPE "PaymentTerm" AS ENUM (
  'CREDIT_7','CREDIT_15','CREDIT_30','CREDIT_45','CREDIT_60',
  'ADVANCE_100','ADVANCE_50_BALANCE_50','ADVANCE_30_BALANCE_70',
  'ADVANCE_70_BALANCE_30','AFTER_DELIVERY_100'
);

CREATE TABLE "FreightForwarderContact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "freightForwarderId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "designation" TEXT,
  "email" TEXT NOT NULL,
  "contactNo" TEXT NOT NULL,
  "whatsappAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "wechatAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "botimAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "pocLevel" "PocLevel" NOT NULL DEFAULT 'NONE',
  "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" UUID,
  "updatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FreightForwarderContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FreightForwarderContact_freightForwarderId_idx" ON "FreightForwarderContact" ("freightForwarderId");
ALTER TABLE "FreightForwarderContact" ADD CONSTRAINT "FreightForwarderContact_ff_fkey"
  FOREIGN KEY ("freightForwarderId") REFERENCES "FreightForwarder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "FreightForwarderContact_one_primary"
  ON "FreightForwarderContact" ("freightForwarderId") WHERE "pocLevel" = 'PRIMARY';

-- Every existing forwarder's embedded contact becomes its primary contact row.
INSERT INTO "FreightForwarderContact" ("freightForwarderId", "name", "email", "contactNo", "pocLevel", "updatedAt")
SELECT "id", "pic", "email", "contactNumber", 'PRIMARY', CURRENT_TIMESTAMP FROM "FreightForwarder";

UPDATE "FreightForwarder" SET "companyAddress" = 'Not recorded' WHERE "companyAddress" IS NULL OR "companyAddress" = '';
UPDATE "FreightForwarder" SET "country" = 'Not recorded' WHERE "country" IS NULL OR "country" = '';
UPDATE "FreightForwarder" SET "city" = 'Not recorded' WHERE "city" IS NULL OR "city" = '';
ALTER TABLE "FreightForwarder"
  ALTER COLUMN "companyAddress" SET NOT NULL,
  ALTER COLUMN "country" SET NOT NULL,
  ALTER COLUMN "city" SET NOT NULL;

-- paymentTerms: free text → enum. Anything unrecognised becomes NULL rather than a wrong guess.
ALTER TABLE "FreightForwarder" ADD COLUMN "paymentTermsEnum" "PaymentTerm";
UPDATE "FreightForwarder" SET "paymentTermsEnum" = CASE
  WHEN "paymentTerms" ILIKE '%net 7%'  OR "paymentTerms" ILIKE '%7 day%'  THEN 'CREDIT_7'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%net 15%' OR "paymentTerms" ILIKE '%15 day%' THEN 'CREDIT_15'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%net 30%' OR "paymentTerms" ILIKE '%30 day%' THEN 'CREDIT_30'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%net 45%' OR "paymentTerms" ILIKE '%45 day%' THEN 'CREDIT_45'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%net 60%' OR "paymentTerms" ILIKE '%60 day%' THEN 'CREDIT_60'::"PaymentTerm"
  WHEN "paymentTerms" ILIKE '%advance%' THEN 'ADVANCE_100'::"PaymentTerm"
  ELSE NULL END;
ALTER TABLE "FreightForwarder" DROP COLUMN "paymentTerms";
ALTER TABLE "FreightForwarder" RENAME COLUMN "paymentTermsEnum" TO "paymentTerms";

-- typicalLeadTime: text → integer days, keeping only the leading digits.
ALTER TABLE "FreightForwarder" ADD COLUMN "typicalLeadTimeInt" INTEGER;
UPDATE "FreightForwarder"
   SET "typicalLeadTimeInt" = NULLIF(substring("typicalLeadTime" FROM '^\s*(\d+)'), '')::INTEGER
 WHERE "typicalLeadTime" IS NOT NULL;
ALTER TABLE "FreightForwarder" DROP COLUMN "typicalLeadTime";
ALTER TABLE "FreightForwarder" RENAME COLUMN "typicalLeadTimeInt" TO "typicalLeadTime";
```

Apply and regenerate.

- [ ] **Step 4: Shared schema**

In `packages/shared/src/masters/freight-forwarder.ts`, add the payment terms and retype the two changed fields. Keep `pic`, `contactNumber` and `email` in the schema and DTO — the RFQ payload still carries them:

```ts
export const PaymentTerm = {
  CREDIT_7: "CREDIT_7", CREDIT_15: "CREDIT_15", CREDIT_30: "CREDIT_30",
  CREDIT_45: "CREDIT_45", CREDIT_60: "CREDIT_60", ADVANCE_100: "ADVANCE_100",
  ADVANCE_50_BALANCE_50: "ADVANCE_50_BALANCE_50",
  ADVANCE_30_BALANCE_70: "ADVANCE_30_BALANCE_70",
  ADVANCE_70_BALANCE_30: "ADVANCE_70_BALANCE_30",
  AFTER_DELIVERY_100: "AFTER_DELIVERY_100",
} as const;
export type PaymentTerm = (typeof PaymentTerm)[keyof typeof PaymentTerm];
export const PAYMENT_TERMS = Object.values(PaymentTerm) as [PaymentTerm, ...PaymentTerm[]];

export const PAYMENT_TERM_LABELS: Record<PaymentTerm, string> = {
  CREDIT_7: "7 Days Credit", CREDIT_15: "15 Days Credit", CREDIT_30: "30 Days Credit",
  CREDIT_45: "45 Days Credit", CREDIT_60: "60 Days Credit", ADVANCE_100: "100% Advance",
  ADVANCE_50_BALANCE_50: "50% Advance : 50% After Delivery",
  ADVANCE_30_BALANCE_70: "30% Advance : 70% After Delivery",
  ADVANCE_70_BALANCE_30: "70% Advance : 30% After Delivery",
  AFTER_DELIVERY_100: "100% After Delivery",
};
```

In `freightForwarderCreateSchema`, change `companyAddress`, `country` and `city` to required (`z.string().min(1).max(...)`), replace `paymentTerms` with `z.enum(PAYMENT_TERMS).optional()`, and `typicalLeadTime` with `z.number().int().min(0).max(365).optional()`. Update `FreightForwarderDto` to match. Then `pnpm --filter @svyft/shared build`.

- [ ] **Step 5: Contacts endpoints and the column sync**

Add contact routes to `freight-forwarders.controller.ts` mirroring `clients.controller.ts:58-90` exactly, with `freight-forwarders` in the path. In the service, add the sync and call it from every contact write:

```ts
  /**
   * Keeps the four columns rfq.service.ts snapshots (pic, contactNumber, email, whLocation)
   * aligned with the primary contact. Phase 1 of the parallel change — the RFQ payload keeps
   * reading columns while the contact table becomes the source of truth. Retired in the
   * Stage-4 pass; see the design doc §2.2.
   */
  private async syncPrimaryContactColumns(tx: Prisma.TransactionClient, ffId: string) {
    const primary = await tx.freightForwarderContact.findFirst({
      where: { freightForwarderId: ffId, pocLevel: "PRIMARY" },
    });
    if (!primary) return;
    await tx.freightForwarder.update({
      where: { id: ffId },
      data: { pic: primary.name, contactNumber: primary.contactNo, email: primary.email },
    });
  }

  async createContact(ffId: string, input: ContactCreateInput, user?: RequestUser) {
    return this.prisma.$transaction(async (tx) => {
      const contact = await tx.freightForwarderContact.create({
        data: { freightForwarderId: ffId, ...input, ...auditCreate(user) },
      });
      await this.syncPrimaryContactColumns(tx, ffId);
      return contact;
    });
  }
```

Write `updateContact` and `deleteContact` the same way — mutate, then `syncPrimaryContactColumns` inside the same transaction. Map the `one_primary` index violation to a 409 as in Task 4, Step 5.

- [ ] **Step 6: Form**

In `FreightForwarderFormPage.tsx`, replace the payment-terms text input with a select over `PAYMENT_TERMS` rendering `PAYMENT_TERM_LABELS`, change lead time to `<Input type="number" {...register("typicalLeadTime", { valueAsNumber: true })} />`, and render `<ContactList ownerPath="freight-forwarders" ownerId={id} />`.

- [ ] **Step 7: Run everything**

Run: `pnpm --filter @svyft/api test ff-contacts && pnpm --filter @svyft/api test && pnpm -r run typecheck`
Expected: PASS. `rfq.e2e-spec.ts` in particular must pass unedited — it exercises the payload whose four columns this task preserves.

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add prisma packages/shared/src apps/api apps/web/src
git commit -m "feat(masters): FF contact table with snapshot-column sync, enum payment terms"
```

---

### Task 6: Warehouse master — schema and migration

**Files:**
- Modify: `prisma/schema.prisma` — `Warehouse`, `WarehouseContact`, `WarehouseVehicle`, five enums
- Create: `prisma/migrations/20260826094000_warehouse_master/migration.sql`
- Create: `packages/shared/src/masters/warehouse.ts`, `warehouse.test.ts`
- Modify: `packages/shared/src/masters/index.ts`

**Interfaces:**
- Produces: `warehouseCreateSchema` (with `superRefine` for the type-conditional fields), `WarehouseDto`, `WAREHOUSE_TYPES`, `CAPACITY_UNITS`, `HANDLING_UNITS`, `STORAGE_UNITS`, `WAREHOUSE_CAPABILITIES`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/masters/warehouse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { warehouseCreateSchema } from "./warehouse";

const base = {
  name: "Jebel Ali DC1",
  type: "CLIENT" as const,
  streetAddress: "Plot 12",
  country: "United Arab Emirates",
  city: "Dubai",
  pinCode: "00000",
  capacity: 5000,
  capacityUnit: "CBM" as const,
};

describe("warehouseCreateSchema", () => {
  it("accepts a client warehouse with no contract or rate fields", () => {
    expect(warehouseCreateSchema.safeParse(base).success).toBe(true);
  });

  it("requires agreement and insurance dates on an owned warehouse", () => {
    const result = warehouseCreateSchema.safeParse({ ...base, type: "OWNED" });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path[0]);
    expect(paths).toContain("agreementValidUntil");
    expect(paths).toContain("insuranceValidUntil");
  });

  it("requires a currency once a handling rate is given", () => {
    const result = warehouseCreateSchema.safeParse({ ...base, handlingRate: 25, handlingUnit: "PER_PALLET" });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path[0]);
    expect(paths).toContain("rateCurrency");
  });

  it("defaults free storage days to 0", () => {
    expect(warehouseCreateSchema.parse(base).freeStorageDays).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/shared test warehouse`
Expected: FAIL — `Failed to resolve import "./warehouse"`.

- [ ] **Step 3: Write the shared schema**

Create `packages/shared/src/masters/warehouse.ts`:

```ts
import { z } from "zod";
import { CURRENCY_CODES } from "../reference";
import { MASTER_STATUSES, type MasterStatus, type ContactDto } from "./contacts";

export const WAREHOUSE_TYPES = ["OWNED", "CONTRACTED", "CLIENT", "FF"] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

/** Contract and rate fields apply only to warehouses the organisation owns or contracts. */
export const CONTRACTED_TYPES: readonly WarehouseType[] = ["OWNED", "CONTRACTED"];

export const CAPACITY_UNITS = ["CBM", "PALLETS", "SQ_FT", "MT"] as const;
export const HANDLING_UNITS = ["PER_PALLET", "PER_CBM", "PER_MT", "PER_SHIPMENT", "PER_PACKAGE"] as const;
export const STORAGE_UNITS = [
  "PER_CBM_DAY", "PER_CBM_MONTH", "PER_PALLET_DAY",
  "PER_PALLET_MONTH", "PER_SQ_FT_MONTH", "PER_MT_DAY",
] as const;
export const WAREHOUSE_CAPABILITIES = [
  "DG_COMPATIBLE", "TEMPERATURE_CONTROLLED", "HUMIDITY_CONTROLLED",
  "FIRE_FIGHTING", "REEFER_COLD_STORAGE", "CCTV_ACCESS",
] as const;

const baseWarehouse = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(WAREHOUSE_TYPES),
  streetAddress: z.string().min(1).max(300),
  country: z.string().min(1).max(120),
  city: z.string().min(1).max(120),
  pinCode: z.string().min(1).max(20),
  capacity: z.number().positive(),
  capacityUnit: z.enum(CAPACITY_UNITS),
  capabilities: z.array(z.enum(WAREHOUSE_CAPABILITIES)).default([]),
  agreementValidUntil: z.string().datetime().optional(),
  insuranceValidUntil: z.string().datetime().optional(),
  isBonded: z.boolean().default(false),
  weekendWorking: z.boolean().default(false),
  weekendWorkingFee: z.number().nonnegative().optional(),
  workingEmployees: z.number().int().nonnegative().optional(),
  forkLiftCount: z.number().int().nonnegative().optional(),
  dipTrayCount: z.number().int().nonnegative().optional(),
  freeStorageDays: z.number().int().nonnegative().default(0),
  rateCurrency: z.enum(CURRENCY_CODES).optional(),
  handlingRate: z.number().nonnegative().optional(),
  handlingUnit: z.enum(HANDLING_UNITS).optional(),
  storageRate: z.number().nonnegative().optional(),
  storageUnit: z.enum(STORAGE_UNITS).optional(),
  status: z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional(),
});

/**
 * Conditional requirements live here rather than in the database: the columns must stay
 * nullable so CLIENT and FF warehouses can omit them entirely.
 */
export const warehouseCreateSchema = baseWarehouse.superRefine((v, ctx) => {
  if (CONTRACTED_TYPES.includes(v.type)) {
    for (const field of ["agreementValidUntil", "insuranceValidUntil"] as const) {
      if (!v[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Required for owned and contracted warehouses",
        });
      }
    }
  }
  const hasRate = v.handlingRate != null || v.storageRate != null || v.weekendWorkingFee != null;
  if (hasRate && !v.rateCurrency) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rateCurrency"],
      message: "A rate needs a currency",
    });
  }
  if (v.handlingRate != null && !v.handlingUnit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["handlingUnit"], message: "A handling rate needs a unit" });
  }
  if (v.storageRate != null && !v.storageUnit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["storageUnit"], message: "A storage rate needs a unit" });
  }
});

export const warehouseUpdateSchema = baseWarehouse.partial();
export type WarehouseCreateInput = z.input<typeof warehouseCreateSchema>;
export type WarehouseUpdateInput = z.input<typeof warehouseUpdateSchema>;

export const warehouseVehicleSchema = z.object({
  tonnage: z.string().min(1),
  quantity: z.number().int().positive(),
});
export type WarehouseVehicleInput = z.infer<typeof warehouseVehicleSchema>;

export interface WarehouseDto {
  id: string;
  name: string;
  type: WarehouseType;
  freightForwarderId: string | null;
  clientId: string | null;
  streetAddress: string;
  country: string;
  city: string;
  pinCode: string;
  capacity: string;
  capacityUnit: (typeof CAPACITY_UNITS)[number];
  capabilities: (typeof WAREHOUSE_CAPABILITIES)[number][];
  freeStorageDays: number;
  status: MasterStatus;
  contacts?: ContactDto[];
  vehicles?: { id: string; tonnage: string; quantity: number }[];
  totalVehicles?: number;
}
```

Add `export * from "./warehouse";` to `packages/shared/src/masters/index.ts`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @svyft/shared test warehouse && pnpm --filter @svyft/shared build`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prisma schema and migration**

Add the five enums and three models to `prisma/schema.prisma`, exactly as in the spec §4.5, with `WarehouseContact` mirroring `FreightForwarderContact` plus `isWeekendIncharge Boolean @default(false)`, and:

```prisma
model WarehouseVehicle {
  id          String       @id @default(uuid()) @db.Uuid
  warehouseId String       @db.Uuid
  warehouse   Warehouse    @relation(fields: [warehouseId], references: [id], onDelete: Cascade)
  tonnage     TruckTonnage
  quantity    Int
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  @@index([warehouseId])
}
```

Add the back-relations `warehouses Warehouse[]` to both `Client` and `FreightForwarder`.

Write `prisma/migrations/20260826094000_warehouse_master/migration.sql` with `CREATE TYPE` for each of the five enums, `CREATE TABLE` for the three models, indexes on `warehouseId`, `freightForwarderId`, `clientId` and `tenantId`, the two foreign keys to `Client` and `FreightForwarder` with `ON DELETE SET NULL`, cascade FKs for the two child tables, and `CREATE UNIQUE INDEX "WarehouseContact_one_primary" ON "WarehouseContact" ("warehouseId") WHERE "pocLevel" = 'PRIMARY';`.

`ON DELETE SET NULL` on the owner columns, not cascade: deleting a forwarder must not delete a warehouse that physically exists.

Apply and regenerate.

- [ ] **Step 6: Verify**

Run: `pnpm exec prisma migrate status --schema prisma/schema.prisma`
Expected: "Database schema is up to date!"

Run: `pnpm -r run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add prisma packages/shared/src
git commit -m "feat(masters): warehouse schema, contacts, vehicles and validation"
```

---

### Task 7: Warehouse master — API module

**Files:**
- Create: `apps/api/src/modules/warehouses/warehouses.{controller,service,module}.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/warehouses.e2e-spec.ts`

**Interfaces:**
- Consumes: `warehouseCreateSchema`, `warehouseVehicleSchema`, `contactCreateSchema`, `auditCreate` / `auditUpdate`.
- Produces: `GET/POST /api/warehouses`, `GET/PATCH /api/warehouses/:id`, `POST/PATCH/DELETE /api/warehouses/:id/contacts[/:contactId]`, `POST/DELETE /api/warehouses/:id/vehicles[/:vehicleId]`. `GET /api/warehouses?unassigned=true` returns warehouses with no owner — Task 14 depends on it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/warehouses.e2e-spec.ts`, `const NAME = "Warehouse E2E";`:

```ts
const base = {
  name: NAME, type: "CLIENT", streetAddress: "Plot 12",
  country: "United Arab Emirates", city: "Dubai", pinCode: "00000",
  capacity: 5000, capacityUnit: "CBM",
};

it("creates a warehouse and derives totalVehicles from the child table", async () => {
  const wh = await request(app.getHttpServer())
    .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR)).send(base).expect(201);

  await request(app.getHttpServer())
    .post(`/api/warehouses/${wh.body.id}/vehicles`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ tonnage: "T_5", quantity: 3 }).expect(201);
  await request(app.getHttpServer())
    .post(`/api/warehouses/${wh.body.id}/vehicles`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ tonnage: "T_12", quantity: 2 }).expect(201);

  const res = await request(app.getHttpServer())
    .get(`/api/warehouses/${wh.body.id}`).set("Cookie", cookie(Role.EXECUTIVE)).expect(200);
  expect(res.body.totalVehicles).toBe(5);
});

it("rejects an owned warehouse with no agreement date", async () => {
  await request(app.getHttpServer())
    .post("/api/warehouses").set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ ...base, name: `${NAME} owned`, type: "OWNED" }).expect(400);
});

it("refuses writes from an executive", async () => {
  await request(app.getHttpServer())
    .post("/api/warehouses").set("Cookie", cookie(Role.EXECUTIVE))
    .send({ ...base, name: `${NAME} rbac` }).expect(403);
});

it("lists only unassigned warehouses when asked", async () => {
  const res = await request(app.getHttpServer())
    .get("/api/warehouses?unassigned=true").set("Cookie", cookie(Role.ADMINISTRATOR)).expect(200);
  expect(res.body.items.every((w: { freightForwarderId: null; clientId: null }) =>
    w.freightForwarderId === null && w.clientId === null)).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test warehouses`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Write the service**

Create `apps/api/src/modules/warehouses/warehouses.service.ts` following `clients.service.ts`. `totalVehicles` is computed on read, never stored:

```ts
  async get(id: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id },
      include: { contacts: true, vehicles: true },
    });
    if (!warehouse) throw new NotFoundException("Warehouse not found");
    return {
      ...warehouse,
      totalVehicles: warehouse.vehicles.reduce((sum, v) => sum + v.quantity, 0),
    };
  }

  async list(params: { q?: string; status?: string; type?: string; unassigned?: boolean; page: number; pageSize: number }) {
    const where: Prisma.WarehouseWhereInput = {
      ...(params.status ? { status: params.status as never } : {}),
      ...(params.type ? { type: params.type as never } : {}),
      ...(params.unassigned ? { freightForwarderId: null, clientId: null } : {}),
      ...(params.q
        ? { OR: [
            { name: { contains: params.q, mode: "insensitive" } },
            { city: { contains: params.q, mode: "insensitive" } },
            { country: { contains: params.q, mode: "insensitive" } },
          ] }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.warehouse.findMany({ where, orderBy: { name: "asc" }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
      this.prisma.warehouse.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }
```

Add `create`, `update`, the three contact methods and the two vehicle methods, each spreading `auditCreate(user)` or `auditUpdate(user)`, and each mapping `P2002` to a `ConflictException` — `"A warehouse with that name already exists"` for the name index, `"This warehouse already has a primary contact"` for `one_primary`.

- [ ] **Step 4: Controller and module**

Create `warehouses.controller.ts` mirroring `clients.controller.ts`, with `@Roles(Role.ADMINISTRATOR, Role.MANAGER)` on every write and `@CurrentUser() user: RequestUser` threaded through. Parse `unassigned` as `@Query("unassigned") unassigned?: string` and pass `unassigned === "true"`. Create `warehouses.module.ts` in the shape of `clients.module.ts`, and register `WarehousesModule` in `app.module.ts`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @svyft/api test warehouses && pnpm -r run typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add apps/api
git commit -m "feat(masters): warehouse API module"
```

---

### Task 8: Warehouse master — web pages

**Files:**
- Create: `apps/web/src/features/masters/warehouses/WarehousesListPage.tsx`, `WarehouseFormPage.tsx`, and their `.test.tsx`
- Modify: `apps/web/src/features/masters/useMasters.ts`, `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `WarehouseDto`, `warehouseCreateSchema`, `ContactList`.
- Produces: routes `/masters/warehouses`, `/masters/warehouses/new`, `/masters/warehouses/:id`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/features/masters/warehouses/WarehouseFormPage.test.tsx`, following the structure of the existing `ClientFormPage.test.tsx` for provider setup:

```tsx
it("shows agreement and insurance dates only for owned and contracted warehouses", async () => {
  renderForm();
  expect(screen.queryByLabelText(/agreement valid until/i)).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "OWNED");
  expect(screen.getByLabelText(/agreement valid until/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/insurance valid until/i)).toBeInTheDocument();
});

it("reports the missing agreement date rather than silently failing", async () => {
  renderForm();
  await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "OWNED");
  await userEvent.type(screen.getByLabelText(/warehouse name/i), "Owned DC");
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/required for owned and contracted/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/web test WarehouseForm`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Build the form**

Create `WarehouseFormPage.tsx` following `ClientFormPage.tsx`. The type-conditional block watches the select rather than duplicating the rule:

```tsx
  const type = useWatch({ control, name: "type" });
  const isContracted = type === "OWNED" || type === "CONTRACTED";
```

and renders the agreement date, insurance date, bonded toggle, free storage days and the rate card inside `{isContracted && (...)}`. Render the owner read-only, because ownership is set from the Forwarder and Client forms (spec D3):

```tsx
      {existing.data?.freightForwarderId || existing.data?.clientId ? (
        <p className="text-sm text-muted-foreground">
          Assigned to {existing.data.freightForwarderId ? "a freight forwarder" : "a client"}.
          Change this from that record.
        </p>
      ) : null}
```

Add `<ContactList ownerPath="warehouses" ownerId={id} />` and a vehicle sub-form posting to `/api/warehouses/:id/vehicles`, showing the derived `totalVehicles` from the GET response as read-only text.

- [ ] **Step 4: List page, hooks and routes**

Create `WarehousesListPage.tsx` following `ClientsListPage.tsx`, with columns Name, Type, City, Country, Capacity, Status. Add `useWarehouses()` and `useWarehouse(id)` to `useMasters.ts` following the existing hooks. Add the three routes to `App.tsx` following the `/masters/clients` block at lines 81-103, and a Warehouses entry to the masters navigation.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @svyft/web test masters && pnpm -r run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add apps/web/src
git commit -m "feat(masters): warehouse list and form pages"
```

---

### Task 9: Charge catalogue — shared derivations

The two pure functions that keep the old columns correct. Everything in Tasks 10-13 depends on these.

**Files:**
- Create: `packages/shared/src/masters/charge-catalogue.ts`, `charge-catalogue.test.ts`
- Modify: `packages/shared/src/masters/index.ts`

**Interfaces:**
- Produces: `CHARGE_CATEGORIES`, `CHARGE_VARIANTS`, `variantsForMode(mode)`, `categoriesForMode(mode)`, `deriveZone(category, mode)`, `deriveRole(isAdditional, tagKey)`, `chargeLineCreateSchema`, `chargeLineUpdateSchema`, `ChargeLineDefinitionAdminDto`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/masters/charge-catalogue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chargeLineCreateSchema, categoriesForMode, deriveRole, deriveZone, variantsForMode } from "./charge-catalogue";

describe("deriveZone", () => {
  it("maps the three positional categories onto the existing zones for Air and Sea", () => {
    expect(deriveZone("ORIGIN", "AIR")).toBe("ORIGIN");
    expect(deriveZone("FREIGHT", "SEA")).toBe("MAIN_FREIGHT");
    expect(deriveZone("DESTINATION", "AIR")).toBe("DESTINATION");
  });

  it("maps Additional to no zone", () => {
    expect(deriveZone("ADDITIONAL", "AIR")).toBeNull();
  });

  it("gives Road no zone at all, whatever its category", () => {
    // Every Road definition carries zone = null today, ROAD_CORE_TRUCKING included. A Road
    // freight line must keep deriving null, or distribute would freeze MAIN_FREIGHT onto
    // ChargeLine.zone where it previously froze null.
    expect(deriveZone("FREIGHT", "ROAD")).toBeNull();
    expect(deriveZone("ADDITIONAL", "ROAD")).toBeNull();
  });
});

describe("deriveRole", () => {
  it("is CORE when the line is not additional", () => {
    expect(deriveRole(false, null)).toBe("CORE");
  });

  it("is TAG_DRIVEN when additional and carrying a tag", () => {
    expect(deriveRole(true, "DG")).toBe("TAG_DRIVEN");
  });

  it("is STANDARD when additional without a tag", () => {
    expect(deriveRole(true, null)).toBe("STANDARD");
  });

  it("ignores a tag on a non-additional line", () => {
    expect(deriveRole(false, "DG")).toBe("CORE");
  });
});

describe("mode-scoped options", () => {
  it("offers Road only Freight and Additional", () => {
    expect(categoriesForMode("ROAD")).toEqual(["FREIGHT", "ADDITIONAL"]);
  });

  it("offers Air and Sea all four categories", () => {
    expect(categoriesForMode("AIR")).toEqual(["ORIGIN", "FREIGHT", "DESTINATION", "ADDITIONAL"]);
  });

  it("scopes variants to the mode", () => {
    expect(variantsForMode("ROAD")).toEqual(["DEDICATED", "GROUPAGE", "BOTH"]);
    expect(variantsForMode("AIR")).toEqual(["DIRECT", "INDIRECT", "BOTH"]);
    expect(variantsForMode("SEA")).toEqual(["FCL", "LCL", "BOTH"]);
  });
});

describe("chargeLineCreateSchema", () => {
  const base = { mode: "SEA" as const, category: "DESTINATION" as const, variant: "FCL" as const, label: "Devanning", isAdditional: true };

  it("accepts a well-formed line", () => {
    expect(chargeLineCreateSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a variant that belongs to another mode", () => {
    expect(chargeLineCreateSchema.safeParse({ ...base, variant: "DEDICATED" }).success).toBe(false);
  });

  it("rejects Origin on a Road line", () => {
    expect(chargeLineCreateSchema.safeParse({ mode: "ROAD", category: "ORIGIN", variant: "BOTH", label: "x", isAdditional: false }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/shared test charge-catalogue`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `packages/shared/src/masters/charge-catalogue.ts`:

```ts
import { z } from "zod";
import { FREIGHT_MODES, type FreightMode } from "../config";
import { REFERENCE_TAGS, type ReferenceTag } from "../cargo";

export const CHARGE_CATEGORIES = ["ORIGIN", "FREIGHT", "DESTINATION", "ADDITIONAL"] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

export const CHARGE_VARIANTS = [
  "DEDICATED", "GROUPAGE", "DIRECT", "INDIRECT", "FCL", "LCL", "BOTH",
] as const;
export type ChargeVariant = (typeof CHARGE_VARIANTS)[number];

const VARIANTS_BY_MODE: Record<FreightMode, ChargeVariant[]> = {
  ROAD: ["DEDICATED", "GROUPAGE", "BOTH"],
  AIR: ["DIRECT", "INDIRECT", "BOTH"],
  SEA: ["FCL", "LCL", "BOTH"],
};

const CATEGORIES_BY_MODE: Record<FreightMode, ChargeCategory[]> = {
  // Road has no origin or destination leg of its own — the seed matrix marks both N/A.
  ROAD: ["FREIGHT", "ADDITIONAL"],
  AIR: ["ORIGIN", "FREIGHT", "DESTINATION", "ADDITIONAL"],
  SEA: ["ORIGIN", "FREIGHT", "DESTINATION", "ADDITIONAL"],
};

export const variantsForMode = (mode: FreightMode): ChargeVariant[] => VARIANTS_BY_MODE[mode];
export const categoriesForMode = (mode: FreightMode): ChargeCategory[] => CATEGORIES_BY_MODE[mode];

/**
 * Phase 1 of the parallel change: `category` and `isAdditional` are what the admin edits,
 * `zone` and `role` are what resolveChargeConfig still reads. These two functions are the only
 * place the old columns are computed — the seed and the catalogue service both call them, so
 * the two representations cannot drift. Retired in the Stage-4 pass; see design doc §2.2.
 */
export function deriveZone(
  category: ChargeCategory,
  mode: FreightMode,
): "ORIGIN" | "MAIN_FREIGHT" | "DESTINATION" | null {
  // Road has no zoned legs — every existing Road definition stores zone = null, and that must
  // stay true, because ChargeLine.zone is frozen at distribute.
  if (mode === "ROAD") return null;
  switch (category) {
    case "ORIGIN": return "ORIGIN";
    case "FREIGHT": return "MAIN_FREIGHT";
    case "DESTINATION": return "DESTINATION";
    case "ADDITIONAL": return null;
  }
}

export function deriveRole(
  isAdditional: boolean,
  tagKey: ReferenceTag | null,
): "CORE" | "STANDARD" | "TAG_DRIVEN" {
  if (!isAdditional) return "CORE";
  return tagKey ? "TAG_DRIVEN" : "STANDARD";
}

const baseChargeLine = z.object({
  mode: z.enum(FREIGHT_MODES),
  variant: z.enum(CHARGE_VARIANTS),
  category: z.enum(CHARGE_CATEGORIES),
  label: z.string().min(1).max(120),
  isAdditional: z.boolean(),
  tagKey: z.enum(REFERENCE_TAGS).nullish(),
  inputType: z.enum(["PLAIN", "TRUCKING", "WAREHOUSE_STAGING", "HEAVY_WEIGHT_CALC"]).default("PLAIN"),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().default(true),
});

export const chargeLineCreateSchema = baseChargeLine.superRefine((v, ctx) => {
  if (!variantsForMode(v.mode).includes(v.variant)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["variant"],
      message: `${v.variant} is not a ${v.mode} variant`,
    });
  }
  if (!categoriesForMode(v.mode).includes(v.category)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: `${v.mode} charges have no ${v.category} category`,
    });
  }
  if (v.tagKey && !v.isAdditional) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tagKey"],
      message: "Only additional charges can be tag-driven",
    });
  }
});

/** Category and isAdditional are set on create and immutable afterwards — see design doc D18. */
export const chargeLineUpdateSchema = baseChargeLine
  .pick({ label: true, sortOrder: true, isActive: true, inputType: true })
  .partial();

export type ChargeLineCreateInput = z.input<typeof chargeLineCreateSchema>;
export type ChargeLineUpdateInput = z.input<typeof chargeLineUpdateSchema>;

export interface ChargeLineDefinitionAdminDto {
  id: string;
  key: string;
  mode: FreightMode;
  variant: ChargeVariant;
  category: ChargeCategory;
  label: string;
  isAdditional: boolean;
  tagKey: ReferenceTag | null;
  inputType: string;
  sortOrder: number;
  isActive: boolean;
}

/** `SEA_DEST_WHARFAGE` from ("SEA", "DESTINATION", "Wharfage Charges"). */
export function chargeLineKey(mode: FreightMode, category: ChargeCategory, label: string): string {
  const cat = { ORIGIN: "ORIGIN", FREIGHT: "FREIGHT", DESTINATION: "DEST", ADDITIONAL: "ADD" }[category];
  const slug = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  return `${mode}_${cat}_${slug}`;
}
```

Verify the import paths for `FREIGHT_MODES` and `REFERENCE_TAGS` against `packages/shared/src/config.ts` and `cargo.ts` before running — if `REFERENCE_TAGS` is not exported there, find its module with `grep -rn "REFERENCE_TAGS" packages/shared/src` and import from that.

Add `export * from "./charge-catalogue";` to `masters/index.ts`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @svyft/shared test charge-catalogue && pnpm --filter @svyft/shared build`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add packages/shared/src
git commit -m "feat(masters): charge catalogue categories, variants and zone/role derivation"
```

---

### Task 10: Charge catalogue — schema, migration and backfill

**Files:**
- Modify: `prisma/schema.prisma` — `ChargeLineDefinition`
- Create: `prisma/migrations/20260826095000_charge_catalogue_columns/migration.sql`
- Create: `apps/api/test/charge-catalogue-invariant.e2e-spec.ts`

**Interfaces:**
- Consumes: `deriveZone`, `deriveRole` from Task 9.
- Produces: `ChargeLineDefinition.category`, `.variant`, `.isAdditional`, all `NOT NULL`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/charge-catalogue-invariant.e2e-spec.ts`. This is the guard that the two representations never diverge:

```ts
import { deriveRole, deriveZone } from "@svyft/shared";

it("keeps zone and role derivable from category and isAdditional for every definition", async () => {
  const rows = await prisma.chargeLineDefinition.findMany();
  expect(rows.length).toBeGreaterThan(0);

  const drifted = rows
    .filter((r) => r.key !== "ROAD_WH_HANDLING")   // warehousing is deferred; it has no category
    .filter(
      (r) =>
        r.zone !== deriveZone(r.category as never, r.mode as never) ||
        r.role !== deriveRole(r.isAdditional, r.tagKey as never),
    )
    .map((r) => r.key);

  expect(drifted).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test charge-catalogue-invariant`
Expected: FAIL — `Property 'category' does not exist`.

- [ ] **Step 3: Schema and migration**

Add to `ChargeLineDefinition` in `prisma/schema.prisma`:

```prisma
  category     ChargeCategory?
  variant      ChargeVariant   @default(BOTH)
  isAdditional Boolean         @default(false)
```

`category` is nullable in Prisma solely so `ROAD_WH_HANDLING` can hold null while warehousing is deferred; every other row is backfilled and the admin schema requires it.

```prisma
enum ChargeCategory { ORIGIN FREIGHT DESTINATION ADDITIONAL }
enum ChargeVariant { DEDICATED GROUPAGE DIRECT INDIRECT FCL LCL BOTH }
```

Create `prisma/migrations/20260826095000_charge_catalogue_columns/migration.sql`:

```sql
CREATE TYPE "ChargeCategory" AS ENUM ('ORIGIN', 'FREIGHT', 'DESTINATION', 'ADDITIONAL');
CREATE TYPE "ChargeVariant" AS ENUM ('DEDICATED','GROUPAGE','DIRECT','INDIRECT','FCL','LCL','BOTH');

ALTER TABLE "ChargeLineDefinition"
  ADD COLUMN "category" "ChargeCategory",
  ADD COLUMN "variant" "ChargeVariant" NOT NULL DEFAULT 'BOTH',
  ADD COLUMN "isAdditional" BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill the new columns from the old, the exact inverse of deriveZone/deriveRole.
-- Air and Sea take their category from the zone. Road has no zone, so it is split by role:
-- the trucking line is Freight, everything else is Additional.
UPDATE "ChargeLineDefinition" SET "category" = CASE
  WHEN "zone" = 'ORIGIN'          THEN 'ORIGIN'::"ChargeCategory"
  WHEN "zone" = 'MAIN_FREIGHT'    THEN 'FREIGHT'::"ChargeCategory"
  WHEN "zone" = 'DESTINATION'     THEN 'DESTINATION'::"ChargeCategory"
  WHEN "key" = 'ROAD_CORE_TRUCKING' THEN 'FREIGHT'::"ChargeCategory"
  ELSE 'ADDITIONAL'::"ChargeCategory"
END
WHERE "role" <> 'WAREHOUSE';

UPDATE "ChargeLineDefinition" SET "isAdditional" = ("role" <> 'CORE') WHERE "role" <> 'WAREHOUSE';

-- Warehousing is out of scope: ROAD_WH_HANDLING keeps a null category and is hidden from the screen.
UPDATE "ChargeLineDefinition" SET "category" = NULL WHERE "role" = 'WAREHOUSE';
```

Two rules make the invariant hold on every row, and both are load-bearing:

- **Tag-driven lines keep the category their zone implies** — an Air tag line stays `DESTINATION`, not `ADDITIONAL`. It reads as Additional on the screen because `isAdditional` is true; its category only records where it sits in the quote. Moving it to `ADDITIONAL` would derive `zone = null` where the column holds `DESTINATION`, and future quotes would freeze a different zone.
- **`ROAD_CORE_TRUCKING` becomes `FREIGHT`**, which is semantically right and still derives `zone = null`, because `deriveZone` short-circuits on Road.

Apply and regenerate.

- [ ] **Step 4: Run the invariant test and watch it pass**

Run: `pnpm --filter @svyft/api test charge-catalogue-invariant`
Expected: PASS, `drifted` empty across all 51 rows.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add prisma apps/api/test
git commit -m "feat(masters): charge catalogue category, variant and isAdditional columns"
```

---

### Task 11: Charge catalogue — write API

**Files:**
- Modify: `apps/api/src/modules/config/charge-catalogue.{controller,service}.ts`
- Create: `apps/api/test/charge-catalogue-crud.e2e-spec.ts`

**Interfaces:**
- Consumes: `chargeLineCreateSchema`, `chargeLineUpdateSchema`, `chargeLineKey`, `deriveZone`, `deriveRole`.
- Produces: `POST /api/config/charge-catalogue`, `PATCH /api/config/charge-catalogue/:id`, `DELETE /api/config/charge-catalogue/:id`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/charge-catalogue-crud.e2e-spec.ts`:

```ts
const line = {
  mode: "SEA", variant: "FCL", category: "DESTINATION",
  label: "Catalogue E2E Charge", isAdditional: true,
};

it("writes the derived zone and role alongside the new columns", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/config/charge-catalogue").set("Cookie", cookie(Role.ADMINISTRATOR))
    .send(line).expect(201);

  const row = await prisma.chargeLineDefinition.findUnique({ where: { id: res.body.id } });
  expect(row?.category).toBe("DESTINATION");
  expect(row?.zone).toBe("DESTINATION");     // derived
  expect(row?.role).toBe("STANDARD");        // derived: additional, no tag
  expect(row?.key).toBe("SEA_DEST_CATALOGUE_E2E_CHARGE");
});

it("refuses to change category after creation", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/config/charge-catalogue").set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ ...line, label: "Catalogue E2E Immutable" }).expect(201);

  await request(app.getHttpServer())
    .patch(`/api/config/charge-catalogue/${res.body.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ category: "ORIGIN" }).expect(400);
});

it("refuses to delete a definition a quote references", async () => {
  const used = await prisma.chargeLineDefinition.findFirst({ where: { selections: { some: {} } } });
  if (!used) return;   // no distributed quote in this database; nothing to assert
  const res = await request(app.getHttpServer())
    .delete(`/api/config/charge-catalogue/${used.id}`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .expect(409);
  expect(res.body.message).toMatch(/in use/i);
});

it("refuses writes from an executive", async () => {
  await request(app.getHttpServer())
    .post("/api/config/charge-catalogue").set("Cookie", cookie(Role.EXECUTIVE))
    .send({ ...line, label: "Catalogue E2E RBAC" }).expect(403);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test charge-catalogue-crud`
Expected: FAIL — 404, the controller has only a `@Get()`.

- [ ] **Step 3: Write the service methods**

In `charge-catalogue.service.ts`:

```ts
  async create(input: ChargeLineCreateInput, user?: RequestUser) {
    const tagKey = input.tagKey ?? null;
    const key = chargeLineKey(input.mode, input.category, input.label);
    const maxSort = await this.prisma.chargeLineDefinition.aggregate({
      where: { mode: input.mode, category: input.category },
      _max: { sortOrder: true },
    });
    try {
      return await this.prisma.chargeLineDefinition.create({
        data: {
          key,
          mode: input.mode,
          variant: input.variant,
          category: input.category,
          label: input.label,
          isAdditional: input.isAdditional,
          tagKey,
          inputType: input.inputType ?? "PLAIN",
          isActive: input.isActive ?? true,
          sortOrder: input.sortOrder ?? (maxSort._max.sortOrder ?? 0) + 10,
          // Derived, never supplied by the caller — the quote layer still reads these.
          zone: deriveZone(input.category, input.mode),
          role: deriveRole(input.isAdditional, tagKey),
          ...auditCreate(user),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(`A charge line with the key ${key} already exists`);
      }
      throw e;
    }
  }

  async update(id: string, input: ChargeLineUpdateInput, user?: RequestUser) {
    return this.prisma.chargeLineDefinition.update({
      where: { id },
      data: { ...input, ...auditUpdate(user) },
    });
  }

  async remove(id: string) {
    const inUse = await this.prisma.legChargeLineSelection.count({ where: { definitionId: id } });
    if (inUse > 0) {
      throw new ConflictException(
        `This charge line is in use on ${inUse} leg${inUse === 1 ? "" : "s"} and cannot be deleted. Deactivate it instead.`,
      );
    }
    return this.prisma.chargeLineDefinition.delete({ where: { id } });
  }
```

`chargeLineUpdateSchema` picks only `label`, `sortOrder`, `isActive` and `inputType`, so a request carrying `category` is rejected by the validation pipe with a 400 before reaching the service — that is what makes the immutability test pass, and it is why the pipe must not be given a `.passthrough()` schema.

- [ ] **Step 4: Controller**

Add to `charge-catalogue.controller.ts`, keeping the existing `@Get()` untouched:

```ts
  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Post()
  create(
    @Body(new ZodValidationPipe(chargeLineCreateSchema)) body: ChargeLineCreateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.catalogue.create(body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(chargeLineUpdateSchema)) body: ChargeLineUpdateInput,
    @CurrentUser() user: RequestUser,
  ) {
    return this.catalogue.update(id, body, user);
  }

  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.catalogue.remove(id);
  }
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @svyft/api test charge-catalogue && pnpm -r run typecheck`
Expected: PASS — both the CRUD suite and the invariant suite from Task 10, which now also covers rows created through the API.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add apps/api
git commit -m "feat(masters): charge catalogue write API with derived zone and role"
```

---

### Task 12: Charge catalogue — seed the 19 new lines

**Files:**
- Modify: `apps/api/src/seed/reference-seed.ts`
- Create: `apps/api/test/charge-catalogue-snapshot.e2e-spec.ts`

**Interfaces:**
- Consumes: `deriveZone`, `deriveRole`, `chargeLineKey`.
- Produces: 70 definitions, of which the three new always-included lines are inactive.

- [ ] **Step 1: Write the acceptance test**

This is the build's acceptance criterion from spec §7 — distribute must produce byte-identical snapshots. Create `apps/api/test/charge-catalogue-snapshot.e2e-spec.ts`:

```ts
import { resolveChargeConfig } from "@svyft/shared";

it("does not change what an Air leg resolves to, despite 19 new definitions", async () => {
  const definitions = await prisma.chargeLineDefinition.findMany({ where: { mode: "AIR" } });
  const snapshot = resolveChargeConfig(definitions as never, [], false, []);

  // Only always-included lines land on a leg with nothing selected and no tags.
  const keys = snapshot.lines.map((l) => l.definitionKey).sort();
  expect(keys).toEqual([
    "AIR_MAIN_CARRIER_SURCHARGE",
    "AIR_MAIN_FREIGHT",
    "AIR_MAIN_FSC",
    "AIR_MAIN_HEAVY_WEIGHT",
    "AIR_MAIN_PEAK_SEASON",
    "AIR_MAIN_SEC",
    "AIR_ORIGIN_DOCUMENTATION",
    "AIR_ORIGIN_EXPORT_CLEARANCE",
    "AIR_ORIGIN_SECURITY",
    "AIR_ORIGIN_THC",
    "AIR_ORIGIN_WAREHOUSE_PRESTORAGE",
  ]);
  // AIR_ORIGIN_INSURANCE is new and always-included, so it is seeded inactive (D17) and
  // must NOT appear here. If it does, the seed changed live pricing.
  expect(keys).not.toContain("AIR_ORIGIN_INSURANCE");
});

it("seeds the three new always-included lines inactive", async () => {
  const rows = await prisma.chargeLineDefinition.findMany({
    where: { key: { in: ["AIR_ORIGIN_INSURANCE", "SEA_ORIGIN_CONTAINER_TRANSPORT", "SEA_ORIGIN_LSS"] } },
  });
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.isActive === false)).toBe(true);
});

it("seeds the sixteen executive-selected lines active", async () => {
  const row = await prisma.chargeLineDefinition.findUnique({ where: { key: "SEA_DEST_WHARFAGE" } });
  expect(row?.isActive).toBe(true);
  expect(row?.isAdditional).toBe(true);
  expect(row?.role).toBe("STANDARD");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test charge-catalogue-snapshot`
Expected: FAIL on the last two — those keys do not exist yet.

- [ ] **Step 3: Extend the seed**

In `apps/api/src/seed/reference-seed.ts`, extend `ChargeDef` with `category`, `variant`, `isAdditional`, and backfill those three fields on all 51 existing entries to match their current `zone`/`role` — `zone: "ORIGIN"` becomes `category: "ORIGIN", isAdditional: false`, `role: "STANDARD"` becomes `isAdditional: true`, `role: "TAG_DRIVEN"` becomes `isAdditional: true` with its existing tag, Road entries with no zone become `category: "ADDITIONAL"` except `ROAD_CORE_TRUCKING` which is `category: "FREIGHT"`. Leave `ROAD_WH_HANDLING` with no category.

Then append the 19 new entries. In full:

```ts
const NEW_CHARGE_LINES: ChargeDef[] = [
  // Air — origin
  { key: "AIR_ORIGIN_INSURANCE", mode: "AIR", category: "ORIGIN", variant: "BOTH", label: "Insurance", isAdditional: false, isActive: false },
  { key: "AIR_ORIGIN_MAGNETIC_FEE", mode: "AIR", category: "ORIGIN", variant: "BOTH", label: "Magnetic Fee", isAdditional: true },
  { key: "AIR_ORIGIN_T1_EUROPE", mode: "AIR", category: "ORIGIN", variant: "BOTH", label: "Europe T1 Document", isAdditional: true },
  { key: "AIR_ORIGIN_EDD", mode: "AIR", category: "ORIGIN", variant: "BOTH", label: "EDD Security Check", isAdditional: true },
  // Air — destination
  { key: "AIR_DEST_CUSTOM_DOCS_T1", mode: "AIR", category: "DESTINATION", variant: "BOTH", label: "Custom Documents (T1)", isAdditional: true },
  { key: "AIR_DEST_FILE_OPENING", mode: "AIR", category: "DESTINATION", variant: "BOTH", label: "File Opening Charges", isAdditional: true },
  // Sea — origin
  { key: "SEA_ORIGIN_CONTAINER_TRANSPORT", mode: "SEA", category: "ORIGIN", variant: "BOTH", label: "Container Transport / Loading", isAdditional: false, isActive: false },
  { key: "SEA_ORIGIN_LSS", mode: "SEA", category: "ORIGIN", variant: "BOTH", label: "LSS (Low Sulphur Surcharge)", isAdditional: false, isActive: false },
  // Sea — destination
  { key: "SEA_DEST_CFS", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "CFS Charges", isAdditional: true },
  { key: "SEA_DEST_DO_RELEASE", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "DO Release", isAdditional: true },
  { key: "SEA_DEST_CONTAINER_CLEANING", mode: "SEA", category: "DESTINATION", variant: "FCL", label: "Container Cleaning", isAdditional: true },
  { key: "SEA_DEST_DEVANNING", mode: "SEA", category: "DESTINATION", variant: "FCL", label: "Devanning Charges", isAdditional: true },
  { key: "SEA_DEST_WHARFAGE", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "Wharfage Charges", isAdditional: true },
  { key: "SEA_DEST_BAF", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "BAF (Bunker Adjustment Factor)", isAdditional: true },
  { key: "SEA_DEST_CAF", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "CAF (Currency Adjustment Factor)", isAdditional: true },
  { key: "SEA_DEST_DDF", mode: "SEA", category: "DESTINATION", variant: "BOTH", label: "DDF (Document Fee / Admin / Cargo Release)", isAdditional: true },
  // Sea — additional
  { key: "SEA_ADD_GAS_MEASURING", mode: "SEA", category: "ADDITIONAL", variant: "BOTH", label: "Gas Measuring Charges", isAdditional: true },
  { key: "SEA_ADD_EMERGENCY_SURCHARGE", mode: "SEA", category: "ADDITIONAL", variant: "BOTH", label: "Emergency Surcharge", isAdditional: true },
  // Road — additional
  { key: "ROAD_ADD_BONDED_LICENCE", mode: "ROAD", category: "ADDITIONAL", variant: "BOTH", label: "Bonded Licence Fee", isAdditional: true },
];
```

The three `isActive: false` entries are D17: each is always-included, so an active one would price on every future Air or Sea RFQ the moment the seed ran.

In the upsert loop, compute the old columns rather than hardcoding them, so the seed and the API share one derivation:

```ts
for (const def of [...CHARGE_LINE_DEFINITIONS, ...NEW_CHARGE_LINES]) {
  const tagKey = def.tagKey ?? null;
  const derived = def.category
    ? { zone: deriveZone(def.category, def.mode), role: deriveRole(def.isAdditional, tagKey) }
    : { zone: def.zone ?? null, role: def.role };   // ROAD_WH_HANDLING keeps what it has
  await prisma.chargeLineDefinition.upsert({
    where: { key: def.key },
    create: { ...def, ...derived, tagKey, isActive: def.isActive ?? true },
    update: { ...def, ...derived, tagKey, isActive: def.isActive ?? true },
  });
}
```

- [ ] **Step 4: Re-seed and run the tests**

Run: `pnpm exec prisma db seed`
Then: `pnpm --filter @svyft/api test charge-catalogue`
Expected: PASS — the snapshot, invariant and CRUD suites.

Run: `pnpm --filter @svyft/api test`
Expected: PASS. Any failure in an `ff-portal` or `rfq` suite means a new definition reached a quote it should not have — check that all three new always-included lines are inactive before looking anywhere else.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/api
git commit -m "feat(masters): seed 19 charge lines, three inactive to keep pricing unchanged"
```

---

### Task 13: Charge catalogue — admin screen

**Files:**
- Create: `apps/web/src/features/masters/charge-catalogue/ChargeCatalogueListPage.tsx`, `ChargeLineFormPage.tsx`, `ChargeLineFormPage.test.tsx`
- Modify: `apps/web/src/features/masters/useMasters.ts`, `apps/web/src/App.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it("offers only the categories and variants that belong to the chosen mode", async () => {
  renderForm();
  await userEvent.selectOptions(screen.getByLabelText(/mode/i), "ROAD");
  const categories = within(screen.getByLabelText(/category/i)).getAllByRole("option");
  expect(categories.map((o) => o.textContent)).toEqual(["Freight Charges", "Additional Charges"]);

  await userEvent.selectOptions(screen.getByLabelText(/mode/i), "SEA");
  const variants = within(screen.getByLabelText(/variant/i)).getAllByRole("option");
  expect(variants.map((o) => (o as HTMLOptionElement).value)).toEqual(["FCL", "LCL", "BOTH"]);
});

it("locks category and additional when editing an existing line", async () => {
  renderForm({ id: "existing-id" });
  expect(await screen.findByLabelText(/category/i)).toBeDisabled();
  expect(screen.getByLabelText(/additional charge/i)).toBeDisabled();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/web test ChargeLineForm`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the form**

Create `ChargeLineFormPage.tsx`. The mode-dependent selects read from the shared helpers rather than duplicating the rule, and the two immutable fields are disabled when editing:

```tsx
  const mode = useWatch({ control, name: "mode" }) ?? "ROAD";
  const isEdit = Boolean(id);

  const CATEGORY_LABELS: Record<ChargeCategory, string> = {
    ORIGIN: "Origin Charges",
    FREIGHT: "Freight Charges",
    DESTINATION: "Destination Charges",
    ADDITIONAL: "Additional Charges",
  };
```

```tsx
      <div className="space-y-1">
        <Label htmlFor="category">Category</Label>
        <select id="category" disabled={isEdit} {...register("category")}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm">
          {categoriesForMode(mode).map((c) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>
        {isEdit && (
          <p className="text-sm text-muted-foreground">
            Category is fixed after creation — it determines how quotes group this charge.
          </p>
        )}
      </div>
```

with the same shape for Variant (using `variantsForMode(mode)`, not disabled) and a disabled-when-editing checkbox for `isAdditional` labelled "Additional charge". Show the generated key read-only when editing.

- [ ] **Step 4: List page and routes**

Create `ChargeCatalogueListPage.tsx` with columns Label (key beneath in `font-mono text-xs text-muted-foreground`), Mode, Variant, Category, Additional, Input, Sort, Status, and filter selects for mode, category and status plus a search box. Give each row a Deactivate action calling `PATCH … { isActive: false }`, and a Delete action that surfaces the 409 message when the line is in use:

```tsx
  async function onDelete(lineId: string) {
    try {
      await deleteJson(`/api/config/charge-catalogue/${lineId}`);
      await qc.invalidateQueries({ queryKey: ["charge-catalogue"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete this charge line");
    }
  }
```

Filter `ROAD_WH_HANDLING` out of the list — it has no category while warehousing is deferred:

```tsx
  const rows = (data?.items ?? []).filter((l) => l.category != null);
```

Add the routes to `App.tsx` and a Charge Catalogue entry to the masters navigation.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @svyft/web test && pnpm -r run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add apps/web/src
git commit -m "feat(masters): charge catalogue admin screen"
```

---

### Task 14: Warehouse linking from the Forwarder and Client forms

Ownership is stored on the warehouse but edited from the parent, so that "no warehouse serves two forwarders" is a database guarantee rather than a convention.

**Files:**
- Modify: `apps/api/src/modules/freight-forwarders/*`, `apps/api/src/modules/clients/*`
- Modify: `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx`, `clients/ClientFormPage.tsx`
- Create: `apps/web/src/features/masters/WarehousePicker.tsx`
- Create: `apps/api/test/warehouse-linking.e2e-spec.ts`

**Interfaces:**
- Consumes: `GET /api/warehouses?unassigned=true` from Task 7.
- Produces: `PUT /api/freight-forwarders/:id/warehouses` and `PUT /api/clients/:id/warehouses`, both taking `{ warehouseIds: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
it("assigns and unassigns warehouses in one call", async () => {
  const ff = await createFf("Linking E2E");
  const a = await createWarehouse("Linking WH A");
  const b = await createWarehouse("Linking WH B");

  await request(app.getHttpServer())
    .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ warehouseIds: [a.id, b.id] }).expect(200);

  expect((await prisma.warehouse.findUnique({ where: { id: a.id } }))?.freightForwarderId).toBe(ff.id);

  await request(app.getHttpServer())
    .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ warehouseIds: [a.id] }).expect(200);

  expect((await prisma.warehouse.findUnique({ where: { id: b.id } }))?.freightForwarderId).toBeNull();
});

it("keeps whLocation in step with the assignment, for the RFQ payload", async () => {
  const ff = await createFf("Linking E2E WhLocation");
  const wh = await createWarehouse("Linking WH Named");

  await request(app.getHttpServer())
    .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ warehouseIds: [wh.id] }).expect(200);
  expect((await prisma.freightForwarder.findUnique({ where: { id: ff.id } }))?.whLocation)
    .toBe("Linking WH Named");

  await request(app.getHttpServer())
    .put(`/api/freight-forwarders/${ff.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ warehouseIds: [] }).expect(200);
  expect((await prisma.freightForwarder.findUnique({ where: { id: ff.id } }))?.whLocation).toBeNull();
});

it("refuses a warehouse already owned by another forwarder", async () => {
  const first = await createFf("Linking E2E One");
  const second = await createFf("Linking E2E Two");
  const wh = await createWarehouse("Linking WH Contested");

  await request(app.getHttpServer())
    .put(`/api/freight-forwarders/${first.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ warehouseIds: [wh.id] }).expect(200);

  const res = await request(app.getHttpServer())
    .put(`/api/freight-forwarders/${second.id}/warehouses`).set("Cookie", cookie(Role.ADMINISTRATOR))
    .send({ warehouseIds: [wh.id] }).expect(409);
  expect(res.body.message).toMatch(/already assigned/i);
});
```

Write `createFf` and `createWarehouse` as local helpers posting to the respective endpoints and returning `res.body`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @svyft/api test warehouse-linking`
Expected: FAIL — 404 on the PUT route.

- [ ] **Step 3: Implement the assignment**

In `freight-forwarders.service.ts`:

```ts
  /**
   * Sets this forwarder's warehouses to exactly `warehouseIds`. One transaction, so a warehouse
   * can never be momentarily owned by two forwarders, and the contested check sees a consistent
   * view. Ownership lives on Warehouse rather than a join table because a join table would
   * permit the many-to-many the requirement rules out.
   */
  async setWarehouses(ffId: string, warehouseIds: string[]) {
    return this.prisma.$transaction(async (tx) => {
      const contested = await tx.warehouse.findFirst({
        where: {
          id: { in: warehouseIds },
          OR: [
            { freightForwarderId: { not: null, notIn: [ffId] } },
            { clientId: { not: null } },
          ],
        },
      });
      if (contested) {
        throw new ConflictException(`${contested.name} is already assigned to another record`);
      }
      await tx.warehouse.updateMany({
        where: { freightForwarderId: ffId, id: { notIn: warehouseIds } },
        data: { freightForwarderId: null },
      });
      await tx.warehouse.updateMany({
        where: { id: { in: warehouseIds } },
        data: { freightForwarderId: ffId },
      });
      const assigned = await tx.warehouse.findMany({
        where: { freightForwarderId: ffId },
        orderBy: { name: "asc" },
      });
      // Phase 1 dual-write, the counterpart to syncPrimaryContactColumns: rfq.service.ts
      // snapshots whLocation into the RFQ payload, so it tracks the assigned warehouses until
      // the Stage-4 pass repoints that read at this relation. Retired with it.
      await tx.freightForwarder.update({
        where: { id: ffId },
        data: { whLocation: assigned.map((w) => w.name).join(", ") || null },
      });
      return assigned;
    });
  }
```

Add the matching `setWarehouses` to `ClientsService` with `clientId` in place of `freightForwarderId` and the mirrored contested check. Add to both controllers:

```ts
  @Roles(Role.ADMINISTRATOR, Role.MANAGER)
  @Put(":id/warehouses")
  setWarehouses(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(z.object({ warehouseIds: z.array(z.string().uuid()) }))) body: { warehouseIds: string[] },
  ) {
    return this.freightForwarders.setWarehouses(id, body.warehouseIds);
  }
```

When an empty `warehouseIds` array arrives, `updateMany` with `notIn: []` still clears everything currently owned, which is the intended "unassign all".

- [ ] **Step 4: Build the picker**

Create `apps/web/src/features/masters/WarehousePicker.tsx`: a checkbox list fed by `GET /api/warehouses?unassigned=true` merged with the parent's currently-assigned warehouses, submitting the full selected set to the PUT endpoint. It takes `{ ownerPath: "freight-forwarders" | "clients"; ownerId?: string; assigned: WarehouseDto[] }`, and renders the same "Save this record first" message as `ContactList` when `ownerId` is absent. Render it in both form pages beneath the contact list.

- [ ] **Step 5: Run everything**

Run: `pnpm --filter @svyft/api test && pnpm --filter @svyft/web test && pnpm -r run typecheck && pnpm run lint`
Expected: PASS across the board, every pre-existing suite unedited.

- [ ] **Step 6: Full gate and commit**

Run: `pnpm run ci`
Expected: PASS — lint, typecheck, test, build.

```bash
git branch --show-current
git add apps
git commit -m "feat(masters): assign warehouses to forwarders and clients"
```

---

## Done when

- `pnpm run ci` is green.
- Every pre-existing test file is byte-identical to its state at `b875291` — `git diff --stat b875291 -- '**/*.test.ts' '**/*.test.tsx' 'apps/api/test'` shows only added files.
- `git diff --name-only b875291` contains no path under `apps/api/src/modules/{rfq,ff-portal,quotes,legs,changes,status}`, `apps/web/src/features/{ff-portal,rfq-workspace,query-wizard}`, or the six protected files in `packages/shared/src`.
- `charge-catalogue-snapshot.e2e-spec.ts` passes: an Air leg with nothing selected resolves to exactly the eleven definitions it resolved to before this build.
- The backfill log at the end of this document lists every vessel given a generated IMO.

## Backfill log

Filled in by Task 3, Step 6.
