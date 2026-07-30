# FF Master — Address Fields & Form Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional City / Postal Code / Country to the Freight Forwarder Master, relabel "Company Address" → "Street Address" (label only), and re-lay the create/edit form into compact two-column logical sections.

**Architecture:** Data flows shared zod schema → Prisma model → NestJS service (spreads input) → React form. The shared `@svyft/shared` package is the single source of truth for the create schema and `FreightForwarderDto`; the Prisma column set must match, and the one explicit DTO mapper in `rfq.service.ts` must be kept in sync. Three additive, nullable columns — no data migration, no field rename.

**Tech Stack:** TypeScript, Zod, Prisma (PostgreSQL), NestJS, React + react-hook-form, Vitest (shared/web), Jest + supertest (api e2e), pnpm workspaces.

## Global Constraints

- **`@svyft/shared` is consumed from its built `dist`** by `@svyft/api` and `@svyft/web` (neither app tsconfig aliases it). After editing `packages/shared/src`, run `pnpm --filter @svyft/shared build` **before** api/web typecheck or their `tsc` sees stale types.
- **api e2e** maps `^@svyft/shared$` → `packages/shared/src/index.ts` (Jest `moduleNameMapper`), so e2e tests see shared **source** without a build. Only `tsc` needs the dist build.
- **New fields are optional** (`.optional()` / `String?` / `string | null`). **Country is free text** (`z.string().max(120)`), no enum. **Rename is label-only** — the field/column identifier stays `companyAddress`.
- **DTO fields are required keys with nullable values** (`city: string | null`), matching the existing `companyAddress: string | null` style. Every object literal typed as `FreightForwarderDto` must include the keys.
- **Run `tsc` per package** after each package's change (vitest/jest via esbuild/ts-jest don't fail the build on type errors in test files).
- **Postgres dev DB** runs via `docker compose -f docker-compose.dev.yml up -d`; migrations via `prisma migrate`. `DATABASE_URL`/`DIRECT_URL` come from `.env`.
- **RBAC unchanged** — FF create/update already gate to `ADMINISTRATOR`/`MANAGER`.
- **Commit after each task.**

---

### Task 1: Shared schema + DTO (source of truth)

**Files:**
- Modify: `packages/shared/src/masters.ts` (`freightForwarderCreateSchema` ~line 91, `FreightForwarderDto` ~line 111)
- Test: `packages/shared/src/masters.test.ts` (append to the `freightForwarderCreateSchema` describe block, after line 79)

**Interfaces:**
- Produces: `freightForwarderCreateSchema` gains optional `city`, `postalCode`, `country`. `FreightForwarderCreateInput` / `FreightForwarderUpdateInput` (via `.partial()`) gain them. `FreightForwarderDto` gains `city: string | null`, `postalCode: string | null`, `country: string | null`. Consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/masters.test.ts`, insert these two tests immediately before the closing `});` of the `describe("freightForwarderCreateSchema", ...)` block (after the "rejects an unknown mode" test at line 79):

```ts
  it("keeps optional address fields on the parsed output", () => {
    const parsed = freightForwarderCreateSchema.safeParse({
      ...validFf,
      companyAddress: "1 Cargo Way",
      city: "Singapore",
      postalCode: "049145",
      country: "Singapore",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.city).toBe("Singapore");
      expect(parsed.data.postalCode).toBe("049145");
      expect(parsed.data.country).toBe("Singapore");
    }
  });
  it("rejects a country longer than 120 chars", () => {
    expect(
      freightForwarderCreateSchema.safeParse({ ...validFf, country: "x".repeat(121) }).success,
    ).toBe(false);
  });
```

(Zod strips unknown keys, so both tests are genuinely red before the schema change: `parsed.data.city` is `undefined`, and the 121-char `country` is ignored rather than rejected.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @svyft/shared exec vitest run masters`
Expected: FAIL — "keeps optional address fields…" (`expected undefined to be "Singapore"`) and "rejects a country longer than 120 chars" (`expected true to be false`).

- [ ] **Step 3: Add the fields to the schema and DTO**

In `packages/shared/src/masters.ts`, in `freightForwarderCreateSchema`, add the three lines directly after `companyAddress: z.string().max(500).optional(),`:

```ts
  city: z.string().max(120).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(120).optional(),
```

In the `FreightForwarderDto` interface, add the three lines directly after `companyAddress: string | null;`:

```ts
  city: string | null;
  postalCode: string | null;
  country: string | null;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @svyft/shared exec vitest run masters`
Expected: PASS (all `freightForwarderCreateSchema` tests green).

- [ ] **Step 5: Build shared and typecheck**

Run: `pnpm --filter @svyft/shared build && pnpm --filter @svyft/shared typecheck`
Expected: both succeed (this refreshes `dist` so api/web see the new types in later tasks).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/masters.ts packages/shared/src/masters.test.ts
git commit -m "feat(shared): add optional city/postalCode/country to FF schema + DTO"
```

---

### Task 2: Prisma columns + migration

**Files:**
- Modify: `prisma/schema.prisma` (`model FreightForwarder`, after `companyAddress` at line 120)
- Create: `prisma/migrations/<timestamp>_add_ff_address_fields/migration.sql` (generated)

**Interfaces:**
- Produces: `FreightForwarder` Prisma model + regenerated client gain `city`, `postalCode`, `country` (all `String?` → `string | null`). Consumed by Task 3's `rfq.service.ts` mapper (`f.city`, etc.).

- [ ] **Step 1: Ensure the dev database is running**

Run: `docker compose -f docker-compose.dev.yml up -d`
Expected: Postgres container up (port `${DEV_DB_PORT:-5432}`).

- [ ] **Step 2: Add the columns to the schema**

In `prisma/schema.prisma`, in `model FreightForwarder`, add three lines directly after `companyAddress          String?` (align with existing formatting):

```prisma
  city                 String?
  postalCode           String?
  country              String?
```

- [ ] **Step 3: Create and apply the migration (regenerates the client)**

Run: `pnpm exec prisma migrate dev --name add_ff_address_fields --schema prisma/schema.prisma`
Expected: a new `prisma/migrations/<timestamp>_add_ff_address_fields/` folder is created, applied to the dev DB, and the Prisma Client is regenerated. (If it reports drift/shadow-DB issues, resolve per README before continuing — do not use `db push`.)

- [ ] **Step 4: Verify the generated SQL is additive**

Run: `grep -R "ADD COLUMN" prisma/migrations/*add_ff_address_fields*/migration.sql`
Expected: three `ADD COLUMN "city"`, `"postalCode"`, `"country"` statements, all nullable (no `NOT NULL`, no backfill).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add city/postalCode/country columns to FreightForwarder"
```

---

### Task 3: Backend DTO mapper + e2e round-trip

**Files:**
- Modify: `apps/api/src/modules/rfq/rfq.service.ts` (the `ffs.map((f): FreightForwarderDto => ({ … }))` block at ~line 188)
- Test: `apps/api/test/freight-forwarders.e2e-spec.ts` (append one `it` before the final `});` at line 98)

**Interfaces:**
- Consumes: `FreightForwarderDto` (Task 1, from built `dist`), `FreightForwarder` Prisma type with `city/postalCode/country` (Task 2). Requires Tasks 1 and 2 complete.
- Produces: `rfq.service` workspace payload carries the three address fields for each FF. No new exported symbols.

- [ ] **Step 1: Run api typecheck to confirm the red (missing DTO properties)**

Run: `pnpm --filter @svyft/api typecheck`
Expected: FAIL — the object literal at `rfq.service.ts:188` is annotated `(f): FreightForwarderDto` and is now missing `city`, `postalCode`, `country` (TS2739 / "missing the following properties"). This is the failing "test".

- [ ] **Step 2: Add the three fields to the mapper**

In `apps/api/src/modules/rfq/rfq.service.ts`, add three lines directly after `companyAddress: f.companyAddress,`:

```ts
        city: f.city,
        postalCode: f.postalCode,
        country: f.country,
```

- [ ] **Step 3: Run api typecheck to verify it passes**

Run: `pnpm --filter @svyft/api typecheck`
Expected: PASS.

- [ ] **Step 4: Add the e2e round-trip regression test**

In `apps/api/test/freight-forwarders.e2e-spec.ts`, insert this `it` block immediately before the closing `});` of the `describe("FreightForwarders (e2e)", ...)` block (after the "400s an invalid body…" test ends at line 97):

```ts
  it("round-trips the postal address fields (street/city/postal/country)", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({
        ...valid,
        companyName: `${CO} Addr`,
        email: "addr@ff-e2e.example",
        companyAddress: "1 Cargo Way",
        city: "Singapore",
        postalCode: "049145",
        country: "Singapore",
      })
      .expect(201);
    expect(created.body.city).toBe("Singapore");
    expect(created.body.postalCode).toBe("049145");
    expect(created.body.country).toBe("Singapore");
    const read = await request(app.getHttpServer())
      .get(`/api/freight-forwarders/${created.body.id}`)
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(read.body).toMatchObject({
      companyAddress: "1 Cargo Way",
      city: "Singapore",
      postalCode: "049145",
      country: "Singapore",
    });
  });
```

(Distinct `companyName`/`email` avoid the unique-name 409; `afterAll` already cleans up rows with `companyName startsWith "FF E2E Forwarder"`.)

- [ ] **Step 5: Run the FF e2e suite to verify green**

Run: `pnpm --filter @svyft/api exec jest --config test/jest-e2e.json --runInBand freight-forwarders`
Expected: PASS — all FreightForwarders e2e tests including the new round-trip. (Requires the dev DB up and migrated from Task 2.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/rfq/rfq.service.ts apps/api/test/freight-forwarders.e2e-spec.ts
git commit -m "feat(api): carry FF address fields in rfq workspace DTO + e2e round-trip"
```

---

### Task 4: Frontend form — label, fields, layout

**Files:**
- Modify: `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx` (full rewrite of the component body below)
- Modify: `apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx` (the `ff()` factory at lines 10–15 — add the 3 keys so the `FreightForwarderDto` fixture still type-checks)
- Test: `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.test.tsx` (append one `it`)

**Interfaces:**
- Consumes: `FreightForwarderCreateInput` and `FreightForwarderDto` with the new fields (Task 1, from built `dist`). Requires Task 1's `pnpm --filter @svyft/shared build` to have run.
- Produces: no exported symbols; UI change only.

- [ ] **Step 1: Write the failing form test**

In `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.test.tsx`, add this `it` inside the `describe("FreightForwarderFormPage (create)", ...)` block (after the existing "submits a valid FF…" test):

```ts
  it("relabels address to Street Address and submits city/postal/country", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST") {
          body = JSON.parse(init.body as string);
          return { status: 201, body: { id: "f9", freightForwarderCode: "FF-0009" } };
        }
        return { status: 404 };
      }),
    );
    renderForm();
    expect(await screen.findByLabelText(/street address/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/company address/i)).not.toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText(/company name/i), "Acme Freight");
    await userEvent.type(screen.getByLabelText(/person in charge/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+15551234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ops@acme.example");
    await userEvent.type(screen.getByLabelText(/^city$/i), "Singapore");
    await userEvent.type(screen.getByLabelText(/postal code/i), "049145");
    await userEvent.type(screen.getByLabelText(/^country$/i), "Singapore");
    await userEvent.click(screen.getByRole("button", { name: /countries/i }));
    await userEvent.click(await screen.findByText("Singapore"));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /^modes$/i }));
    await userEvent.click(await screen.findByText("AIR"));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("ff list")).toBeInTheDocument());
    expect(body).toMatchObject({ city: "Singapore", postalCode: "049145", country: "Singapore" });
  });
```

- [ ] **Step 2: Run the form test to verify it fails**

Run: `pnpm --filter @svyft/web exec vitest run FreightForwarderFormPage`
Expected: FAIL — no "Street Address" label yet (`findByLabelText(/street address/i)` times out); the current label is "Company address".

- [ ] **Step 3: Rewrite the form component**

Replace the entire contents of `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx` with:

```tsx
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useParams } from "react-router-dom";
import {
  freightForwarderCreateSchema,
  FREIGHT_MODES,
  COUNTRIES,
  CURRENCIES,
  type FreightForwarderCreateInput,
  type CountryCode,
  type CurrencyCode,
} from "@svyft/shared";
import { postJson, patchJson } from "@/lib/api";
import { useFreightForwarder } from "../useMasters";
import { MultiSelectCombobox } from "@/components/MultiSelectCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MODE_OPTS = FREIGHT_MODES.map((m) => ({ code: m, name: m }));
const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const sectionTitleClass = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export function FreightForwarderFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const existing = useFreightForwarder(id);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FreightForwarderCreateInput>({
    resolver: zodResolver(freightForwarderCreateSchema),
    defaultValues: { availableCountries: [], modes: [], handleDg: false },
  });

  useEffect(() => {
    if (existing.data) {
      reset({
        companyName: existing.data.companyName,
        companyAddress: existing.data.companyAddress ?? undefined,
        city: existing.data.city ?? undefined,
        postalCode: existing.data.postalCode ?? undefined,
        country: existing.data.country ?? undefined,
        pic: existing.data.pic,
        contactNumber: existing.data.contactNumber,
        email: existing.data.email,
        availableCountries: existing.data.availableCountries as CountryCode[],
        modes: existing.data.modes,
        handleDg: existing.data.handleDg,
        vatTrnEori: existing.data.vatTrnEori ?? undefined,
        whLocation: existing.data.whLocation ?? undefined,
        defaultCurrency: (existing.data.defaultCurrency ?? undefined) as CurrencyCode | undefined,
        paymentTerms: existing.data.paymentTerms ?? undefined,
        typicalLeadTime: existing.data.typicalLeadTime ?? undefined,
        status: existing.data.status,
      });
    }
  }, [existing.data, reset]);

  async function onSubmit(values: FreightForwarderCreateInput) {
    if (id) await patchJson(`/api/freight-forwarders/${id}`, values);
    else await postJson("/api/freight-forwarders", values);
    navigate("/masters/freight-forwarders");
  }

  const err = (name: keyof FreightForwarderCreateInput) =>
    errors[name] ? (
      <p role="alert" className="text-sm text-destructive">
        {errors[name]?.message as string}
      </p>
    ) : null;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl space-y-6" aria-label="Freight forwarder form">
      <h1 className="font-display text-xl font-semibold tracking-tight">
        {id ? "Edit freight forwarder" : "New freight forwarder"}
      </h1>

      <section className="space-y-3">
        <h2 className={sectionTitleClass}>Company &amp; contact</h2>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="companyName">Company name</Label>
            <Input id="companyName" {...register("companyName")} />
            {err("companyName")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="pic">Person in charge</Label>
            <Input id="pic" {...register("pic")} />
            {err("pic")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="contactNumber">Contact number</Label>
            <Input id="contactNumber" placeholder="+15551234567" {...register("contactNumber")} />
            {err("contactNumber")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input id="email" {...register("email")} />
            {err("email")}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className={sectionTitleClass}>Address</h2>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="companyAddress">Street Address</Label>
            <Input id="companyAddress" {...register("companyAddress")} />
            {err("companyAddress")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="city">City</Label>
            <Input id="city" {...register("city")} />
            {err("city")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="postalCode">Postal code</Label>
            <Input id="postalCode" {...register("postalCode")} />
            {err("postalCode")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="country">Country</Label>
            <Input id="country" {...register("country")} />
            {err("country")}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className={sectionTitleClass}>Service &amp; commercial</h2>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Available countries</Label>
            <Controller
              control={control}
              name="availableCountries"
              render={({ field }) => (
                <MultiSelectCombobox value={field.value ?? []} options={COUNTRIES} onChange={field.onChange} ariaLabel="Countries" />
              )}
            />
            {err("availableCountries")}
          </div>
          <div className="space-y-1">
            <Label>Modes</Label>
            <Controller
              control={control}
              name="modes"
              render={({ field }) => (
                <MultiSelectCombobox value={field.value ?? []} options={MODE_OPTS} onChange={field.onChange} ariaLabel="Modes" />
              )}
            />
            {err("modes")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="defaultCurrency">Default currency</Label>
            <select id="defaultCurrency" {...register("defaultCurrency", { setValueAs: (v: string) => (v === "" ? undefined : v) })} className={selectClass}>
              <option value="">—</option>
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="vatTrnEori">VAT / TRN / EORI</Label>
            <Input id="vatTrnEori" {...register("vatTrnEori")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="whLocation">Warehouse location</Label>
            <Input id="whLocation" {...register("whLocation")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="paymentTerms">Payment terms</Label>
            <Input id="paymentTerms" placeholder="NET 30" {...register("paymentTerms")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="typicalLeadTime">Typical lead time</Label>
            <Input id="typicalLeadTime" placeholder="2d" {...register("typicalLeadTime")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="status">Status</Label>
            <select id="status" {...register("status")} className={selectClass}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </div>
          <label className="flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" {...register("handleDg")} />
            <span className="text-sm">Handles Dangerous Goods (DG)</span>
          </label>
        </div>
      </section>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 4: Run the form test to verify it passes**

Run: `pnpm --filter @svyft/web exec vitest run FreightForwarderFormPage`
Expected: PASS — both the existing tests and the new "relabels address…" test.

- [ ] **Step 5: Fix the `FreightForwarderDto` fixture in FfSelectionGrid.test.tsx**

In `apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx`, update the `ff()` factory (lines 10–15) to include the new keys. Change the `companyAddress: null,` line so the object reads:

```ts
const ff = (id: string, name: string): FreightForwarderDto => ({
  id, freightForwarderCode: id, companyName: name, companyAddress: null,
  city: null, postalCode: null, country: null, pic: "P",
  contactNumber: "+1", email: `${id}@x.com`, availableCountries: ["AE"], modes: ["AIR"],
  handleDg: false, vatTrnEori: null, whLocation: null, defaultCurrency: null,
  paymentTerms: "NET 30", typicalLeadTime: "2d", status: "ACTIVE",
});
```

(The `ffIn` fixture at line 75 spreads `...ff(...)`, so it inherits these automatically — no other fixture edit needed.)

- [ ] **Step 6: Typecheck and run the full web suite**

Run: `pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web test`
Expected: both PASS (typecheck covers `.test.tsx` files, so the fixture fix in Step 5 is required here).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx \
        apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.test.tsx \
        apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx
git commit -m "feat(web): FF form Street Address label + city/postal/country in two-column layout"
```

---

### Task 5: Cross-package verification gate

No new code — this catches any cross-package regression from the type-coupled changes.

- [ ] **Step 1: Ensure shared dist is current**

Run: `pnpm --filter @svyft/shared build`
Expected: success.

- [ ] **Step 2: Typecheck and lint every package**

Run: `pnpm -r run typecheck && pnpm -r run lint`
Expected: all PASS.

- [ ] **Step 3: Run every test suite** (dev DB up for api e2e)

Run: `pnpm --filter @svyft/shared test && pnpm --filter @svyft/web test && pnpm --filter @svyft/api test`
Expected: all PASS.

- [ ] **Step 4: Manual visual check (optional but recommended)**

Start the web dev server and open `/masters/freight-forwarders/new`. Confirm: three logical sections (Company & contact / Address / Service & commercial), two columns, no field spans full width except the lone "Handles DG" checkbox, the address field is labelled **Street Address**, and the form fits without meaningful scrolling. Edit an existing FF and confirm City/Postal code/Country hydrate.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-30-ff-master-address-fields-design.md`):
- §4 Data model → Task 2. ✅
- §5 Shared schema + DTO → Task 1. ✅
- §6 Backend (rfq.service mapper; ff service unchanged) → Task 3. ✅
- §7 Frontend (label rename, 3 fields, reset mapping, 3-section 2-col layout) → Task 4. ✅
- §8 Testing (shared / frontend / e2e / tsc per package) → Tasks 1, 3, 4, 5. ✅
- D1 free-text country → Task 1 (`z.string().max(120)`). ✅  D2 label-only → Task 4 (id stays `companyAddress`). ✅  D3 optional → Task 1. ✅

**Placeholder scan:** none — every code step contains complete content.

**Type consistency:** `city/postalCode/country` are `.optional()` in the schema and `string | null` on the DTO across Tasks 1, 3 (mapper `f.city`), and 4 (fixture `city: null`, reset `?? undefined`). The `FfSelectionGrid` fixture fix (Task 4 Step 5) is the one non-obvious consumer of the DTO shape and is covered.
