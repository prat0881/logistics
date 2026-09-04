# One-off cleanup: warehouses assigned to an owner but typed OWNED/CONTRACTED

**Status:** not run. Steps only — this is a destructive, manual production operation, deliberately
not automated and not part of any migration.

## Why this exists

The Warehouse master's `type` has been independent of ownership since it was built (design
decision D3: "Warehouse `type` is independent of ownership; linking happens from the Forwarder and
Client forms"). Nothing ever stopped a warehouse typed `OWNED` or `CONTRACTED` from being assigned
to a freight forwarder or a client.

As of 2026-09-04 the Warehouses picker on the Freight Forwarder and Client forms filters its
searchable pool by type — a forwarder draws from `FF`, a client from `CLIENT`. Rows that are
assigned but typed otherwise are now unreachable through search. They are still *listed* when
already assigned (`WarehousePicker` applies the filter to the pool, never to `assigned`), so
nothing is stranded, but they are inconsistent data and the user's decision is to delete them.

## What deleting one actually touches

- `WarehouseContact` and `WarehouseVehicle` — both `onDelete: Cascade`. They go with it.
- Nothing else. No transactional table references `Warehouse`; `WarehouseStagingLine` points at
  `Point`, not at this master. (This is the same fact recorded in the Masters handoff as
  "until the wizard/`Point` migration lands the Warehouse master has no consumer".)
- **`FreightForwarder.whLocation` is NOT maintained by the database.** It is a denormalised text
  column whose only writer is `FreightForwardersService.setWarehousesTx`, and `rfq.service.ts:308`
  snapshots it into every RFQ payload. Deleting a warehouse row behind the service's back leaves
  that column naming a warehouse that no longer exists. **Step 5 is not optional.**

## Steps

Run against production (Neon). Steps 1–2 are read-only.

### 1. See what would go

```sql
SELECT w.id, w.name, w.type, w.city, w.status,
       f."companyName" AS ff_owner, c."companyName" AS client_owner,
       (SELECT count(*) FROM "WarehouseContact" wc WHERE wc."warehouseId" = w.id) AS contacts,
       (SELECT count(*) FROM "WarehouseVehicle" wv WHERE wv."warehouseId" = w.id) AS vehicles
FROM "Warehouse" w
LEFT JOIN "FreightForwarder" f ON f.id = w."freightForwarderId"
LEFT JOIN "Client" c ON c.id = w."clientId"
WHERE (w."freightForwarderId" IS NOT NULL OR w."clientId" IS NOT NULL)
  AND w.type NOT IN ('FF', 'CLIENT')
ORDER BY w.name;
```

**Read the result before going further.** If it returns nothing, stop — there is nothing to clean
up, and the picker change alone is sufficient. If a row looks like real, maintained data rather
than a mis-tagged record, re-typing it (`UPDATE "Warehouse" SET type = 'FF' WHERE id = …`) is the
reversible alternative and needs no further steps.

### 2. Keep a copy

```bash
pg_dump "$DATABASE_URL" --data-only --table='"Warehouse"' --table='"WarehouseContact"' --table='"WarehouseVehicle"' > warehouse-backup-2026-09-04.sql
```

### 3. Delete, inside a transaction you can abandon

```sql
BEGIN;

DELETE FROM "Warehouse"
WHERE ("freightForwarderId" IS NOT NULL OR "clientId" IS NOT NULL)
  AND type NOT IN ('FF', 'CLIENT');
```

Check the reported row count against step 1's. If it does not match exactly, `ROLLBACK;` and work
out why before retrying. Otherwise `COMMIT;`.

### 4. Confirm

Re-run step 1's query. It must return zero rows.

### 5. Repair the derived `whLocation` column

Required, per the note above — the delete bypassed the service that maintains it. This recomputes
the column for **every** forwarder exactly as `setWarehousesTx` does (assigned warehouse names,
name-ordered, comma-joined, `NULL` when there are none), and is idempotent, so it is safe to run
whether or not step 3 removed anything:

```sql
UPDATE "FreightForwarder" f
SET "whLocation" = sub.names
FROM (
  SELECT ff.id,
         NULLIF(string_agg(w.name, ', ' ORDER BY w.name), '') AS names
  FROM "FreightForwarder" ff
  LEFT JOIN "Warehouse" w ON w."freightForwarderId" = ff.id
  GROUP BY ff.id
) sub
WHERE f.id = sub.id
  AND f."whLocation" IS DISTINCT FROM sub.names;
```

RFQs already sent keep the old snapshot — that is by design, they are historical records. Only
future RFQs read the corrected column.

## What is NOT closed by this

Nothing prevents the mismatch recurring through the API: `setWarehousesTx` accepts any warehouse
id regardless of type, and only the UI now filters. A server-side guard is a real contract change
(it would reject payloads the API accepts today, and existing e2e fixtures assign default-typed
warehouses), so it was left out of the 2026-09-04 fix batch deliberately. It belongs with the
deferred Stage-4 pass, where warehouse ownership is already in scope.
