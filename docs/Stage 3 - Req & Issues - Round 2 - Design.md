# Stage 3 — Req & Issues — Round 2 — Query Zone Decouple — Design

> Follow-up to the Round-1 **timezone** increment (PR #18). Live testing of the location-anchored model surfaced a real UX problem: the query-level Ready/Target and the first/last leg's Ready/Target are the same logical value entered twice, and rule **T2** forced them to be the *same UTC instant* — so entering Query Ready in IST and leg dates in SGT/London threw a validation error the exec had to hand-reconcile. This increment resolves that (per business discussion) and finishes the zone-picker UX. Sits next to `Stage 3 - Req & Issues - Round 1 - Design.md`.

## The model shift
- **Query Ready/Target = the client-agreed window**, each anchored to its **own explicit timezone** the exec picks (per the client discussion) — no longer derived from point zones.
- **Leg Ready/Target = the operational plan**, anchored to the origin/destination **point** zones (unchanged from Round 1).
- **The two are decoupled** — they no longer have to match (logistics timing depends on FF, transport availability, etc.). The old equality rule (T2) is removed.

## Business requirements (approved) → resolution
1. **Zone selectors on Query Ready + Query Target** so the exec sets the zone per the client discussion. → new explicit per-field zones (persisted).
2. **Remove the "leg == query" validation at Create** — actual Ready/Target legitimately differ from the plan. → remove **T2 only**.
3. **Stop mapping point zones onto the Step-1 Query dates** (not user-friendly; they have their own zone now). → Step-1 dates use their explicit zone, no point derivation.
4. **Searchable, user-friendly full-IANA zone picker** in Step 1 (and the Point editor, for consistency).
5. **Labels name the IANA zone**, not just the offset (`Times in GMT+5:30` → include the zone).

## Open decisions — resolved
- **(a)** ✅ **One zone per Query date** — Ready and Target each have their own zone (origin vs destination reality).
- **(b)** ✅ **Remove T2 only** — keep **T1** (a leg can't depart before the previous leg arrives), **T3** (hub convergence), and **Ready ≤ Target** at both query + leg level (compared as real UTC instants).
- **(c)** ✅ Default zone for the new Step-1 pickers = the **org default** (`Asia/Kolkata`) — nothing changes until an exec picks.
- **(d)** ✅ **ETA/ETB/ETD stay seaport-anchored** (else org) this round — out of scope.
- **(e)** ✅ **Full IANA list**, searchable (not a curated shortlist).
- **(f)** ✅ Query Ready/Target stay **mandatory** at Create (the client window); leg dates stay **optional** planning.
- **#5 label format** ✅ **IANA id + offset**: dropdown rows `Asia/Calcutta (GMT+05:30)`; hint `Times in Asia/Kolkata (GMT+05:30)`. List cells stay **compact** (padded offset only).

---

## Design detail

### 1. Data model + migration
- `Query` gains **`readyDateTimezone String?`** and **`targetDeliveryTimezone String?`** (IANA id), mirroring `Point.timezone`.
- Shared `querySaveSchema` + `QueryDetail`/`QueryListRow` DTOs add both (valid-IANA-when-present via the existing `isValidIanaZone`).
- Migration: add both columns; **backfill existing rows to `Asia/Kolkata`** (same pattern as the `Point.timezone` migration). No `timestamptz` change — datetime columns stay UTC `DateTime`.

### 2. Validation (shared `packages/shared/src/route.ts`)
- **Remove the two T2 findings** (currently `route.ts:287–291` — "First leg … must equal the query Ready Date" / "Last leg … must equal the query Target Delivery").
- **Keep** T1 (inter-leg sequencing), T3 (hub convergence), and the query-level + leg-level `readyDate ≤ targetDelivery` (G10) — all compared as real UTC instants, so they remain correct across zones.
- Remove/adjust any test that asserts T2 fires. The Create-Query gate no longer blocks on a query-vs-leg date mismatch.

### 3. Zone resolution (web `apps/web/src/lib/zones.ts`)
- `resolveQueryFieldZone`: **`readyDate` → `readyDateTimezone`**, **`targetDelivery` → `targetDeliveryTimezone`** (the explicit fields; **no first/last-point derivation** — this also removes the "field re-labels itself when you add a point" surprise). Fall back to org zone when the explicit zone is null.
- **Unchanged:** leg Ready→origin-point zone / Target→dest-point zone; ETA/ETB/ETD→first SEAPORT (else org); Response Deadline→org; system/audit times→viewer.

### 4. UI
- **Step 1 (`Step1Client.tsx`):** a searchable **zone picker** beside **Query Ready** and beside **Query Target** (RHF fields `readyDateTimezone` / `targetDeliveryTimezone`; default = org zone via `useOrgTimezone`, seeded only-when-empty like the Point editor). The `ZonedDateTimeField` for those two dates reads its zone from the sibling picker.
- **Point editor (`PointEditor.tsx`):** replace the plain ~400-row `Select` with the **same searchable combobox** (consistency; also retires the current-value-merge workaround).
- **Reusable `TimezoneCombobox`** (new, `apps/web/src/components/`): built on the existing cmdk `Command` (as `ClientPicker`/`VesselPicker` are). Options = `Intl.supportedValuesOf("timeZone")`; each row renders **`<IANA id> (<offset>)`** e.g. `Asia/Calcutta (GMT+05:30)`; substring search matches id / city / region / offset digits, **plus a small alias keyword map** (e.g. `Asia/Calcutta` also matches "kolkata") so common aliases are findable. Value = the IANA id. Always keeps the current value selectable (handles a stored id absent from the runtime list).

### 5. Labels / hint (`packages/shared/src/timezone.ts` + `ZonedDateTimeField.tsx`)
- `zoneLabel(zone)` → **padded offset** `GMT+05:30` (switch `timeZoneName: "short"` → `"longOffset"`).
- Field **hint** → **`Times in <IANA id> (<offset>)`** e.g. `Times in Asia/Kolkata (GMT+05:30)` — composed at the hint site (the `zone` id is in scope), on Step 1, legs, and the point editor.
- **Query List** cells keep the compact padded offset (via `formatInZone` → `zoneLabel`) — no IANA id (the "Times in…" hint is where the id belongs).

### 6. Testing
- **Shared (unit):** the new Query zone fields in `querySaveSchema`; T2 removal (a formerly-T2-flagged mismatch now yields no T2 finding; T1/T3/G10 still fire on their own cases); `zoneLabel` padded-offset format.
- **Web (integration):** `TimezoneCombobox` (search "Calcutta", "Kolkata"→alias, "530", pick a value); Step-1 Ready/Target zone pickers + their `ZonedDateTimeField` reading the picked zone; the `Times in <IANA> (<offset>)` hint; `resolveQueryFieldZone` using the explicit query zones. Drive the hidden input for cmdk where jsdom is flaky.
- **API (e2e — runs on CI, no local DB):** query create/read round-trips `readyDateTimezone`/`targetDeliveryTimezone`; the migration; update the specs that build a complete route so they no longer expect a T2 finding (they should now Create-succeed even with a query/leg date mismatch).

### 7. Scope / flow / branch
- Branch **`feat/plan-6b-req-issues-round2-query-zones`** off `main` (has #18 + #19). **Carries a Prisma migration.** ~10–12 tasks.
- Flow: this design → `writing-plans` → `subagent-driven-development` + **opus** whole-branch review → PR. Reuse the Round-1 conventions (native `Intl`; the "build `@svyft/shared` before web vitest" gotcha; api e2e on CI).
- **This settles the timezone model** — after it: query dates = explicit-zone client window; points/legs = location-anchored plan; T1/T3 physical checks retained; friendly searchable IANA pickers + id-labelled hints. No further timezone churn expected.

## Deferred / out of scope
- ETA/ETB/ETD explicit zones (stay seaport-derived).
- IANA id in Query List cells (kept compact by decision).
- A curated zone shortlist (rejected — full IANA + search chosen).
- Carried from Round 1: retire `ChecklistDefinition.dgConditional`; the `msds-received`-on-non-DG confirm; the not-yet-browser-verified-E2E closing smoke-test.
