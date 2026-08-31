# Master Data Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the six master screens (Client, Freight Forwarder, Vessel, Warehouse, FX Rates, Charge Catalogue) behave as one product — one atomic Save per screen, sectional layout everywhere, contacts and vehicles managed entirely through a dialog, and a mandatory primary contact.

**Architecture:** Each master form becomes a single `react-hook-form` draft that owns its parent fields *and* its child collections (`contacts`, `warehouseIds`, `vehicles`). Nothing touches the network until Save, which sends one POST or PATCH. The API's parent create/update endpoints accept those children and reconcile them in one Prisma transaction, ordered deletes → demotions → promotions so the three partial unique indexes never trip mid-transaction.

**Tech Stack:** React 18 + react-hook-form + Zod (`@hookform/resolvers/zod`) + TanStack Query + shadcn `ui/*` primitives on the web; NestJS + Prisma + Zod on the API; Vitest (web + shared), Jest + supertest (api e2e).

**Spec:** `docs/2026-08-31-master-data-consistency-design.md`. Read it before Task 1 — it records *why* several of these decisions look odd.

## Global Constraints

- **No migration. No `prisma migrate dev`.** Every field surfaced already exists. Running it would propose **dropping** `ClientContact_one_primary`, `FreightForwarderContact_one_primary`, `WarehouseContact_one_primary` and `Warehouse_single_owner`, which are raw-SQL partial indexes Prisma cannot express. If a task appears to need a schema change, stop and escalate.
- **Do not run `prisma format`** — it reformats all 985 lines of `schema.prisma`.
- **Do not touch** `apps/api/src/seed/reference-seed.ts`'s upsert `update: {}` (`deploy.yml:62` runs the seed on every production deploy; a full overwrite silently reverts every admin edit), `deriveZone`/`deriveRole`, `resolveChargeConfig`, `ChargeMatrix.tsx`, `LegSection.tsx`, `RfqPrintView.tsx`, `quote-engine.ts`, or `Step1Client.tsx`. All are Stage-4/5-pass territory.
- **`syncPrimaryContactColumns` stays the sole writer** of `FreightForwarder.pic` / `contactNumber` / `email`. Never set them from form values. `setWarehouses` stays the sole writer of `whLocation`.
- **Do not add a `tagKey` field to the charge-line form.** The expansion design specified one; the build never had it; Stage-4 item 3 may remove the two-gate and `tagKey` with it (design C9).
- **The standalone child endpoints stay** (design C8). `/:id/contacts`, `/:id/warehouses`, `/:id/vehicles` keep their routes, RBAC and specs. The UI stops calling them; do not delete them.
- **Verify the branch before every commit:** `git branch --show-current` must print `claude/master-data-consistency-a920af`. HEAD drifts to `main` in this repo via background pulls.
- **Run `tsc` per task**, not just Vitest — Vitest uses esbuild and does **not** type-check, so type errors pile up silently in test files. Command: `pnpm --filter @svyft/web typecheck` / `pnpm --filter @svyft/api typecheck` / `pnpm --filter @svyft/shared typecheck`.
- **Auth-gated UI tests must await the role-gated element itself.** Never "wait for data, then assert role-gated UI" — that races `AuthProvider` and is the shape that failed CI on PR #54. Use `await screen.findByRole("button", { name: /save/i })`, not `await waitFor(() => expect(fetch).toHaveBeenCalled())` followed by a sync `getByRole`.
- **Local DB is port 5433**, container `svyft-postgres-task4`. `apps/api/.env` is gitignored and does not travel with a worktree — create it before the first api e2e run.
- **BSD `sed` on macOS ignores `\b`.** Use python or perl for boundary-aware replaces.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/web/src/features/masters/form/MasterForm.tsx` | Page chrome: title, error region, banner slot, footer Save/Cancel |
| `apps/web/src/features/masters/form/FormSection.tsx` | One titled section + its 2-col grid |
| `apps/web/src/features/masters/form/Field.tsx` | Label + control + inline error |
| `apps/web/src/features/masters/form/SelectField.tsx` | `ui/select` wrapper, retires four copies of `selectClass` |
| `apps/web/src/features/masters/form/index.ts` | Barrel |
| `apps/web/src/features/masters/contacts/ContactsSection.tsx` | Read-only contacts table + Add button; owns dialog open state |
| `apps/web/src/features/masters/contacts/ContactDialog.tsx` | The only place a contact is added, edited or removed |
| `apps/web/src/features/masters/warehouses/VehiclesSection.tsx` | Same pattern for `WarehouseVehicle` |
| `apps/web/src/features/masters/warehouses/VehicleDialog.tsx` | Vehicle add/edit/remove |
| `apps/web/src/features/masters/fx-rates/FxRateFormPage.tsx` | The `/masters/fx-rates/new` screen |
| `apps/api/src/common/reconcile-contacts.ts` | Shared, owner-agnostic contact reconciliation |
| `apps/api/test/helpers/client.ts` | `clientFixture()` / `clientCreateBody()` |
| `apps/api/test/helpers/warehouse.ts` | `warehouseCreateBody()` |

**Modified:** `packages/shared/src/masters/{contacts,client,warehouse,freight-forwarder}.ts`; `apps/api/src/modules/{clients,warehouses,freight-forwarders}/*.service.ts` + `*.controller.ts`; `apps/web/src/lib/api.ts`; all six master form pages; `ChargeCatalogueListPage.tsx`; `App.tsx`.

**Deleted:** `apps/web/src/features/masters/ContactList.tsx`, `ContactRow.tsx` and their tests (replaced by `contacts/`).

---

### Task 1: Fix `raise()` so an empty server message does not render blank

Spec C10. Every form in this plan collapses its error slots into one region; that region must never render nothing on a real failure.

**Files:**
- Modify: `apps/web/src/lib/api.ts:55-57`
- Test: `apps/web/src/lib/api.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. `ApiError.message` is now guaranteed non-empty.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError, fetchJson } from "./api";

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => body,
    } as unknown as Response),
  );
}

describe("raise()", () => {
  it("falls back to a status message when the server sends an empty message", async () => {
    stub(409, { message: "" });
    await expect(fetchJson("/api/clients")).rejects.toMatchObject({
      status: 409,
      message: "Request failed: 409",
    });
  });

  it("falls back when the message is whitespace only", async () => {
    stub(400, { message: "   " });
    await expect(fetchJson("/api/clients")).rejects.toMatchObject({
      message: "Request failed: 400",
    });
  });

  it("preserves a real server message", async () => {
    stub(409, { message: "This client already has a primary contact" });
    await expect(fetchJson("/api/clients")).rejects.toMatchObject({
      message: "This client already has a primary contact",
    });
  });

  it("still produces an ApiError", async () => {
    stub(500, {});
    await expect(fetchJson("/api/clients")).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run it and confirm the first two fail**

Run: `pnpm --filter @svyft/web test -- src/lib/api.test.ts`
Expected: FAIL — received `message: ""` and `message: "   "`, because `??` only catches `null`/`undefined`.

- [ ] **Step 3: Implement**

Replace the `throw new ApiError(...)` call in `raise()`:

```ts
  // `??` alone is not enough: an empty or whitespace-only `message` is a *present* string, so
  // it passes the nullish check and renders as a blank alert. Every master form now shows one
  // consolidated error region, and a blank region on a real failure is worse than no region.
  const rawMessage = (body as Record<string, unknown> | undefined)?.message;
  const message =
    typeof rawMessage === "string" && rawMessage.trim() !== ""
      ? rawMessage
      : `Request failed: ${res.status}`;

  throw new ApiError(res.status, message, findings, issues, body);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test -- src/lib/api.test.ts && pnpm --filter @svyft/web typecheck`
Expected: 4 passed, no type errors.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts
git commit -m "fix(web): empty server message no longer renders a blank alert"
```

---

### Task 2: Shared form shell

**Files:**
- Create: `apps/web/src/features/masters/form/{MasterForm,FormSection,Field,SelectField,index}.tsx`
- Test: `apps/web/src/features/masters/form/MasterForm.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MasterForm(props: { title: string; error?: string | null; banner?: ReactNode; onSubmit: () => void; isSubmitting: boolean; onCancel: () => void; children: ReactNode })`
  - `FormSection(props: { title: string; children: ReactNode })`
  - `Field(props: { id: string; label: string; error?: string; children: ReactNode; className?: string })`
  - `SelectField(props: { id: string; label: string; error?: string; options: { value: string; label: string }[]; placeholder?: string; registration: UseFormRegisterReturn })`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MasterForm, FormSection, Field } from "./index";

describe("MasterForm", () => {
  it("renders the title, one alert region, and Save/Cancel", async () => {
    render(
      <MasterForm
        title="New client"
        error="Boom"
        onSubmit={vi.fn()}
        isSubmitting={false}
        onCancel={vi.fn()}
      >
        <FormSection title="Company">
          <Field id="companyName" label="Company name" error="Required">
            <input id="companyName" />
          </Field>
        </FormSection>
      </MasterForm>,
    );
    expect(screen.getByRole("heading", { name: "New client" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    // Exactly two alerts: the form-level one and the field-level one. This is the assertion
    // that would catch a regression back to a single page-level error summary — the masters
    // branch tried that and reversed it, because it left a 20-field form with no error
    // attached to any field.
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByLabelText("Company name")).toBeInTheDocument();
  });

  it("disables Save and shows progress while submitting", () => {
    render(
      <MasterForm title="T" onSubmit={vi.fn()} isSubmitting onCancel={vi.fn()}>
        <p>body</p>
      </MasterForm>,
    );
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
  });

  it("calls onCancel without submitting", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <MasterForm title="T" onSubmit={onSubmit} isSubmitting={false} onCancel={onCancel}>
        <p>body</p>
      </MasterForm>,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @svyft/web test -- src/features/masters/form/MasterForm.test.tsx`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: Implement the four components**

`Field.tsx`:

```tsx
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

export function Field({
  id,
  label,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
```

`FormSection.tsx`:

```tsx
import type { ReactNode } from "react";

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}
```

`SelectField.tsx`:

```tsx
import type { UseFormRegisterReturn } from "react-hook-form";
import { Field } from "./Field";

// The one place the master forms describe a <select>. Four files previously carried their own
// copy of this class string; changing focus rings meant changing four files.
const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function SelectField({
  id,
  label,
  error,
  options,
  placeholder,
  registration,
  className,
}: {
  id: string;
  label: string;
  error?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  registration: UseFormRegisterReturn;
  className?: string;
}) {
  return (
    <Field id={id} label={label} error={error} className={className}>
      <select id={id} className={selectClass} {...registration}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
```

`MasterForm.tsx`:

```tsx
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function MasterForm({
  title,
  error,
  banner,
  onSubmit,
  isSubmitting,
  onCancel,
  children,
}: {
  title: string;
  error?: string | null;
  banner?: ReactNode;
  onSubmit: () => void;
  isSubmitting: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      aria-label={title}
      className="max-w-3xl space-y-6"
    >
      <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {banner}
      {children}
      <div className="flex gap-2 border-t border-border pt-4">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
```

`index.ts`:

```ts
export { MasterForm } from "./MasterForm";
export { FormSection } from "./FormSection";
export { Field } from "./Field";
export { SelectField } from "./SelectField";
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test -- src/features/masters/form && pnpm --filter @svyft/web typecheck`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters/form
git commit -m "feat(web): shared master-form shell"
```

---

### Task 3: Shared schemas — contact upsert and composite payloads

**Files:**
- Modify: `packages/shared/src/masters/contacts.ts`, `client.ts`, `warehouse.ts`, `freight-forwarder.ts`
- Test: `packages/shared/src/masters/contacts.test.ts` (extend), `client.test.ts` (create)

**Interfaces:**
- Consumes: existing `contactCoreSchema`.
- Produces:
  - `contactUpsertSchema`, `type ContactUpsertInput = z.input<...>`, `type ContactUpsert = z.output<...>` (all defaults applied — services use this one)
  - `exactlyOnePrimary(contacts): boolean`, `atMostOnePrimary(contacts): boolean`
  - `clientCreateSchema` gains required `contacts` + optional `warehouseIds`; `clientUpdateSchema` gains optional both
  - `warehouseCreateSchema` gains required `contacts` + optional `vehicles`; update gains optional both
  - `freightForwarderCreateSchema`/`UpdateSchema` gain **optional** `contacts` + optional `warehouseIds`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/masters/contacts.test.ts`:

```ts
import { contactUpsertSchema, exactlyOnePrimary, atMostOnePrimary } from "./contacts";

describe("contactUpsertSchema", () => {
  it("accepts an existing contact carrying an id", () => {
    const parsed = contactUpsertSchema.parse({
      id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      name: "Asha Menon",
      email: "asha@example.com",
      contactNo: "+971501234567",
    });
    expect(parsed.id).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(parsed.pocLevel).toBe("NONE"); // default applied on the output type
  });

  it("accepts a new contact with no id", () => {
    expect(
      contactUpsertSchema.safeParse({
        name: "New Person",
        email: "new@example.com",
        contactNo: "+971501234567",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid id", () => {
    expect(
      contactUpsertSchema.safeParse({
        id: "not-a-uuid",
        name: "X",
        email: "x@example.com",
        contactNo: "+971501234567",
      }).success,
    ).toBe(false);
  });
});

describe("primary-count predicates", () => {
  const at = (level: string) => ({ pocLevel: level as never });

  it("exactlyOnePrimary is true for exactly one", () => {
    expect(exactlyOnePrimary([at("PRIMARY"), at("SECONDARY")])).toBe(true);
  });
  it("exactlyOnePrimary is false for none", () => {
    expect(exactlyOnePrimary([at("SECONDARY"), at("NONE")])).toBe(false);
  });
  it("exactlyOnePrimary is false for two", () => {
    expect(exactlyOnePrimary([at("PRIMARY"), at("PRIMARY")])).toBe(false);
  });
  it("atMostOnePrimary allows zero", () => {
    expect(atMostOnePrimary([at("NONE")])).toBe(true);
  });
  it("atMostOnePrimary rejects two", () => {
    expect(atMostOnePrimary([at("PRIMARY"), at("PRIMARY")])).toBe(false);
  });
});
```

Create `packages/shared/src/masters/client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clientCreateSchema, clientUpdateSchema } from "./client";

const base = {
  companyName: "Acme",
  country: "AE",
  streetAddress: "1 Road",
  city: "Dubai",
};
const contact = {
  name: "Asha",
  email: "asha@example.com",
  contactNo: "+971501234567",
  pocLevel: "PRIMARY" as const,
};

describe("clientCreateSchema", () => {
  it("accepts a payload with exactly one primary contact", () => {
    expect(clientCreateSchema.safeParse({ ...base, contacts: [contact] }).success).toBe(true);
  });

  it("rejects a payload with no contacts at all", () => {
    expect(clientCreateSchema.safeParse({ ...base, contacts: [] }).success).toBe(false);
  });

  it("rejects a payload whose contacts have no primary", () => {
    expect(
      clientCreateSchema.safeParse({ ...base, contacts: [{ ...contact, pocLevel: "NONE" }] })
        .success,
    ).toBe(false);
  });

  it("rejects two primaries", () => {
    expect(
      clientCreateSchema.safeParse({ ...base, contacts: [contact, { ...contact, email: "b@x.com" }] })
        .success,
    ).toBe(false);
  });

  it("accepts optional warehouseIds", () => {
    const r = clientCreateSchema.safeParse({
      ...base,
      contacts: [contact],
      warehouseIds: ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    });
    expect(r.success).toBe(true);
  });
});

describe("clientUpdateSchema", () => {
  it("accepts a patch with no contacts key at all", () => {
    expect(clientUpdateSchema.safeParse({ companyName: "Renamed" }).success).toBe(true);
  });

  it("accepts a patch whose contacts have NO primary — the banner case, not a block", () => {
    expect(
      clientUpdateSchema.safeParse({ contacts: [{ ...contact, pocLevel: "NONE" }] }).success,
    ).toBe(true);
  });

  it("rejects a patch with two primaries", () => {
    expect(
      clientUpdateSchema.safeParse({ contacts: [contact, { ...contact, email: "b@x.com" }] })
        .success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/shared test -- src/masters`
Expected: FAIL — `contactUpsertSchema is not exported`, and `clientCreateSchema` currently accepts a payload with no `contacts`.

- [ ] **Step 3: Implement**

In `contacts.ts`, after the existing `contactUpdateSchema`:

```ts
/**
 * A contact as it arrives inside a parent's composite create/update payload. `id` present means
 * "update this existing row"; absent means "create". A contact omitted from the array is
 * deleted — see reconcileContacts on the API side.
 */
export const contactUpsertSchema = contactCoreSchema.extend({
  id: z.string().uuid().optional(),
});
export type ContactUpsertInput = z.input<typeof contactUpsertSchema>;
/** Post-parse shape: every `.default()` applied. Services should use THIS, not the input type,
 *  so `pocLevel` is always a real value and never needs a `?? "NONE"` fallback. */
export type ContactUpsert = z.output<typeof contactUpsertSchema>;

const primaryCount = (contacts: { pocLevel?: PocLevel }[]): number =>
  contacts.filter((c) => c.pocLevel === PocLevel.PRIMARY).length;

/** Create-time rule: a new Client/Warehouse must name exactly one primary contact. */
export const exactlyOnePrimary = (contacts: { pocLevel?: PocLevel }[]): boolean =>
  primaryCount(contacts) === 1;

/** Update-time rule: never two, but zero is allowed — a record that pre-dates the rule stays
 *  editable and is nudged by a banner instead of blocked (design C4). */
export const atMostOnePrimary = (contacts: { pocLevel?: PocLevel }[]): boolean =>
  primaryCount(contacts) <= 1;

export const PRIMARY_REQUIRED_MESSAGE = "Exactly one contact must be marked Primary";
export const PRIMARY_DUPLICATE_MESSAGE = "Only one contact can be marked Primary";
```

In `client.ts`, restructure so create and update carry different child rules:

```ts
import {
  MASTER_STATUSES,
  contactUpsertSchema,
  exactlyOnePrimary,
  atMostOnePrimary,
  PRIMARY_REQUIRED_MESSAGE,
  PRIMARY_DUPLICATE_MESSAGE,
  type MasterStatus,
  type ContactDto,
} from "./contacts";

const statusField = z.enum(MASTER_STATUSES as [MasterStatus, ...MasterStatus[]]).optional();

const clientCore = z.object({
  companyName: z.string().min(1).max(200),
  industry: z.string().max(120).optional(),
  country: z.string().min(1).max(120),
  streetAddress: z.string().min(1).max(300),
  city: z.string().min(1).max(120),
  postalCode: z.string().max(20).optional(),
  status: statusField,
});

const warehouseIdsField = z.array(z.string().uuid()).optional();

export const clientCreateSchema = clientCore.extend({
  contacts: z
    .array(contactUpsertSchema)
    .min(1)
    .refine(exactlyOnePrimary, { message: PRIMARY_REQUIRED_MESSAGE }),
  warehouseIds: warehouseIdsField,
});

// NOT `clientCreateSchema.partial()`: that would keep the create-time min(1)/exactly-one rule
// on the array itself, blocking every legacy client that has no primary from ever being saved.
export const clientUpdateSchema = clientCore.partial().extend({
  contacts: z
    .array(contactUpsertSchema)
    .refine(atMostOnePrimary, { message: PRIMARY_DUPLICATE_MESSAGE })
    .optional(),
  warehouseIds: warehouseIdsField,
});
```

Keep `ClientCreateInput` / `ClientUpdateInput` / `ClientDto` exactly as they are (they still `z.infer` off the two schemas).

In `warehouse.ts`, apply the identical treatment: `warehouseCreateSchema` gains

```ts
  contacts: z
    .array(contactUpsertSchema)
    .min(1)
    .refine(exactlyOnePrimary, { message: PRIMARY_REQUIRED_MESSAGE }),
  vehicles: z.array(warehouseVehicleSchema.extend({ id: z.string().uuid().optional() })).optional(),
```

and the update schema gains the `atMostOnePrimary`, `.optional()` variants of both. Export
`export const warehouseVehicleUpsertSchema = warehouseVehicleSchema.extend({ id: z.string().uuid().optional() });`
and `export type WarehouseVehicleUpsert = z.output<typeof warehouseVehicleUpsertSchema>;` so the
API and web share one name.

**Keep `warehouseCreateSchema`'s existing `superRefine(refineWarehouseInvariants)` attached** — add the child fields to the object *before* the `superRefine`, or it is silently dropped.

In `freight-forwarder.ts`, both schemas gain **optional** children (design §4.4 — FF create stays backward-compatible so no FF spec changes):

```ts
  contacts: z
    .array(contactUpsertSchema)
    .refine(atMostOnePrimary, { message: PRIMARY_DUPLICATE_MESSAGE })
    .optional(),
  warehouseIds: z.array(z.string().uuid()).optional(),
```

`freightForwarderUpdateSchema` keeps its existing `.omit({ pic, contactNumber, email, whLocation })`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/shared test && pnpm --filter @svyft/shared typecheck`
Expected: all pass. `pnpm --filter @svyft/api typecheck` will now show errors in the three controllers — that is expected and is Tasks 4–6's job.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add packages/shared/src/masters
git commit -m "feat(shared): contact upsert + composite create/update payloads"
```

---

### Task 4: Shared contact reconciliation + Client composite endpoint

**Files:**
- Create: `apps/api/src/common/reconcile-contacts.ts`, `apps/api/test/helpers/client.ts`
- Modify: `apps/api/src/modules/clients/clients.service.ts`, `clients.controller.ts`
- Test: `apps/api/test/clients-composite.e2e-spec.ts` (create); update 11 create sites in `clients.e2e-spec.ts` (6), `clients-address.e2e-spec.ts` (3), `master-audit.e2e-spec.ts` (1), `warehouse-linking.e2e-spec.ts` (1)

**Interfaces:**
- Consumes: `contactUpsertSchema`, `ContactUpsert`, `PRIMARY_DUPLICATE_MESSAGE` from Task 3.
- Produces:
  - `reconcileContacts(opts: { delegate: ContactDelegate; ownerKey: string; ownerId: string; contacts: ContactUpsert[]; user?: RequestUser }): Promise<void>` — used unchanged by Tasks 5 and 6
  - `interface ContactDelegate` — the structural subset of a Prisma contact delegate
  - `clientCreateBody(overrides?): Record<string, unknown>` in `test/helpers/client.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/clients-composite.e2e-spec.ts`. Copy the `beforeAll`/`afterAll`/`cookie` boilerplate from `clients.e2e-spec.ts:1-45` verbatim (same app bootstrap, same `CodeSequence` upsert, same cleanup), with `const CO = "Clients Composite E2E Co";` then:

```ts
  it("creates a client and its contacts in one request", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        clientCreateBody({
          companyName: `${CO} A`,
          contacts: [
            { name: "Primary P", email: "p@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
            { name: "Second S", email: "s@x.com", contactNo: "+971501234568", pocLevel: "SECONDARY" },
          ],
        }),
      )
      .expect(201);

    const contacts = await prisma.clientContact.findMany({ where: { clientId: res.body.id } });
    expect(contacts).toHaveLength(2);
    expect(contacts.filter((c) => c.pocLevel === "PRIMARY")).toHaveLength(1);
  });

  it("400s a create with no primary contact", async () => {
    await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        clientCreateBody({
          companyName: `${CO} B`,
          contacts: [{ name: "N", email: "n@x.com", contactNo: "+971501234567", pocLevel: "NONE" }],
        }),
      )
      .expect(400);
  });

  // The ordering test. A single PATCH that BOTH demotes the incumbent and promotes another
  // must succeed: applied naively (promote first) it violates ClientContact_one_primary
  // mid-transaction, on a payload that is perfectly valid as a whole.
  it("swaps the primary in one request without tripping the partial unique index", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        clientCreateBody({
          companyName: `${CO} C`,
          contacts: [
            { name: "Old P", email: "old@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
            { name: "New P", email: "new@x.com", contactNo: "+971501234568", pocLevel: "SECONDARY" },
          ],
        }),
      )
      .expect(201);

    const before = await prisma.clientContact.findMany({
      where: { clientId: created.body.id },
      orderBy: { createdAt: "asc" },
    });
    const [oldP, newP] = before;

    await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          { id: oldP.id, name: oldP.name, email: oldP.email, contactNo: oldP.contactNo, pocLevel: "SECONDARY" },
          { id: newP.id, name: newP.name, email: newP.email, contactNo: newP.contactNo, pocLevel: "PRIMARY" },
        ],
      })
      .expect(200);

    const after = await prisma.clientContact.findMany({ where: { clientId: created.body.id } });
    expect(after.find((c) => c.id === newP.id)?.pocLevel).toBe("PRIMARY");
    expect(after.find((c) => c.id === oldP.id)?.pocLevel).toBe("SECONDARY");
  });

  it("deletes a contact omitted from the array", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        clientCreateBody({
          companyName: `${CO} D`,
          contacts: [
            { name: "Keep", email: "k@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
            { name: "Drop", email: "d@x.com", contactNo: "+971501234568", pocLevel: "NONE" },
          ],
        }),
      )
      .expect(201);
    const rows = await prisma.clientContact.findMany({ where: { clientId: created.body.id } });
    const keep = rows.find((c) => c.name === "Keep")!;

    await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          { id: keep.id, name: keep.name, email: keep.email, contactNo: keep.contactNo, pocLevel: "PRIMARY" },
        ],
      })
      .expect(200);

    expect(await prisma.clientContact.count({ where: { clientId: created.body.id } })).toBe(1);
  });

  it("409s two primaries with the real message, not a column name", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(clientCreateBody({ companyName: `${CO} E` }))
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          { name: "P1", email: "p1@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
          { name: "P2", email: "p2@x.com", contactNo: "+971501234568", pocLevel: "PRIMARY" },
        ],
      });
    // 400 from the Zod refine is the first gate; the service's query-before-write 409 is the
    // backstop for a caller that bypasses the schema. Either is correct; the message must
    // never be a bare column name.
    expect([400, 409]).toContain(res.status);
    expect(String(res.body.message)).not.toBe("clientId");
  });

  it("leaves a legacy client with no primary contact saveable", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/clients")
      .set("Cookie", cookie(Role.MANAGER))
      .send(clientCreateBody({ companyName: `${CO} F` }))
      .expect(201);
    // Simulate a pre-rule row by clearing its primary directly.
    await prisma.clientContact.updateMany({
      where: { clientId: created.body.id },
      data: { pocLevel: "NONE" },
    });

    await request(app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({ companyName: `${CO} F renamed` })
      .expect(200);
  });
```

Create `apps/api/test/helpers/client.ts`:

```ts
import { randomUUID } from "node:crypto";

/**
 * A complete, valid POST /api/clients body. Task 3 made `contacts` required with exactly one
 * PRIMARY, which breaks 11 existing create sites that rightly do not care about contacts.
 * Same precedent and same reasoning as `ffFixture` in ./freight-forwarder.ts: state the
 * defaults once here rather than restating a contact block at every call site.
 */
export function clientCreateBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const suffix = randomUUID();
  return {
    companyName: `Fixture Client ${suffix}`,
    country: "AE",
    streetAddress: "1 Fixture Way",
    city: "Fixture City",
    contacts: [
      {
        name: "Fixture Primary",
        email: `fixture-${suffix}@e2e.test`,
        contactNo: "+971501234567",
        pocLevel: "PRIMARY",
      },
    ],
    ...overrides,
  };
}
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/api test -- clients-composite`
Expected: FAIL — the create returns 201 but writes zero contacts (the service ignores the key), and the swap PATCH 500s or leaves both rows unchanged.

- [ ] **Step 3: Implement `reconcile-contacts.ts`**

```ts
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PocLevel, PRIMARY_DUPLICATE_MESSAGE, type ContactUpsert } from "@svyft/shared";
import { auditCreate, auditUpdate } from "./audit";
import type { RequestUser } from "../modules/auth/types";

/**
 * The structural subset of a Prisma contact delegate this module needs. Declared structurally
 * rather than importing Prisma's three generated delegate types so ClientContact,
 * FreightForwarderContact and WarehouseContact share one implementation — the three tables have
 * identical columns (design D5/D6) and differ only in their owner FK.
 */
export interface ContactDelegate {
  findMany(args: { where: Record<string, string> }): Promise<{ id: string }[]>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

function row(c: ContactUpsert): Record<string, unknown> {
  const { id: _id, ...rest } = c;
  return rest;
}

const isPrimary = (c: ContactUpsert) => c.pocLevel === PocLevel.PRIMARY;

/**
 * Reconcile one owner's contact list to exactly `contacts`. MUST be called inside the caller's
 * transaction, with `delegate` taken from that transaction client.
 *
 * Write order is deletes -> demotions -> promotions -> creates, and that order is the whole
 * point. `<Owner>Contact_one_primary` is a partial unique index, so a payload that swaps which
 * contact is primary is valid as a whole but violates the index at every intermediate state if
 * the promotion lands before the demotion. Reordering these four blocks reintroduces a bug that
 * only appears on a swap, never on a plain edit.
 */
export async function reconcileContacts(opts: {
  delegate: ContactDelegate;
  ownerKey: string;
  ownerId: string;
  contacts: ContactUpsert[];
  user?: RequestUser;
}): Promise<void> {
  const { delegate, ownerKey, ownerId, contacts, user } = opts;

  // Query-before-write rather than catching P2002. Prisma reports the violated partial index as
  // its COLUMN list (["clientId"]), never the index name, so a caught conflict cannot be told
  // apart from any other unique violation on that column — the reason the old mapUnique
  // `one_primary` branch was dead code. Checking here gives the user a real message.
  if (contacts.filter(isPrimary).length > 1) {
    throw new ConflictException(PRIMARY_DUPLICATE_MESSAGE);
  }

  const existing = await delegate.findMany({ where: { [ownerKey]: ownerId } });
  const existingIds = new Set(existing.map((c) => c.id));
  const keptIds = new Set(
    contacts.map((c) => c.id).filter((id): id is string => typeof id === "string"),
  );

  for (const id of keptIds) {
    if (!existingIds.has(id)) {
      throw new NotFoundException("Contact not found on this record");
    }
  }

  // 1. deletes
  const removed = [...existingIds].filter((id) => !keptIds.has(id));
  if (removed.length > 0) {
    await delegate.deleteMany({ where: { id: { in: removed } } });
  }

  // 2. demotions — every surviving row that is NOT becoming primary is written first, which
  //    frees the index before step 3 claims it.
  for (const c of contacts) {
    if (!c.id || isPrimary(c)) continue;
    await delegate.update({ where: { id: c.id }, data: { ...row(c), ...auditUpdate(user) } });
  }

  // 3. promotions on existing rows
  for (const c of contacts) {
    if (!c.id || !isPrimary(c)) continue;
    await delegate.update({ where: { id: c.id }, data: { ...row(c), ...auditUpdate(user) } });
  }

  // 4. creates, non-primary first for the same index reason
  const fresh = contacts.filter((c) => !c.id);
  for (const c of [...fresh.filter((f) => !isPrimary(f)), ...fresh.filter(isPrimary)]) {
    await delegate.create({
      data: { [ownerKey]: ownerId, ...row(c), ...auditCreate(user) },
    });
  }
}
```

- [ ] **Step 4: Wire it into `ClientsService`**

Replace `create` and `update`. Split the children off the parent payload before the Prisma write — `Client` has no `contacts`/`warehouseIds` scalar columns, so passing them through would throw.

```ts
  async create(input: ClientCreateInput, user?: RequestUser) {
    const { contacts, warehouseIds, ...fields } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.codeSequence.upsert({
          where: { key: "CLIENT" },
          create: { key: "CLIENT", lastNumber: 1 },
          update: { lastNumber: { increment: 1 } },
        });
        const clientCode = `CL-${String(row.lastNumber).padStart(4, "0")}`;
        const client = await tx.client.create({
          data: { clientCode, ...fields, ...auditCreate(user) },
        });
        await reconcileContacts({
          delegate: tx.clientContact as unknown as ContactDelegate,
          ownerKey: "clientId",
          ownerId: client.id,
          contacts,
          user,
        });
        if (warehouseIds) await this.setWarehousesTx(tx, client.id, warehouseIds, user);
        return client;
      });
    } catch (e) {
      throw this.mapUnique(e, "A client with that company name already exists");
    }
  }

  async update(id: string, input: ClientUpdateInput, user?: RequestUser) {
    await this.get(id);
    const { contacts, warehouseIds, ...fields } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const client = await tx.client.update({
          where: { id },
          data: { ...fields, ...auditUpdate(user) },
        });
        if (contacts) {
          await reconcileContacts({
            delegate: tx.clientContact as unknown as ContactDelegate,
            ownerKey: "clientId",
            ownerId: id,
            contacts,
            user,
          });
        }
        if (warehouseIds) await this.setWarehousesTx(tx, id, warehouseIds, user);
        return client;
      });
    } catch (e) {
      throw this.mapUnique(e, "A client with that company name already exists");
    }
  }
```

Extract the body of the existing `setWarehouses` into a private `setWarehousesTx(tx, clientId, warehouseIds, user)` that takes a transaction client, and make the existing public `setWarehouses` call it inside its own `$transaction`. That keeps `PUT /:id/warehouses` (design C8) working unchanged while letting the composite path reuse the same contested-ownership logic.

Then **delete the dead `clientId` branch** from `mapUnique` and its comment — `reconcileContacts` now raises that 409 itself, and leaving the branch in place makes dead code look load-bearing.

- [ ] **Step 5: Update the 11 existing create sites**

In `clients.e2e-spec.ts`, `clients-address.e2e-spec.ts`, `master-audit.e2e-spec.ts` and `warehouse-linking.e2e-spec.ts`, import `clientCreateBody` from `./helpers/client` and wrap each `POST /api/clients` body:

```ts
// before
.send({ companyName: `${CO} X`, country: "IN", streetAddress: "1 A", city: "B" })
// after
.send(clientCreateBody({ companyName: `${CO} X`, country: "IN", streetAddress: "1 A", city: "B" }))
```

Leave the 403/401 auth-check sites alone if they assert a rejection *before* validation — but re-run them and wrap any that now return 400 instead of the expected 403. Do **not** touch the 7 Prisma-direct `prisma.client.create()` calls in other specs; those bypass Zod and are unaffected.

- [ ] **Step 6: Run the full api suite + typecheck**

Run: `pnpm --filter @svyft/api test && pnpm --filter @svyft/api typecheck`
Expected: all green, including the 6 new composite tests.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add apps/api/src/common/reconcile-contacts.ts apps/api/src/modules/clients apps/api/test
git commit -m "feat(api): composite client create/update with contact reconciliation"
```

---

### Task 5: Warehouse composite endpoint (contacts + vehicles)

**Files:**
- Create: `apps/api/test/helpers/warehouse.ts`, `apps/api/test/warehouses-composite.e2e-spec.ts`
- Modify: `apps/api/src/modules/warehouses/warehouses.service.ts`
- Test: update 11 create sites in `warehouses.e2e-spec.ts` (10) and `warehouse-linking.e2e-spec.ts` (1)

**Interfaces:**
- Consumes: `reconcileContacts`, `ContactDelegate` (Task 4); `warehouseVehicleUpsertSchema`, `WarehouseVehicleUpsert` (Task 3).
- Produces: `warehouseCreateBody(overrides?)` in `test/helpers/warehouse.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/warehouses-composite.e2e-spec.ts`. Copy the `process.env.JWT_ACCESS_SECRET` line, the imports, and the `beforeAll`/`afterAll`/`cookie` block from `warehouses.e2e-spec.ts:1-45` verbatim (same app bootstrap, same cleanup predicate), then `const WH = "WH Composite E2E";` and these cases:

```ts
  it("creates a warehouse with contacts and vehicles in one request", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        warehouseCreateBody({
          name: `${WH} A`,
          vehicles: [
            { tonnage: "10T", quantity: 3 },
            { tonnage: "3T", quantity: 1 },
          ],
        }),
      )
      .expect(201);

    expect(await prisma.warehouseContact.count({ where: { warehouseId: res.body.id } })).toBe(1);
    expect(await prisma.warehouseVehicle.count({ where: { warehouseId: res.body.id } })).toBe(2);
  });

  it("400s a create with no primary contact", async () => {
    await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        warehouseCreateBody({
          name: `${WH} B`,
          contacts: [{ name: "N", email: "n@x.com", contactNo: "+971501234567", pocLevel: "NONE" }],
        }),
      )
      .expect(400);
  });

  it("removes a vehicle omitted from the array and keeps the rest", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        warehouseCreateBody({
          name: `${WH} C`,
          vehicles: [
            { tonnage: "10T", quantity: 3 },
            { tonnage: "3T", quantity: 1 },
          ],
        }),
      )
      .expect(201);
    const rows = await prisma.warehouseVehicle.findMany({
      where: { warehouseId: created.body.id },
    });
    const keep = rows.find((v) => v.tonnage === "10T")!;

    await request(app.getHttpServer())
      .patch(`/api/warehouses/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({ vehicles: [{ id: keep.id, tonnage: "10T", quantity: 5 }] })
      .expect(200);

    const after = await prisma.warehouseVehicle.findMany({
      where: { warehouseId: created.body.id },
    });
    expect(after).toHaveLength(1);
    expect(after[0].quantity).toBe(5);
  });

  // The contract-invariant regression guard: superRefine must still be attached after Task 3
  // added child fields to the object.
  it("still rejects an OWNED warehouse with no agreement date", async () => {
    await request(app.getHttpServer())
      .post("/api/warehouses")
      .set("Cookie", cookie(Role.MANAGER))
      .send(warehouseCreateBody({ name: `${WH} D`, type: "OWNED", agreementValidUntil: undefined }))
      .expect(400);
  });
```

Create `apps/api/test/helpers/warehouse.ts`:

```ts
import { randomUUID } from "node:crypto";

/**
 * A complete, valid POST /api/warehouses body. Task 3 made `contacts` required with exactly one
 * PRIMARY, breaking 11 create sites that do not care about contacts. Same precedent as
 * `clientCreateBody` and `ffFixture`.
 *
 * `type: "CLIENT"` deliberately: OWNED and CONTRACTED carry the agreement/insurance-date
 * invariant (refineWarehouseInvariants), so a fixture defaulting to either would force every
 * caller to supply dates it does not care about.
 */
export function warehouseCreateBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const suffix = randomUUID();
  return {
    name: `Fixture Warehouse ${suffix}`,
    type: "CLIENT",
    streetAddress: "1 Fixture Way",
    country: "Fixture Country",
    city: "Fixture City",
    pinCode: "00000",
    capacity: 100,
    capacityUnit: "CBM",
    contacts: [
      {
        name: "Fixture Primary",
        email: `wh-fixture-${suffix}@e2e.test`,
        contactNo: "+971501234567",
        pocLevel: "PRIMARY",
      },
    ],
    ...overrides,
  };
}
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/api test -- warehouses-composite`
Expected: FAIL — contacts and vehicles counts are 0.

- [ ] **Step 3: Implement**

Add a `reconcileVehicles` private method to `WarehousesService` (vehicles have no partial index, so plain delete-then-upsert is safe and no ordering matters):

```ts
  private async reconcileVehicles(
    tx: Prisma.TransactionClient,
    warehouseId: string,
    vehicles: WarehouseVehicleUpsert[],
  ) {
    const existing = await tx.warehouseVehicle.findMany({ where: { warehouseId } });
    const keptIds = new Set(
      vehicles.map((v) => v.id).filter((id): id is string => typeof id === "string"),
    );
    for (const id of keptIds) {
      if (!existing.some((e) => e.id === id)) {
        throw new NotFoundException("Vehicle not found on this warehouse");
      }
    }
    const removed = existing.filter((e) => !keptIds.has(e.id)).map((e) => e.id);
    if (removed.length > 0) {
      await tx.warehouseVehicle.deleteMany({ where: { id: { in: removed } } });
    }
    for (const v of vehicles) {
      if (v.id) {
        await tx.warehouseVehicle.update({
          where: { id: v.id },
          data: { tonnage: v.tonnage, quantity: v.quantity },
        });
      } else {
        await tx.warehouseVehicle.create({
          data: { warehouseId, tonnage: v.tonnage, quantity: v.quantity },
        });
      }
    }
  }
```

Then rewrite `create`/`update` on the same shape as `ClientsService`: destructure `{ contacts, vehicles, ...fields }`, open a `$transaction`, write the warehouse, then `reconcileContacts({ delegate: tx.warehouseContact as unknown as ContactDelegate, ownerKey: "warehouseId", ... })` and `reconcileVehicles`.

**Keep `update`'s existing `merged` invariant block exactly as it is** — build `merged` from `fields`, never from the raw `input`, or the `"agreementValidUntil" in input` checks start seeing the child keys.

Delete the now-dead `warehouseId` branch from this service's `mapUnique`, same as Task 4.

- [ ] **Step 4: Update the 11 existing create sites**

Wrap each `POST /api/warehouses` body in `warehouseCreateBody({ ... })` in `warehouses.e2e-spec.ts` (10 sites) and `warehouse-linking.e2e-spec.ts` (1 site).

- [ ] **Step 5: Run the full api suite + typecheck**

Run: `pnpm --filter @svyft/api test && pnpm --filter @svyft/api typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add apps/api/src/modules/warehouses apps/api/test
git commit -m "feat(api): composite warehouse create/update with contacts and vehicles"
```

---

### Task 6: Freight Forwarder composite endpoint

**Files:**
- Modify: `apps/api/src/modules/freight-forwarders/freight-forwarders.service.ts`
- Test: `apps/api/test/freight-forwarders-composite.e2e-spec.ts` (create)

**Interfaces:**
- Consumes: `reconcileContacts`, `ContactDelegate` (Task 4).
- Produces: no new exports. `POST /api/freight-forwarders` accepts an optional `contacts`; when it contains a PRIMARY, `create()` does **not** also seed one.

- [ ] **Step 1: Write the failing test**

```ts
  // Backward compatibility: this is exactly the payload every existing FF spec sends.
  it("still seeds the primary from pic/contactNumber/email when contacts is absent", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send(ffCreateBody({ companyName: `${FF} A` }))
      .expect(201);

    const contacts = await prisma.freightForwarderContact.findMany({
      where: { freightForwarderId: res.body.id },
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0].pocLevel).toBe("PRIMARY");
    expect(contacts[0].name).toBe("Fixture PIC");
  });

  // The double-insert guard. Without the skip, this payload writes the supplied PRIMARY *and*
  // the seeded one, and FreightForwarderContact_one_primary rejects the whole transaction.
  it("uses the supplied primary and does not also seed one", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send(
        ffCreateBody({
          companyName: `${FF} B`,
          contacts: [
            { name: "Supplied P", email: "sp@x.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
            { name: "Second", email: "sec@x.com", contactNo: "+971501234568", pocLevel: "SECONDARY" },
          ],
        }),
      )
      .expect(201);

    const contacts = await prisma.freightForwarderContact.findMany({
      where: { freightForwarderId: res.body.id },
    });
    expect(contacts).toHaveLength(2);
    expect(contacts.filter((c) => c.pocLevel === "PRIMARY")).toHaveLength(1);
    expect(contacts.find((c) => c.pocLevel === "PRIMARY")?.name).toBe("Supplied P");
  });

  // C7: the derived columns must track the primary contact, and only via the sync.
  it("syncs pic/contactNumber/email from the primary contact after a composite write", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/freight-forwarders")
      .set("Cookie", cookie(Role.MANAGER))
      .send(ffCreateBody({ companyName: `${FF} C` }))
      .expect(201);

    const [existing] = await prisma.freightForwarderContact.findMany({
      where: { freightForwarderId: created.body.id },
    });

    await request(app.getHttpServer())
      .patch(`/api/freight-forwarders/${created.body.id}`)
      .set("Cookie", cookie(Role.MANAGER))
      .send({
        contacts: [
          {
            id: existing.id,
            name: "Renamed PIC",
            email: "renamed@x.com",
            contactNo: "+971509999999",
            pocLevel: "PRIMARY",
          },
        ],
      })
      .expect(200);

    const ff = await prisma.freightForwarder.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(ff.pic).toBe("Renamed PIC");
    expect(ff.email).toBe("renamed@x.com");
    expect(ff.contactNumber).toBe("+971509999999");
  });
```

Add a local `ffCreateBody(overrides)` helper to this spec returning the HTTP-shaped body (`companyName`, `companyAddress`, `city`, `country`, `pic: "Fixture PIC"`, `contactNumber`, `email`, `availableCountries: ["AE"]`, `modes: ["AIR"]`, `handleDg: false`). Note this is the **HTTP body**, distinct from `ffFixture` in `test/helpers/freight-forwarder.ts`, which is a `Prisma.FreightForwarderCreateInput` for direct row creation.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/api test -- freight-forwarders-composite`
Expected: test 1 passes (current behaviour), tests 2 and 3 fail — test 2 with a P2002 on the primary index.

- [ ] **Step 3: Implement**

In `create()`, after `tx.freightForwarder.create(...)`, replace the unconditional contact seed:

```ts
        const { contacts, warehouseIds, ...fields } = input;
        // ... ff created from `fields` ...

        // The seed exists so the "every forwarder has exactly one PRIMARY contact" invariant
        // holds from row 0 for the pic/contactNumber/email create path. When the caller supplies
        // its own PRIMARY, seeding as well writes two primary rows and
        // FreightForwarderContact_one_primary rejects the whole transaction — so the seed is
        // skipped, not merged.
        const suppliedPrimary = (contacts ?? []).some((c) => c.pocLevel === PocLevel.PRIMARY);
        if (!suppliedPrimary) {
          await tx.freightForwarderContact.create({
            data: {
              freightForwarderId: ff.id,
              name: ff.pic,
              email: ff.email,
              contactNo: ff.contactNumber,
              pocLevel: "PRIMARY",
              ...auditCreate(user),
            },
          });
        }
        if (contacts?.length) {
          await reconcileContacts({
            delegate: tx.freightForwarderContact as unknown as ContactDelegate,
            ownerKey: "freightForwarderId",
            ownerId: ff.id,
            contacts,
            user,
          });
        }
        await this.syncPrimaryContactColumns(tx, ff.id, user);
        if (warehouseIds) await this.setWarehousesTx(tx, ff.id, warehouseIds, user);
        return ff;
```

In `update()`, destructure the children off before building `data`, keep the four existing `delete data.*` lines untouched (C7 defence in depth), and after the parent update run `reconcileContacts` then `syncPrimaryContactColumns` inside the same transaction. As in Task 4, extract `setWarehousesTx` from the existing public `setWarehouses`.

Delete the dead `freightForwarderId` branch from this service's `mapUnique`.

- [ ] **Step 4: Run the full api suite + typecheck**

Run: `pnpm --filter @svyft/api test && pnpm --filter @svyft/api typecheck`
Expected: green, **including every pre-existing FF spec unchanged** — that is the backward-compatibility claim, and it must be observed, not assumed.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/api/src/modules/freight-forwarders apps/api/test
git commit -m "feat(api): composite freight-forwarder create/update"
```

---

### Task 7: Contacts section — table + dialog

**Files:**
- Create: `apps/web/src/features/masters/contacts/{ContactsSection,ContactDialog}.tsx`, `ContactsSection.test.tsx`
- Delete: `apps/web/src/features/masters/{ContactList,ContactRow}.tsx`, `ContactList.test.tsx`

**Interfaces:**
- Consumes: `Field`, `SelectField` (Task 2); `ContactUpsertInput`, `POC_LEVELS`, `MASTER_STATUSES` (Task 3).
- Produces:
  - `type ContactDraft = ContactUpsertInput`
  - `ContactsSection(props: { value: ContactDraft[]; onChange: (next: ContactDraft[]) => void; ownerNoun: string; lockedFirstRow?: boolean })` — `lockedFirstRow` renders row 0 as plain text instead of a select-button, for Task 9's FF mirror
  - `ContactDialog(props: { open: boolean; initial: ContactDraft | null; onSave: (c: ContactDraft) => void; onRemove: () => void; onClose: () => void })`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ContactsSection, type ContactDraft } from "./ContactsSection";

function Harness({ initial = [] as ContactDraft[] }) {
  const [value, setValue] = useState<ContactDraft[]>(initial);
  return <ContactsSection value={value} onChange={setValue} ownerNoun="client" />;
}

const asha: ContactDraft = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  name: "Asha Menon",
  email: "asha@example.com",
  contactNo: "+971501234567",
  pocLevel: "PRIMARY",
};

describe("ContactsSection", () => {
  it("has no per-row action buttons — the row itself is the control", () => {
    render(<Harness initial={[asha]} />);
    expect(screen.queryByRole("button", { name: /^edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^remove/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /asha menon/i })).toBeInTheDocument();
  });

  it("adds a contact through the dialog", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), "New Person");
    await userEvent.type(screen.getByLabelText(/designation/i), "Ops Manager");
    await userEvent.type(screen.getByLabelText(/email/i), "new@example.com");
    await userEvent.type(screen.getByLabelText(/phone/i), "+971501112222");
    await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "PRIMARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    const table = screen.getByRole("table", { name: /contacts/i });
    expect(within(table).getByText("New Person")).toBeInTheDocument();
    expect(within(table).getByText("Ops Manager")).toBeInTheDocument();
  });

  it("opens the dialog prefilled when a row is selected", async () => {
    render(<Harness initial={[asha]} />);
    await userEvent.click(screen.getByRole("button", { name: /asha menon/i }));
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("Asha Menon");
  });

  it("removes from inside the dialog, not from the row", async () => {
    render(<Harness initial={[asha]} />);
    await userEvent.click(screen.getByRole("button", { name: /asha menon/i }));
    await userEvent.click(screen.getByRole("button", { name: /remove contact/i }));
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i })); // confirm
    expect(screen.queryByText("Asha Menon")).not.toBeInTheDocument();
  });

  it("offers no Remove when adding a new contact", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    expect(screen.queryByRole("button", { name: /remove contact/i })).not.toBeInTheDocument();
  });

  // The rule that makes the API's 409 unreachable from the UI.
  it("demotes the incumbent when a second contact is set to PRIMARY", async () => {
    render(<Harness initial={[asha]} />);
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Newer Primary");
    await userEvent.type(screen.getByLabelText(/email/i), "np@example.com");
    await userEvent.type(screen.getByLabelText(/phone/i), "+971501112223");
    await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "PRIMARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));

    const rows = screen.getAllByRole("row").slice(1); // drop the header row
    const primaries = rows.filter((r) => within(r).queryByText("PRIMARY"));
    expect(primaries).toHaveLength(1);
    expect(within(primaries[0]).getByText(/newer primary/i)).toBeInTheDocument();
  });

  it("never calls fetch — every mutation is draft-only until the parent saves", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<Harness initial={[asha]} />);
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Nobody");
    await userEvent.type(screen.getByLabelText(/email/i), "n@example.com");
    await userEvent.type(screen.getByLabelText(/phone/i), "+971501112224");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/web test -- src/features/masters/contacts`
Expected: FAIL — `Failed to resolve import "./ContactsSection"`.

- [ ] **Step 3: Implement `ContactDialog.tsx`**

```tsx
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  contactUpsertSchema,
  POC_LEVELS,
  MASTER_STATUSES,
  type ContactUpsertInput,
} from "@svyft/shared";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, SelectField } from "../form";

export function ContactDialog({
  open,
  initial,
  onSave,
  onRemove,
  onClose,
}: {
  open: boolean;
  initial: ContactUpsertInput | null;
  onSave: (c: ContactUpsertInput) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const isExisting = initial !== null;
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<ContactUpsertInput>({
    resolver: zodResolver(contactUpsertSchema),
    // `initial ?? {...}` and a `key` on <ContactDialog> in the parent, NOT a reset() effect:
    // the dialog unmounts between openings, so defaultValues are re-read every time and there
    // is no stale-value window to guard against.
    defaultValues: initial ?? { pocLevel: "NONE", status: "ACTIVE" },
  });
  const err = (n: keyof ContactUpsertInput) => errors[n]?.message as string | undefined;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isExisting ? "Edit contact" : "Add contact"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSave)} className="space-y-3">
          <Field id="c-name" label="Name" error={err("name")}>
            <Input id="c-name" {...register("name")} />
          </Field>
          <Field id="c-designation" label="Designation" error={err("designation")}>
            <Input id="c-designation" {...register("designation")} />
          </Field>
          <Field id="c-email" label="Email" error={err("email")}>
            <Input id="c-email" {...register("email")} />
          </Field>
          <Field id="c-phone" label="Phone" error={err("contactNo")}>
            <Input id="c-phone" placeholder="+971501234567" {...register("contactNo")} />
          </Field>
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
          <SelectField
            id="c-poc"
            label="POC level"
            error={err("pocLevel")}
            options={POC_LEVELS.map((l) => ({ value: l, label: l }))}
            registration={register("pocLevel")}
          />
          <SelectField
            id="c-status"
            label="Status"
            error={err("status")}
            options={MASTER_STATUSES.map((s) => ({ value: s, label: s }))}
            registration={register("status")}
          />
          <DialogFooter className="gap-2">
            {confirmingRemove ? (
              <>
                <span className="mr-auto self-center text-sm">Remove this contact?</span>
                <Button type="button" variant="outline" onClick={() => setConfirmingRemove(false)}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" onClick={onRemove}>
                  Remove
                </Button>
              </>
            ) : (
              <>
                {isExisting && (
                  <Button
                    type="button"
                    variant="destructive"
                    className="mr-auto"
                    onClick={() => setConfirmingRemove(true)}
                  >
                    Remove contact
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit">Save contact</Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

The dialog never fetches. `onSave` hands the parsed draft up; `onClose` discards. The parent gives
`<ContactDialog>` a `key={openIndex}` so each opening remounts with fresh `defaultValues`.

- [ ] **Step 4: Implement `ContactsSection.tsx`**

```tsx
export type ContactDraft = ContactUpsertInput;

export function ContactsSection({
  value,
  onChange,
  ownerNoun,
}: {
  value: ContactDraft[];
  onChange: (next: ContactDraft[]) => void;
  ownerNoun: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | "new" | null>(null);

  function upsert(draft: ContactDraft) {
    // Setting a contact PRIMARY demotes the incumbent here, in the draft. This is what makes
    // the API's second-primary 409 unreachable from the UI, and why the old ContactRow
    // PROMOTION_HINT ("demote the current primary first") no longer exists.
    const demoted =
      draft.pocLevel === "PRIMARY"
        ? value.map((c, i) =>
            i !== openIndex && c.pocLevel === "PRIMARY" ? { ...c, pocLevel: "SECONDARY" as const } : c,
          )
        : value;
    onChange(
      openIndex === "new" ? [...demoted, draft] : demoted.map((c, i) => (i === openIndex ? draft : c)),
    );
    setOpenIndex(null);
  }
  // ...
}
```

Render a `Table` with caption/`aria-label` "Contacts" and headers **Name · Designation · Email · Phone · Channels · POC · Status** — no actions column. Each body row's first cell holds a `<button type="button">` carrying the contact's name, which calls `setOpenIndex(i)`. A `<button>` rather than an `onClick` on the `<tr>` so the row is keyboard-reachable and announced as activatable.

Above the table: an **Add contact** button setting `openIndex` to `"new"`. Below: `No contacts yet. Add at least one, including a primary.` when `value` is empty.

- [ ] **Step 5: Delete the old components**

```bash
git rm apps/web/src/features/masters/ContactList.tsx \
       apps/web/src/features/masters/ContactRow.tsx \
       apps/web/src/features/masters/ContactList.test.tsx
```

`ClientFormPage`, `FreightForwarderFormPage` and `WarehouseFormPage` still import `ContactList` and will not compile until Tasks 8–10. That is expected; keep this task's commit and move straight on.

- [ ] **Step 6: Run the section's tests**

Run: `pnpm --filter @svyft/web test -- src/features/masters/contacts`
Expected: 7 passed. (`pnpm --filter @svyft/web typecheck` still reports the three broken form pages — deferred to Tasks 8–10.)

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters/contacts
git commit -m "feat(web): contacts table with dialog-only add/edit/remove"
```

---

### Task 8: Client form page

**Files:**
- Modify: `apps/web/src/features/masters/clients/ClientFormPage.tsx`, `ClientFormPage.test.tsx`

**Interfaces:**
- Consumes: `MasterForm`, `FormSection`, `Field`, `SelectField` (Task 2); `ContactsSection`, `ContactDraft` (Task 7); `clientCreateSchema` (Task 3).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Replace the create-path test and add these, using the existing `mockFetch` harness from the current file:

```tsx
  it("sends parent fields and contacts in ONE request", async () => {
    const bodies: unknown[] = [];
    // ...mockFetch capturing POST /api/clients into `bodies`, plus /api/auth/me...
    // fill Company name / Country / Street address / City
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    // fill the dialog, set POC level PRIMARY, save contact
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      companyName: "NewCo",
      contacts: [expect.objectContaining({ name: "Asha Menon", pocLevel: "PRIMARY" })],
    });
  });

  it("blocks Save when no contact is marked Primary", async () => {
    // ...add a contact with pocLevel NONE, click Save...
    expect(await screen.findByRole("alert")).toHaveTextContent(/one contact must be marked primary/i);
    expect(postCalls).toHaveLength(0);
  });

  it("shows the advisory banner on a loaded client with no primary, and still saves", async () => {
    // GET /api/clients/:id returns contacts: [{ pocLevel: "NONE", ... }]
    expect(await screen.findByRole("status")).toHaveTextContent(/no primary contact/i);
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patchCalls).toHaveLength(1));
  });

  it("renders the Status field the schema has always carried", async () => {
    expect(await screen.findByLabelText(/status/i)).toBeInTheDocument();
  });

  // The third state of the §4.4 rule, and the one neither test above covers: the record LOADED
  // with a primary and the user is demoting it away. That must block, even though a record
  // that loaded WITHOUT one saves freely.
  it("blocks Save when the user demotes away the primary the record loaded with", async () => {
    // GET /api/clients/:id returns one contact with pocLevel PRIMARY
    await userEvent.click(await screen.findByRole("button", { name: /asha menon/i }));
    await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "SECONDARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /one contact must be marked primary/i,
    );
    expect(patchCalls).toHaveLength(0);
  });
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/web test -- src/features/masters/clients`
Expected: FAIL — the page still imports the deleted `ContactList` and posts without `contacts`.

- [ ] **Step 3: Implement**

One `useForm<ClientCreateInput>` resolved by `clientCreateSchema`, with
`defaultValues: { contacts: [], warehouseIds: [] }`.

The load effect must carry `contacts`. Omitting it leaves the draft's array empty, and since the
API treats "absent from the array" as "delete", the first unrelated PATCH would wipe every
contact on the record — the same silent-overwrite hazard the existing WarehouseFormPage `reset()`
comment warns about for rate fields:

```tsx
  useEffect(() => {
    if (!existing.data) return;
    const d = existing.data;
    reset({
      companyName: d.companyName,
      country: d.country,
      industry: d.industry ?? undefined,
      streetAddress: d.streetAddress,
      city: d.city,
      postalCode: d.postalCode ?? undefined,
      status: d.status,
      contacts: (d.contacts ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        designation: c.designation ?? undefined,
        email: c.email,
        contactNo: c.contactNo,
        whatsappAvailable: c.whatsappAvailable,
        wechatAvailable: c.wechatAvailable,
        botimAvailable: c.botimAvailable,
        pocLevel: c.pocLevel,
        status: c.status,
      })),
      warehouseIds: (ownedWarehouses.data ?? []).map((w) => w.id),
    });
  }, [existing.data, ownedWarehouses.data, reset]);
```

`loadedWithPrimary` is captured off `existing.data` (not off the live draft) so the §4.4 UI rule
can tell "this record never had a primary" from "the user just demoted the only one":

```tsx
  const loadedWithPrimary = (existing.data?.contacts ?? []).some((c) => c.pocLevel === "PRIMARY");
```

Block submit when `loadedWithPrimary` (or this is a create) and the draft names no PRIMARY,
setting the form-level error to `PRIMARY_REQUIRED_MESSAGE`.

Sections: **Company** (companyName, industry, status) · **Address** (streetAddress, city, country, postalCode) · **Contacts** (`Controller` over `contacts` rendering `ContactsSection`) · **Warehouses** (`WarehousePicker`, now a controlled `warehouseIds` editor — see Step 4).

`onSubmit` posts or patches once, then `navigate("/masters/clients")`. `onCancel` navigates back without saving.

Banner: when `existing.data` loaded and none of its contacts is PRIMARY, render into `MasterForm`'s `banner` slot:

```tsx
<p role="status" className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
  This client has no primary contact. Add one so quotes can address correspondence.
</p>
```

- [ ] **Step 4: Convert `WarehousePicker` to a controlled component**

Change its props from `{ ownerPath, ownerId, assigned }` to `{ ownerPath, value: string[]; onChange: (ids: string[]) => void; assigned: WarehouseDto[] }`. Delete its `onSave`, `isSaving`, `submitError` state and its **Save warehouses** button — the parent's Save is now the only commit. Keep the unassigned-pool query, the search box, the truncation notice and the `assignedSignature` effect (its comment explains a real bug); the effect now seeds `onChange` only when `value` is empty. Update `WarehousePicker.test.tsx` accordingly.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test -- src/features/masters && pnpm --filter @svyft/web typecheck`
Expected: client and picker tests green.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters/clients apps/web/src/features/masters/WarehousePicker.tsx apps/web/src/features/masters/WarehousePicker.test.tsx
git commit -m "feat(web): client form saves parent, contacts and warehouses in one request"
```

---

### Task 9: Freight Forwarder form page (with the primary-contact mirror)

**Files:**
- Modify: `apps/web/src/features/masters/freight-forwarders/FreightForwarderFormPage.tsx`, `.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 7, 8.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

```tsx
  it("mirrors pic/contactNumber/email into a PRIMARY row while creating", async () => {
    render(/* the /new route */);
    await userEvent.type(await screen.findByLabelText(/person in charge/i), "Ravi K");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+971501234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ravi@ff.com");

    const table = screen.getByRole("table", { name: /contacts/i });
    expect(within(table).getByText("Ravi K")).toBeInTheDocument();
    expect(within(table).getByText("PRIMARY")).toBeInTheDocument();
  });

  it("does not let a second contact be made primary while the mirror holds it", async () => {
    // add a contact, choose PRIMARY, save contact
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.filter((r) => within(r).queryByText("PRIMARY"))).toHaveLength(1);
  });

  it("keeps pic/contactNumber/email disabled on an existing record", async () => {
    render(/* the /:id route with a loaded forwarder */);
    expect(await screen.findByLabelText(/person in charge/i)).toBeDisabled();
    expect(screen.getByLabelText(/contact number/i)).toBeDisabled();
    expect(screen.getByLabelText(/^email$/i)).toBeDisabled();
  });

  it("sends one PATCH carrying both parent fields and contacts", async () => {
    // ...edit a contact through the dialog, click Save...
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toHaveProperty("contacts");
  });
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/web test -- src/features/masters/freight-forwarders`
Expected: FAIL — no contacts table is rendered during create.

- [ ] **Step 3: Implement**

Keep the three existing sections (Company & contact · Address · Service & commercial) but render them through `FormSection`/`Field`/`SelectField`. Add **Contacts** and **Warehouses** sections.

The mirror, in create mode only:

```tsx
  const [pic, contactNumber, email] = useWatch({ control, name: ["pic", "contactNumber", "email"] });

  // Create mode only. The three fields are the FF's own columns AND the source of the primary
  // contact the API seeds (freight-forwarders.service.ts create()), so the contacts table shows
  // that row live rather than making the user type the same person twice. On an existing record
  // the three fields are disabled and syncPrimaryContactColumns is the only writer, so there is
  // nothing to mirror — `contacts` comes from the server.
  const mirroredContacts: ContactDraft[] = useMemo(() => {
    if (id) return contacts;
    const mirror: ContactDraft = {
      name: pic ?? "",
      email: email ?? "",
      contactNo: contactNumber ?? "",
      pocLevel: "PRIMARY",
    };
    return [mirror, ...contacts];
  }, [id, contacts, pic, contactNumber, email]);
```

`ContactsSection` receives `mirroredContacts`; its `onChange` writes back only the tail (`next.slice(1)`) in create mode, so the mirrored row cannot be edited or removed from the table — it is edited through the three fields above. Pass `ContactsSection` a `lockedFirstRow` boolean so the mirrored row renders as plain text rather than a select-button.

On submit in create mode, send `contacts: []` — the service seeds the primary from `pic`/`contactNumber`/`email`, and sending the mirrored row as well would be redundant (harmless, since Task 6 skips the seed when a PRIMARY is supplied, but sending nothing keeps the create path byte-identical to what every existing FF spec exercises).

Keep the `disabled={Boolean(id)}` attributes and both explanatory paragraphs on
`pic`/`contactNumber`/`email`/`whLocation` exactly as they are — they document C7 and the
derivation.

Add the same advisory banner as Task 8, with the FF noun (design §5.3), and the same
`loadedWithPrimary` submit rule:

```tsx
<p role="status" className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
  This freight forwarder has no primary contact. Add one so quotes can address correspondence.
</p>
```

In practice every production forwarder has one from the migration backfill, so this banner should
be rare — but the rule is uniform across the three contact-bearing masters and the code path must
exist.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test -- src/features/masters && pnpm --filter @svyft/web typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters/freight-forwarders apps/web/src/features/masters/contacts
git commit -m "feat(web): FF form mirrors its primary contact and saves in one request"
```

---

### Task 10: Warehouse form page + vehicles dialog

**Files:**
- Create: `apps/web/src/features/masters/warehouses/{VehiclesSection,VehicleDialog}.tsx`, `VehiclesSection.test.tsx`
- Modify: `apps/web/src/features/masters/warehouses/WarehouseFormPage.tsx`, `.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 3, 7.
- Produces: `VehiclesSection(props: { value: WarehouseVehicleUpsert[]; onChange: (next: WarehouseVehicleUpsert[]) => void })`.

- [ ] **Step 1: Write the failing tests**

`VehiclesSection.test.tsx` mirrors `ContactsSection.test.tsx`: no per-row buttons, add through the dialog, row-select opens prefilled, Remove lives in the dialog, and `fetch` is never called. Two fields only — Tonnage and Quantity.

In `WarehouseFormPage.test.tsx` add:

```tsx
  it("sends warehouse fields, contacts and vehicles in one request", async () => {
    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toMatchObject({
      name: "WH One",
      contacts: [expect.objectContaining({ pocLevel: "PRIMARY" })],
      vehicles: [expect.objectContaining({ tonnage: "10T", quantity: 3 })],
    });
  });

  it("blocks Save when no contact is marked Primary", async () => {
    expect(await screen.findByRole("alert")).toHaveTextContent(/one contact must be marked primary/i);
  });

  // Regression guard for the existing rate-field clearing effect, which must survive the rewrite.
  it("clears rate fields when the type leaves OWNED/CONTRACTED", async () => {
    await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "OWNED");
    await userEvent.type(screen.getByLabelText(/handling rate/i), "50");
    await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "CLIENT");
    await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "OWNED");
    expect(screen.getByLabelText(/handling rate/i)).toHaveValue(null);
  });
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/web test -- src/features/masters/warehouses`
Expected: FAIL on all three.

- [ ] **Step 3: Implement**

`VehiclesSection` / `VehicleDialog` follow Task 7's shape exactly — read-only `Table` (Tonnage · Quantity, no actions column), first cell a `<button>` carrying the tonnage, an **Add vehicle** button above, Remove inside the dialog.

Rewrite `WarehouseFormPage` onto `MasterForm` with sections **Warehouse** · **Address** · **Capacity & capabilities** · **Operations** · **Contract & rates** (still `{isContracted && <ContractAndRatesSection .../>}`) · **Vehicles** · **Contacts**.

Delete the old `VehicleSubForm` component. Keep, unchanged:
- the whole `reset()` block loading every contract/rate field, **plus** `contacts` and `vehicles` now — its comment explains why skipping any field silently overwrites it;
- the `prevType` ref effect that clears the six rate fields on a real transition out of `CONTRACTED_TYPES`;
- the "Assigned to a freight forwarder / client" read-only notice.

Replace the derived `Total vehicles` paragraph with `value.length` off the draft, so it tracks
unsaved additions.

Add the same advisory banner and `loadedWithPrimary` submit rule as Tasks 8 and 9, with the
warehouse noun:

```tsx
<p role="status" className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
  This warehouse has no primary contact. Add one so quotes can address correspondence.
</p>
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test -- src/features/masters && pnpm --filter @svyft/web typecheck`
Expected: green. This is the first point at which the whole web package typechecks again.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters/warehouses
git commit -m "feat(web): warehouse form with dialog-managed contacts and vehicles"
```

---

### Task 11: Vessel form page

**Files:**
- Modify: `apps/web/src/features/masters/vessels/VesselFormPage.tsx`, `.test.tsx`

**Interfaces:** Consumes Task 2. Produces nothing.

- [ ] **Step 1: Write the failing test**

```tsx
  it("renders one Vessel section with a Status field and a Cancel button", async () => {
    expect(await screen.findByRole("heading", { name: /new vessel/i })).toBeInTheDocument();
    expect(screen.getByText(/^vessel$/i)).toBeInTheDocument(); // the section heading
    expect(screen.getByLabelText(/status/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("returns to the list on Cancel without saving", async () => {
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(await screen.findByText("vessels list")).toBeInTheDocument();
    expect(postCalls).toHaveLength(0);
  });
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/web test -- src/features/masters/vessels`
Expected: FAIL — no Status field, no Cancel button.

- [ ] **Step 3: Implement**

Wrap the existing four fields in `MasterForm` + one `FormSection title="Vessel"`, add `status` via `SelectField` (Active/Inactive), and keep the `imoNumber` `setValueAs` mapping. No child collections — vessels have no contacts.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test -- src/features/masters/vessels && pnpm --filter @svyft/web typecheck`

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters/vessels
git commit -m "feat(web): vessel form on the shared shell, with Status"
```

---

### Task 12: FX rate create page

**Files:**
- Create: `apps/web/src/features/masters/fx-rates/FxRateFormPage.tsx`, `FxRateFormPage.test.tsx`
- Modify: `apps/web/src/features/masters/fx-rates/FxRatesPage.tsx`, `.test.tsx`; `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 2; `useCreateFxRate` (existing, unchanged).
- Produces: route `/masters/fx-rates/new`.

- [ ] **Step 1: Write the failing test**

```tsx
// FxRatesPage.test.tsx
  it("offers a New FX rate link for a writer and no inline add form", async () => {
    expect(await screen.findByRole("link", { name: /new fx rate/i })).toHaveAttribute(
      "href",
      "/masters/fx-rates/new",
    );
    expect(screen.queryByRole("form", { name: /add rate form/i })).not.toBeInTheDocument();
  });

  it("hides the New FX rate link from a non-writer", async () => {
    // role EXECUTIVE — await the table first, then assert the link is absent
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new fx rate/i })).not.toBeInTheDocument();
  });

// FxRateFormPage.test.tsx
  it("creates a rate and returns to the list", async () => {
    await userEvent.selectOptions(await screen.findByLabelText(/currency/i), "INR");
    await userEvent.type(screen.getByLabelText(/units\/usd/i), "83.5");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText("fx list")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/web test -- src/features/masters/fx-rates`
Expected: FAIL — no such link, no such module.

- [ ] **Step 3: Implement**

Move `AddRateForm`'s body into `FxRateFormPage` on `MasterForm` + one `FormSection title="Rate"` (currency, unitsPerUsd, `ZonedDateTimeField` for effectiveFrom, note). On success `navigate("/masters/fx-rates")`; Cancel does the same without saving. Delete `AddRateForm` from `FxRatesPage` and give the list page the same header + `Link` block the Clients list uses, gated on `useCanWrite()`.

Register the route in `App.tsx` beside the existing `/masters/fx-rates` entry, copying that entry's role guard exactly.

Rates stay append-only: no edit link on the rows, no delete.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test -- src/features/masters/fx-rates && pnpm --filter @svyft/web typecheck`

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add apps/web/src/features/masters/fx-rates apps/web/src/App.tsx
git commit -m "feat(web): FX rate create page matching the other masters"
```

---

### Task 13: Charge Catalogue — restrict Input type, hide Sort order

**Files:**
- Modify: `apps/web/src/features/masters/charge-catalogue/ChargeLineFormPage.tsx`, `.test.tsx`, `ChargeCatalogueListPage.tsx`, `.test.tsx`

**Interfaces:** Consumes Task 2. Produces nothing. **No API change** (spec §6.3).

- [ ] **Step 1: Write the failing test**

```tsx
// ChargeLineFormPage.test.tsx
  it("offers only the two input types resolveChargeConfig actually surfaces", async () => {
    const select = await screen.findByLabelText(/input type/i);
    const values = within(select).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["PLAIN", "HEAVY_WEIGHT_CALC"]);
  });

  it("renders an existing TRUCKING line's input type read-only with an explanation", async () => {
    // admin list returns one row with inputType TRUCKING
    expect(await screen.findByText(/trucking/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/input type/i)).not.toBeInTheDocument();
    expect(screen.getByText(/prices through the portal's rate rows/i)).toBeInTheDocument();
  });

  it("has no Sort order field", async () => {
    await screen.findByLabelText(/label/i);
    expect(screen.queryByLabelText(/sort order/i)).not.toBeInTheDocument();
  });

  it("does not send sortOrder on save", async () => {
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).not.toHaveProperty("sortOrder");
  });

// ChargeCatalogueListPage.test.tsx
  it("drops the Input and Sort columns", async () => {
    await screen.findByRole("table");
    expect(screen.queryByRole("columnheader", { name: /^input$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /^sort$/i })).not.toBeInTheDocument();
  });

  it("badges a non-PLAIN line beside its label", async () => {
    expect(await screen.findByText(/heavy-weight/i)).toBeInTheDocument();
  });

  // Must survive the rework — Stage-4 item 6 depends on it.
  it("still hides the uncategorised ROAD_WH_HANDLING row", async () => {
    await screen.findByRole("table");
    expect(screen.queryByText("ROAD_WH_HANDLING")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @svyft/web test -- src/features/masters/charge-catalogue`
Expected: FAIL — four options offered, Sort order field present, both columns present.

- [ ] **Step 3: Implement**

In `ChargeLineFormPage`, narrow the local list and explain why in place:

```tsx
// resolveChargeConfig (packages/shared/src/charge-config.ts) resolves ONLY PLAIN and
// HEAVY_WEIGHT_CALC. TRUCKING and WAREHOUSE_STAGING lines price through the leg's trucking /
// warehouse rate rows, which seedQuoteDraft builds from the leg's ENDPOINTS — never from a
// catalogue row. So a new line created as either of those is not merely filtered out: nothing
// in the system would ever read it. Only the two selectable values are offered; the other two
// are rendered read-only on the two seeded rows that legitimately carry them.
const SELECTABLE_INPUT_TYPES = ["PLAIN", "HEAVY_WEIGHT_CALC"] as const;
```

When `existing.inputType` is not in that list, render it as read-only text plus *"This line prices through the portal's rate rows, not the charge matrix."* and drop `inputType` from the PATCH body.

Delete the Sort order `Field` and drop `sortOrder` from the PATCH body — `charge-catalogue.service.ts:82` keeps assigning it on create, and `chargeLineUpdateSchema` still accepts it, so nothing on the API changes (spec §6.3).

Re-lay the form as `MasterForm` + **Classification** (mode, category, variant, isAdditional) and **Presentation** (label, input type). Keep every `disabled={isEdit}` and each immutability paragraph.

In `ChargeCatalogueListPage`, remove the two `<th>`s and their `<td>`s, and render a `Badge` beside the label when `l.inputType !== "PLAIN"`. **Leave `.filter((l) => l.category != null)` exactly as it is.**

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @svyft/web test -- src/features/masters/charge-catalogue && pnpm --filter @svyft/web typecheck`

- [ ] **Step 5: Full CI, then commit**

```bash
pnpm run ci
git branch --show-current
git add apps/web/src/features/masters/charge-catalogue
git commit -m "feat(web): restrict charge-line input type, hide sort order"
```

`pnpm run ci` must be green before this branch is considered done: shared + web + api tests, lint, typecheck and all three builds.

---

## Post-implementation checklist

- [ ] `pnpm run ci` green (shared + web + api, lint, typecheck, three builds).
- [ ] `git diff main --stat` shows **no** change under `prisma/migrations/`, `apps/api/src/seed/reference-seed.ts`, `packages/shared/src/{charge-config,quote-engine}.ts`, `apps/web/src/features/ff-portal/`, or `apps/web/src/features/query-wizard/`.
- [ ] The three partial unique indexes still exist: `select indexname from pg_indexes where indexname like '%one_primary';` returns three rows.
- [ ] Update `docs/Masters - Session Handoff.md`: this branch shipped; the deferred Stage-4 pass is still next; the post-deploy corrections are still owed and still applicable through the rebuilt FF form.
