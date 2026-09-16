# Post-deploy corrections — freight forwarder terms

> **✅ CLOSED — applied 2026-09-01.** All three corrections below were verified and applied
> through the production admin UI (the rebuilt Freight Forwarder form): the two forwarders'
> payment terms, all 23 lead times, and the single `'Not recorded'` address component.
> **Do not re-apply.** This file is kept as the provenance record of what was changed and why,
> because the pre-deploy capture it derives from is the only place the original text ever
> existed.

**Applies to:** the first production deploy of `feat/masters`.
**Decided by the user, 2026-08-26:** deploy as-is and correct through the admin UI afterwards,
rather than amending the migration.

## Why this file exists

Migration `20260826093000_ff_contacts_and_terms` converts two free-text columns to typed ones
and **drops the source columns in the same transaction**. Two conversions are known-lossy. Once
the migration runs, the original text no longer exists anywhere in the database, so the
corrections below cannot be derived after the fact — they have to be applied from this record.

Confirmed against Neon before merge: 23 forwarders, all 23 carrying both values.

## 1. Payment terms — two forwarders will be wrong

Six of the eight distinct values convert correctly. These two do not:

| Original text | Becomes | Should be |
|---|---|---|
| `50% ADVANCE / 50% ON DELIVERY` | `100% Advance` | **50% Advance : 50% After Delivery** |
| `50% ADVANCE / 50% ON BL` | `100% Advance` | **50% Advance : 50% After Delivery** |

Both hit the migration's generic `ILIKE '%advance%'` branch, which predates the three
advance-split enum values and matches none of them.

`50% ON BL` is payment against the bill of lading, not against delivery. The enum has no term
for it; `ADVANCE_50_BALANCE_50` is the closest available and records the split correctly even
though it names the trigger differently. Worth revisiting if BL-triggered terms become common.

**Correcting these needs the pre-deploy capture**, because `ADVANCE PAYMENT` — which is
genuinely 100% advance — converts to the same value. Without the capture, the three are
indistinguishable.

Correct conversions, for reference: `NET 15` → 15 Days Credit, `NET 30` → 30 Days Credit,
`NET 45` → 45 Days Credit, `NET 60` → 60 Days Credit, `ADVANCE PAYMENT` → 100% Advance,
empty string → null.

## 2. Lead times — all 23 land on the optimistic end

Every production value is a range: `18-24d`, `3-5d`, `12-16d`, `2d`, and so on. The migration's
regex takes the leading digits, so `18-24d` becomes **18**, not 24.

That understates every range. For a freight system the understated direction is the one that
causes missed commitments, so if these are ever treated as real, the high end is the safer
reading. Correcting means re-entering the upper bound of each range from the pre-deploy capture.

Single values (`2d`, `3d`) convert correctly. The empty string becomes null, correctly.

## 3. One address placeholder

Exactly one forwarder is missing an address component and will receive `'Not recorded'` in
`companyAddress`, `city` or `country`. It is visible in the admin screen and correctable there —
no capture needed, since the placeholder is self-identifying.

## What was verified clean and needs no correction

- **Vessels:** 1 row, no missing IMO, no missing shipping line. No generated `8000xxx` IMO will
  be written to production, and no `'Unknown'` carrier.
- **Client contacts:** 0 missing email or phone. No `not.recorded@example.invalid`, no
  `+10000000000`.
- **Primary contacts:** no client has more than one, so the partial unique index builds and the
  deploy will not abort mid-migration.
- **Clients:** 2 rows, both complete.
- **Charge catalogue:** production holds exactly the 51 seeded definitions, because the
  catalogue was read-only before this branch. The three new always-included lines ship inactive,
  so the deploy changes no pricing.
