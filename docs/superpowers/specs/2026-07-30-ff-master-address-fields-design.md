# FF Master — Address Fields & Form Layout — Design

- **Date:** 2026-07-30
- **Status:** Approved
- **Area:** Stage 4 · Freight Forwarder (FF) Master
- **Author:** Pratik Jain (with Claude)

## 1. Summary

Extend the Freight Forwarder Master with a structured postal address. Today the FF
Master captures a single free-text **Company Address**. This change:

1. Renames that field's **visible label** to **Street Address** (label only — the
   stored field/column stays `companyAddress`).
2. Adds three new optional fields after it: **City**, **Postal Code**, **Country**.
3. Re-lays out the create/edit form into logical two-column sections so the whole
   form fits without meaningful scrolling.

This aligns the FF Master address with the address structure already used by the
Warehouse identity block in the Functional Spec (§7.4.3.3: *Street Address / City /
Postal Code / Country*).

## 2. Context

- **Functional Spec §6 (FF Master)** lists `Company Address` as a single *Optional*
  text field. The three new fields extend §6; they follow the same address shape the
  spec already uses for Warehouse Points in §7.4.3.3.
- The new **Country** field is the FF's **own address country**. It is deliberately
  distinct from the existing **Available Place of Services** multi-select
  (`availableCountries`), which drives leg-eligibility filtering and is unchanged.
- Backend writes for the FF Master already gate to **Admin/Manager** (correct for
  master-data). No RBAC change.

## 3. Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Country input type | **Free text** | Matches the Client master's free-text `country`. No enum coupling. |
| D2 | Address rename scope | **Label only** | Change only the visible label to "Street Address"; keep the `companyAddress` field/column name. No column-rename migration, no data risk, smallest diff. |
| D3 | New field requiredness | **Optional** | Consistent with the existing `companyAddress`, which the spec marks Optional. |

## 4. Data Model — `prisma/schema.prisma`

Add three nullable columns to `model FreightForwarder`, immediately after
`companyAddress`:

```prisma
companyAddress  String?
city            String?
postalCode      String?
country         String?
```

- Additive and nullable → no backfill, zero risk to existing rows.
- New migration: `add_ff_address_fields` (generated via `prisma migrate`, consistent
  with the existing `prisma/migrations/` history).

## 5. Shared Schema & DTO — `packages/shared/src/masters.ts`

`freightForwarderCreateSchema` — add after `companyAddress`:

```ts
city: z.string().max(120).optional(),
postalCode: z.string().max(20).optional(),
country: z.string().max(120).optional(),
```

- `freightForwarderUpdateSchema` derives these automatically via `.partial()`.
- `FreightForwarderDto` — add `city: string | null`, `postalCode: string | null`,
  `country: string | null`.

## 6. Backend

- `freight-forwarders.service.ts` — **no change.** `create` / `update` spread
  `...input`, so the new fields flow through once the schema and Prisma model know
  them.
- `rfq.service.ts` (the explicit `FreightForwarderDto` mapper, ~line 188) — **must**
  add `city`, `postalCode`, `country` to the mapped object, or the `(f):
  FreightForwarderDto =>` annotation fails to type-check.
- Controller / RBAC — unchanged.

## 7. Frontend — `FreightForwarderFormPage.tsx`

### 7.1 Field changes
- Rename the label `Company address` → **`Street Address`**. The `id` and
  `register("companyAddress")` binding are unchanged.
- Add City, Postal code, Country inputs.
- Add all three to the edit-mode `reset({ ... })` mapping so they hydrate when
  editing.

### 7.2 Layout — three logical sections, two-column grid

Container `max-w-2xl`; each section is a `grid sm:grid-cols-2 gap-x-4 gap-y-3` that
collapses to one column on narrow screens (`grid-cols-1`). Each section has a subtle
one-line heading. No field spans full width.

**Section 1 · Company & contact**

| Left | Right |
|------|-------|
| Company name | Person in charge |
| Contact number | Email |

**Section 2 · Address**

| Left | Right |
|------|-------|
| Street Address | City |
| Postal code | Country |

**Section 3 · Service & commercial**

| Left | Right |
|------|-------|
| Available countries | Modes |
| Default currency | VAT / TRN / EORI |
| Warehouse location | Payment terms |
| Typical lead time | Status |
| Handles DG (checkbox) | — |

- The two multi-selects (Available countries, Modes) render as half-width
  `MultiSelectCombobox` triggers side-by-side.
- "Handles DG" is the only lone-row control (a checkbox — inherently small, not a
  stretched input).

## 8. Testing

- **Shared** (`masters.test.ts`): the new fields are valid when omitted and accepted
  when present.
- **Frontend** (`FreightForwarderFormPage.test.tsx`): existing tests keep passing
  (new fields optional); add assertions that the **Street Address** label renders and
  that filling City/Postal/Country submits those values.
- **Backend e2e** (`freight-forwarders.e2e-spec.ts`): add a case that posts the
  address fields and asserts they round-trip on GET.
- Run `tsc` for `shared`, `api`, and `web` (per the per-task typecheck rule) — the
  `rfq.service` mapper is the specific spot that would otherwise break silently.

## 9. Out of Scope

- No field-name/column rename (`companyAddress` stays; label-only per D2).
- FF list table columns unchanged.
- FF portal / RFQ display of the address is unchanged beyond the DTO carrying the new
  fields.
- Country remains free text — no dropdown, no ISO validation.
