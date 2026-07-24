# Query Zone Decouple (Plan 6b · Round-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Query's Ready/Target dates their own explicit, exec-chosen timezone (decoupled from point zones), remove the "leg must equal query" rule (T2), and ship a searchable full-IANA zone picker with IANA-id + offset labels.

**Architecture:** Two new `String?` timezone columns on `Query` (backfilled to the org default) + shared-schema/DTO fields; the shared route engine drops T2 (keeps T1/T3/Ready≤Target); the web resolves Step-1 Ready/Target zones from those explicit fields (not points); a reusable cmdk-based `TimezoneCombobox` replaces the plain Point-editor Select and adds Step-1 pickers; `zoneLabel` and the "Times in…" hint gain the IANA id + a padded offset.

**Tech Stack:** pnpm monorepo · `@svyft/shared` (zod, vitest) · NestJS 10 + Prisma 5 (Postgres) · Vite/React 18 + RHF + zodResolver + shadcn + **cmdk** + TanStack Query · native `Intl`.

## Global Constraints

- Design of record: `docs/Stage 3 - Req & Issues - Round 2 - Design.md`. Decisions: (a) **one zone per Query date** (Ready/Target independent); (b) **remove T2 only** — keep T1, T3, Ready≤Target; (c) new Step-1 zone pickers default to the **org default** (`Asia/Kolkata`); (d) ETA/ETB/ETD stay seaport-anchored; (e) **full IANA list**, searchable; (f) Query Ready/Target stay **mandatory** at Create, leg dates optional.
- **No new datetime library.** Native `Intl` only.
- **Label formats (exact):** dropdown row = `` `${zone} (${zoneLabel(zone)})` `` → e.g. `Asia/Calcutta (GMT+05:30)`; field hint = `` `Times in ${zone} (${zoneLabel(zone)})` `` → e.g. `Times in Asia/Kolkata (GMT+05:30)`. `zoneLabel` returns a **padded offset** `GMT+05:30` (`timeZoneName: "longOffset"`). Query List cells stay compact (offset only, via `formatInZone`).
- **New Query columns:** `readyDateTimezone`, `targetDeliveryTimezone` (`String?`, IANA id). Operational datetime columns stay Prisma `DateTime` (UTC) — no `timestamptz`.
- `queryImpactMap` is typed `Record<keyof QuerySaveInput, ImpactClass>` — adding a schema field REQUIRES a map entry or the api won't typecheck.
- Enums/const-arrays keep the project pattern. Zod bound at param level via `ZodValidationPipe`.
- **Build gotcha:** web **vitest** resolves `@svyft/shared` from **dist** → `pnpm --filter @svyft/shared build` before any web test importing new shared code, and before the local gate (root `pnpm run ci` runs `test` before `build`). api e2e maps `@svyft/shared`→source.
- **No local DB this session:** the Prisma migration is **hand-authored** + `prisma generate`/`validate` offline (load env from `apps/api/.env`); the api e2e + `migrate deploy` run on **GitHub CI** (the authoritative gate). Migration folder timestamp must sort after `20260722174953_timezone` (use `date -u +%Y%m%d%H%M%S`).
- **KNOWN FLAKE:** `QueriesToolbar.test.tsx` date-range test (react-day-picker/jsdom) — re-run once if it trips.
- **Gate:** `pnpm --filter @svyft/shared build && pnpm run ci` green (lint · typecheck · shared/web tests · build; api e2e on CI). Commit per task (conventional commits).
- **Branch:** `feat/plan-6b-req-issues-round2-query-zones` off `main` (already cut). Plan doc + implementation ship as one PR.

## File Structure

**Create**
- `apps/web/src/components/TimezoneCombobox.tsx` — reusable searchable IANA zone combobox (+ `TimezoneCombobox.test.tsx`).
- `prisma/migrations/<ts>_query_zones/migration.sql` — add the two Query columns + backfill.

**Modify**
- `packages/shared/src/query.ts` — `readyDateTimezone`/`targetDeliveryTimezone` in `querySaveSchema` + `QueryDetail`.
- `packages/shared/src/timezone.ts` — `zoneLabel` → padded offset (`longOffset`).
- `packages/shared/src/route.ts` — remove the two T2 findings + the now-unused `firstLeg`/`lastLeg`.
- `prisma/schema.prisma` — Query gains the two zone columns.
- `apps/api/src/modules/queries/query.impact.ts` — classify the two new fields.
- `apps/api/test/queries.e2e-spec.ts` / `create-query-route.e2e-spec.ts` — a decoupling test + de-stale the T2 comments.
- `apps/web/src/lib/zones.ts` — Step-1 Ready/Target resolve from the explicit query zones.
- `apps/web/src/components/ZonedDateTimeField.tsx` — hint = `Times in <IANA> (<offset>)`.
- `apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx` — Select → `TimezoneCombobox`.
- `apps/web/src/features/query-wizard/steps/Step1Client.tsx` — two zone pickers + wire the watched zones.

---

## Task 1: Shared — Query zone fields + padded `zoneLabel`

**Files:**
- Modify: `packages/shared/src/query.ts`
- Modify: `packages/shared/src/timezone.ts`
- Test: `packages/shared/src/query.test.ts`, `packages/shared/src/timezone.test.ts`

**Interfaces — Produces:** `querySaveSchema` gains optional `readyDateTimezone`/`targetDeliveryTimezone` (valid-IANA when present); `QueryDetail` gains both (`string | null`); `zoneLabel(zone)` returns a padded offset like `GMT+05:30`.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/src/query.test.ts  (add)
import { querySaveSchema } from "./query";
describe("Query timezone fields", () => {
  it("accepts valid IANA zones on readyDate/targetDelivery timezone; rejects junk", () => {
    expect(querySaveSchema.safeParse({ readyDateTimezone: "Asia/Singapore", targetDeliveryTimezone: "Europe/London" }).success).toBe(true);
    expect(querySaveSchema.safeParse({ readyDateTimezone: "Not/AZone" }).success).toBe(false);
  });
  it("leaves them optional (empty draft still valid)", () => {
    expect(querySaveSchema.safeParse({}).success).toBe(true);
  });
});
```

```typescript
// packages/shared/src/timezone.test.ts  (add / adjust)
import { zoneLabel } from "./timezone";
describe("zoneLabel padded offset", () => {
  it("returns a padded GMT offset for fixed-offset zones", () => {
    expect(zoneLabel("Asia/Kolkata")).toBe("GMT+05:30");
    expect(zoneLabel("Asia/Singapore")).toBe("GMT+08:00");
    expect(zoneLabel("UTC")).toMatch(/GMT|UTC/);
  });
});
```
(If an existing `zoneLabel` test asserts the old short form `"GMT+5:30"`, update it to the padded `"GMT+05:30"`.)

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared test` → FAIL (fields missing / label unpadded).

- [ ] **Step 3: Implement `query.ts`** — in `querySaveSchema`'s object (after `targetDelivery: isoDate,`), add:

```typescript
    readyDateTimezone: z.string().refine(isValidIanaZone, { message: "Must be a valid IANA timezone" }),
    targetDeliveryTimezone: z.string().refine(isValidIanaZone, { message: "Must be a valid IANA timezone" }),
```
Add the import at the top of `query.ts` if not present: `import { isValidIanaZone } from "./timezone";`
Then add to the `QueryDetail` type (after `targetDelivery: string | null;`):

```typescript
  readyDateTimezone: string | null;
  targetDeliveryTimezone: string | null;
```

- [ ] **Step 4: Implement `timezone.ts` `zoneLabel`** — change the formatter option from `"short"` to `"longOffset"`:

```typescript
export function zoneLabel(zone: string, atUtcIso?: string): string {
  const d = atUtcIso ? new Date(atUtcIso) : new Date(0);
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(Number.isNaN(d.getTime()) ? new Date(0) : d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}
```

- [ ] **Step 5: Run to verify pass** — `pnpm --filter @svyft/shared test` → PASS; `pnpm --filter @svyft/shared typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/query.ts packages/shared/src/timezone.ts packages/shared/src/query.test.ts packages/shared/src/timezone.test.ts
git commit -m "feat(shared): Query readyDate/targetDelivery timezone fields + padded zoneLabel offset"
```

---

## Task 2: Shared — remove T2 from the route engine

**Files:**
- Modify: `packages/shared/src/route.ts`
- Test: `packages/shared/src/route.test.ts`

**Interfaces:** `validateRoute` no longer emits `T2` findings; T1 (inter-leg), T3 (hub), and Ready≤Target are unchanged.

- [ ] **Step 1: Write/adjust the failing test** — a query whose Ready/Target differ from the first/last leg no longer produces a T2 finding, and T1 still fires on its own case:

```typescript
// packages/shared/src/route.test.ts  (add)
describe("T2 removed — query dates decoupled from legs", () => {
  it("does NOT flag when leg dates differ from the query dates", () => {
    const g = validGraph();
    // Deliberately mismatch: first leg ready ≠ query ready, last leg target ≠ query target.
    g.legs[0].readyDate = "2026-08-02T00:00:00.000Z"; // query readyDate is 2026-08-01
    g.legs[1].targetDelivery = "2026-08-09T00:00:00.000Z"; // query targetDelivery is 2026-08-10
    expect(validateRoute(g, "create").map((f) => f.rule)).not.toContain("T2");
    // still a clean route otherwise (chain intact, T1 order preserved)
    expect(validateRoute(g, "create")).toEqual([]);
  });
});
```
(The existing "returns no findings for a complete valid route" test still passes — it just no longer relies on T2.)

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared test -- route` → FAIL (T2 still fires on the mismatch).

- [ ] **Step 3: Remove T2 (and its now-unused vars) in `route.ts`.** Delete the two T2 pushes:

```typescript
    // T2 — first leg readyDate = query readyDate; last leg targetDelivery = query targetDelivery.
    if (!broke && firstLeg && !sameInstant(firstLeg.readyDate, graph.query.readyDate))
      findings.push({ rule: "T2", severity: sev(), scope: { type: "leg", id: firstLeg.id }, message: `First leg ${firstLeg.legCode} Ready Date must equal the query Ready Date` });
    if (!broke && lastLeg && !sameInstant(lastLeg.targetDelivery, graph.query.targetDelivery))
      findings.push({ rule: "T2", severity: sev(), scope: { type: "leg", id: lastLeg.id }, message: `Last leg ${lastLeg.legCode} Target Delivery must equal the query Target Delivery` });
```
Then remove the now-unused `firstLeg`/`lastLeg` tracking: delete the declarations `let firstLeg: RouteLeg | null = null;` and `let lastLeg: RouteLeg | null = null;`, and the assignments inside the chain-walk loop `if (!firstLeg) firstLeg = leg;` and `lastLeg = leg;`. (Leave `prevLeg` and the T1 block intact.) If `sameInstant` is now unused anywhere, leave it — it may be used by T3; verify with a grep and only remove if truly unused.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @svyft/shared test` → PASS; `pnpm --filter @svyft/shared lint` → clean (no unused `firstLeg`/`lastLeg`); `pnpm --filter @svyft/shared typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/route.ts packages/shared/src/route.test.ts
git commit -m "feat(shared): remove T2 (query==leg equality); keep T1/T3/Ready<=Target"
```

---

## Task 3: Prisma migration + Query impact map

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_query_zones/migration.sql`
- Modify: `apps/api/src/modules/queries/query.impact.ts`

**Interfaces — Consumes:** `querySaveSchema` gained the two fields (Task 1). **Produces:** `Query.readyDateTimezone`/`targetDeliveryTimezone` columns (backfilled); impact map complete.

- [ ] **Step 1: Edit `prisma/schema.prisma`** — in `model Query`, after `targetDelivery DateTime?`, add:

```prisma
  readyDateTimezone       String?
  targetDeliveryTimezone  String?
```

- [ ] **Step 2: Hand-author the migration** (no local DB). Create `prisma/migrations/<TS>_query_zones/migration.sql` where `<TS>` = `date -u +%Y%m%d%H%M%S` (must sort after `20260722174953_timezone`):

```sql
-- AlterTable: explicit per-Query timezones for the client-agreed Ready/Target window
ALTER TABLE "Query" ADD COLUMN "readyDateTimezone" TEXT;
ALTER TABLE "Query" ADD COLUMN "targetDeliveryTimezone" TEXT;

-- Stamp existing rows with the org default zone
UPDATE "Query" SET "readyDateTimezone" = 'Asia/Kolkata' WHERE "readyDateTimezone" IS NULL;
UPDATE "Query" SET "targetDeliveryTimezone" = 'Asia/Kolkata' WHERE "targetDeliveryTimezone" IS NULL;
```

- [ ] **Step 3: Add the impact-map entries** — in `apps/api/src/modules/queries/query.impact.ts`, add to `queryImpactMap` (Corrective — a display-anchor label change doesn't alter the UTC instant an FF quotes against, mirroring `eta`/`etb`/`etd`):

```typescript
  readyDateTimezone: ImpactClass.Corrective,
  targetDeliveryTimezone: ImpactClass.Corrective,
```

- [ ] **Step 4: Regenerate + verify offline** —

```bash
set -a && . apps/api/.env && set +a
pnpm exec prisma validate
pnpm exec prisma generate
pnpm --filter @svyft/shared build
pnpm --filter @svyft/api typecheck   # proves the impact map is complete + client has the columns
```
Do NOT run `migrate dev` (needs a DB — CI applies it).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/src/modules/queries/query.impact.ts
git commit -m "chore(prisma): Query readyDate/targetDelivery timezone columns + impact map"
```

---

## Task 4: API — persist zones + decoupling e2e

Persistence needs no service change (`toData` spreads `...input`; the two string fields flow through `query.create`/`update`). This task proves it and proves T2 is gone.

**Files:**
- Modify: `apps/api/test/queries.e2e-spec.ts` (+ optionally `create-query-route.e2e-spec.ts`)

- [ ] **Step 1: Add the e2e cases** (they run on CI). In `queries.e2e-spec.ts`:
  1. **Persist:** POST a query with `readyDateTimezone: "Asia/Singapore"`, `targetDeliveryTimezone: "Europe/London"` → 201; GET it back → those values round-trip.
  2. **Decouple:** build a complete route where the **leg dates differ** from the query `readyDate`/`targetDelivery`, then `POST /create` → **201 RFQ_READY** (previously 422 under T2). Mirror the existing `validQuery`/complete-route setup in the file, but set the leg `readyDate`/`targetDelivery` to instants that differ from the query's.

```typescript
it("round-trips readyDateTimezone / targetDeliveryTimezone", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/queries").set("Cookie", cookie(Role.EXECUTIVE))
    .send({ shipmentDescription: `${PFX}tz`, readyDateTimezone: "Asia/Singapore", targetDeliveryTimezone: "Europe/London" })
    .expect(201);
  const got = await request(app.getHttpServer())
    .get(`/api/queries/${res.body.id}`).set("Cookie", cookie(Role.EXECUTIVE)).expect(200);
  expect(got.body.readyDateTimezone).toBe("Asia/Singapore");
  expect(got.body.targetDeliveryTimezone).toBe("Europe/London");
});

it("Create succeeds even when leg dates differ from the query dates (T2 removed)", async () => {
  // ... build the same complete Pickup->Delivery route as the existing RFQ_READY test,
  // BUT set the leg readyDate/targetDelivery to instants that differ from the query's
  // (e.g. query ready 2026-08-01 / target 2026-08-20; leg ready 2026-08-03 / target 2026-08-18).
  // Then:
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/create`).set("Cookie", cookie(Role.EXECUTIVE))
    .expect(201);
  expect(res.body.status).toBe("RFQ_READY");
});
```

- [ ] **Step 2: De-stale the T2 comments** — in `queries.e2e-spec.ts` / `create-query-route.e2e-spec.ts`, update the comments that say "leg dates match the query's readyDate/targetDelivery (T2: first/last leg dates = query dates)" to note T2 was removed and the match is now incidental.

- [ ] **Step 3: Verify locally what you can** — `pnpm --filter @svyft/api typecheck` → clean. (The e2e itself runs on CI — no local DB; note this in the report.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/queries.e2e-spec.ts apps/api/test/create-query-route.e2e-spec.ts
git commit -m "test(api): round-trip Query zones + Create succeeds with decoupled leg dates (T2 gone)"
```

---

## Task 5: Web — Step-1 Ready/Target resolve from explicit query zones

**Files:**
- Modify: `apps/web/src/lib/zones.ts`
- Test: `apps/web/src/lib/zones.test.ts`

**Interfaces — Produces:** `resolveQueryFieldZone("readyDate", graph, orgZone)` returns `graph.readyDateTimezone` (else org); `"targetDelivery"` returns `graph.targetDeliveryTimezone` (else org). `GraphLike` gains the two optional zone fields.

- [ ] **Step 1: Update the failing tests** — the existing `readyDate → first point` / `targetDelivery → last point` cases change:

```typescript
// apps/web/src/lib/zones.test.ts  (replace the readyDate/targetDelivery query-zone cases)
it("readyDate → the query's explicit readyDateTimezone, else org", () => {
  expect(resolveQueryFieldZone("readyDate", { points: [], legs: [] }, "Asia/Kolkata")).toBe("Asia/Kolkata");
  expect(resolveQueryFieldZone("readyDate", { points: [], legs: [], readyDateTimezone: "Asia/Singapore" }, "Asia/Kolkata")).toBe("Asia/Singapore");
});
it("targetDelivery → the query's explicit targetDeliveryTimezone, else org", () => {
  expect(resolveQueryFieldZone("targetDelivery", { points: [], legs: [], targetDeliveryTimezone: "Europe/London" }, "Asia/Kolkata")).toBe("Europe/London");
});
```
(Remove the old first/last-point assertions for these two fields; leg + seaport + viewer cases stay.)

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/web test -- zones` → FAIL.

- [ ] **Step 3: Implement `zones.ts`** — extend `GraphLike` and the two cases:

```typescript
type GraphLike = {
  points: PointLike[];
  legs: LegLike[];
  readyDateTimezone?: string | null;
  targetDeliveryTimezone?: string | null;
};
// ... in resolveQueryFieldZone:
    case "readyDate":
      return graph.readyDateTimezone || orgZone;
    case "targetDelivery":
      return graph.targetDeliveryTimezone || orgZone;
```
(Delete the old `pts.length ? zoneOf(pts[0]/pts[last]) : orgZone` lines for those two cases.)

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- zones` → PASS; `pnpm --filter @svyft/web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/zones.ts apps/web/src/lib/zones.test.ts
git commit -m "feat(web): Step-1 Ready/Target zones resolve from explicit query fields (not points)"
```

---

## Task 6: Web — `ZonedDateTimeField` hint = `Times in <IANA> (<offset>)`

**Files:**
- Modify: `apps/web/src/components/ZonedDateTimeField.tsx`
- Test: `apps/web/src/components/ZonedDateTimeField.test.tsx`

- [ ] **Step 1: Update the failing test** — the hint now names the zone:

```typescript
it("shows the IANA zone + offset in the hint", () => {
  render(<Harness zone="Asia/Kolkata" initial="2026-06-15T03:30:00.000Z" />);
  expect(screen.getByText(/Times in Asia\/Kolkata \(GMT\+05:30\)/)).toBeInTheDocument();
});
```
(Update any existing hint assertion that expects the bare `Times in GMT…`.)

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- ZonedDateTimeField` → FAIL.

- [ ] **Step 3: Implement** — change the hint line:

```tsx
          <p className="text-xs text-muted-foreground">
            Times in {zone} ({zoneLabel(zone)})
          </p>
```

- [ ] **Step 4: Run to verify pass** — build shared + `pnpm --filter @svyft/web test -- ZonedDateTimeField` → PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ZonedDateTimeField.tsx apps/web/src/components/ZonedDateTimeField.test.tsx
git commit -m "feat(web): datetime hint names the IANA zone + offset"
```

---

## Task 7: Web — `TimezoneCombobox` (searchable full-IANA picker)

**Files:**
- Create: `apps/web/src/components/TimezoneCombobox.tsx`
- Test: `apps/web/src/components/TimezoneCombobox.test.tsx`

**Interfaces — Produces:** `<TimezoneCombobox value={string|undefined} onChange={(z: string) => void} ariaLabel?={string} />` — a cmdk Popover+Command over the full IANA list; rows `Asia/Calcutta (GMT+05:30)`; search matches id/city/region/offset + alias keywords; always keeps `value` selectable.

- [ ] **Step 1: Write the failing test** (rebuild shared first — imports `zoneLabel`):

```tsx
// apps/web/src/components/TimezoneCombobox.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimezoneCombobox } from "./TimezoneCombobox";

describe("TimezoneCombobox", () => {
  it("shows the selected zone + offset on the trigger", () => {
    render(<TimezoneCombobox value="Asia/Kolkata" onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("Asia/Kolkata (GMT+05:30)");
  });
  it("searches by city and selects (type 'Singapore')", async () => {
    const onChange = vi.fn();
    render(<TimezoneCombobox value={undefined} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByPlaceholderText(/search timezone/i), "Singapore");
    await userEvent.click(await screen.findByText(/Asia\/Singapore \(GMT\+08:00\)/));
    expect(onChange).toHaveBeenCalledWith("Asia/Singapore");
  });
  it("finds Asia/Calcutta via the 'kolkata' alias keyword", async () => {
    render(<TimezoneCombobox value={undefined} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByPlaceholderText(/search timezone/i), "kolkata");
    expect(await screen.findByText(/Asia\/(Calcutta|Kolkata) \(GMT\+05:30\)/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail** — build shared + `pnpm --filter @svyft/web test -- TimezoneCombobox` → FAIL (module missing).

- [ ] **Step 3: Implement `TimezoneCombobox.tsx`** (mirrors `ClientPicker`; uses cmdk's built-in filtering over `value` + `keywords`):

```tsx
// apps/web/src/components/TimezoneCombobox.tsx
import { useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { zoneLabel } from "@svyft/shared";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const IANA_ZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];

// Minimal alias keywords so common non-canonical names still find the row.
const ALIASES: Record<string, string[]> = {
  "Asia/Calcutta": ["kolkata"],
  "Asia/Kolkata": ["calcutta"],
};

const city = (z: string) => z.split("/").pop()!.replace(/_/g, " ");
const region = (z: string) => z.split("/")[0];

interface Props {
  value?: string;
  onChange: (zone: string) => void;
  ariaLabel?: string;
}

export function TimezoneCombobox({ value, onChange, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const zones = useMemo(
    () => (value && !IANA_ZONES.includes(value) ? [value, ...IANA_ZONES] : IANA_ZONES),
    [value],
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="button" aria-label={ariaLabel ?? "Select timezone"} className="w-full justify-between font-normal">
          {value ? `${value} (${zoneLabel(value)})` : "Select timezone…"}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search timezone…" />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            <CommandGroup>
              {zones.map((z) => (
                <CommandItem
                  key={z}
                  value={z}
                  keywords={[city(z), region(z), zoneLabel(z), ...(ALIASES[z] ?? [])]}
                  onSelect={() => {
                    onChange(z);
                    setOpen(false);
                  }}
                >
                  {z} ({zoneLabel(z)})
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Run to verify pass** — build shared + `pnpm --filter @svyft/web test -- TimezoneCombobox` → PASS; typecheck clean. (If cmdk's fuzzy filter is jsdom-flaky on a 400-item list, assert via `findByText` with a longer timeout; the search input drives cmdk's built-in filter over `value` + `keywords`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/TimezoneCombobox.tsx apps/web/src/components/TimezoneCombobox.test.tsx
git commit -m "feat(web): searchable full-IANA TimezoneCombobox (id + offset rows, alias keywords)"
```

---

## Task 8: Web — Point editor uses `TimezoneCombobox`

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx`
- Test: `apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx`

**Interfaces — Consumes:** `TimezoneCombobox` (Task 7).

- [ ] **Step 1: Update the failing test** — the timezone field is now the combobox (trigger shows `<zone> (<offset>)`); the existing default-org and edit-shows-zone tests assert against the trigger text `Asia/Kolkata (GMT+05:30)` / the point's zone. Keep the `RequiredMark`. (Drop assertions tied to the old `data-testid="timezone-trigger"` `<select>`; assert on the combobox button text instead.)

- [ ] **Step 2: Run to verify fail** — build shared + `pnpm --filter @svyft/web test -- PointEditor` → FAIL.

- [ ] **Step 3: Implement** — replace the whole `timezone` `FormField` render body (the `zoneOptions`/`<Select>` block) with the combobox; the seeding `useEffect` and the PR #19 delete-guard stay untouched:

```tsx
<FormField
  control={form.control}
  name="timezone"
  render={({ field }) => (
    <FormItem>
      <FormLabel>
        Timezone
        <RequiredMark field="timezone" type={activeType} />
      </FormLabel>
      <FormControl>
        <TimezoneCombobox value={field.value ?? undefined} onChange={field.onChange} ariaLabel="Point timezone" />
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>
```
Add `import { TimezoneCombobox } from "@/components/TimezoneCombobox";`. Remove the now-dead `IANA_ZONES` const and the `Select`/`SelectItem` imports **only if** no longer used elsewhere in the file (grep first — the point `type` field may still use `Select`).

- [ ] **Step 4: Run to verify pass** — build shared + `pnpm --filter @svyft/web test -- PointEditor` → PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx
git commit -m "feat(web): Point editor uses the searchable TimezoneCombobox"
```

---

## Task 9: Web — Step 1 Query Ready/Target zone pickers

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.tsx`
- Test: `apps/web/src/features/query-wizard/steps/Step1Client.test.tsx`

**Interfaces — Consumes:** `TimezoneCombobox` (T7); `resolveQueryFieldZone` now reads the query zones (T5); `querySaveSchema` fields (T1).

Behavior: a `TimezoneCombobox` sits beside **Query Ready** and beside **Query Target**, bound to RHF fields `readyDateTimezone` / `targetDeliveryTimezone`. Each defaults to the org zone (seed-when-empty, like PointEditor). The Ready/Target `ZonedDateTimeField`s interpret their wall-clock in the **currently-picked** zone (watched), so changing the picker re-labels/re-interprets immediately.

- [ ] **Step 1: Write the failing test** — render `Step1Client` (stub `/api/config/org-timezone` → `Asia/Kolkata`); assert a Ready-zone and a Target-zone picker render defaulting to `Asia/Kolkata (GMT+05:30)`, and that the Ready field's hint reflects the picked zone. Rebuild shared first.

- [ ] **Step 2: Run to verify fail** — build shared + `pnpm --filter @svyft/web test -- Step1Client` → FAIL.

- [ ] **Step 3: Implement.** Add the import `import { TimezoneCombobox } from "@/components/TimezoneCombobox";`. Feed the watched query zones into the graph so `zoneFor` resolves them live:

```typescript
const watchedReadyTz = form.watch("readyDateTimezone");
const watchedTargetTz = form.watch("targetDeliveryTimezone");
const graph = {
  points: detail?.points ?? [],
  legs: detail?.legs ?? [],
  readyDateTimezone: watchedReadyTz,
  targetDeliveryTimezone: watchedTargetTz,
};
// zoneFor stays: (f) => resolveQueryFieldZone(f, graph, orgZone)
```
Seed the two zone fields to the org zone when empty (mirror PointEditor's guard; `useOrgTimezone` returns `{ orgZone, isLoading }`):

```typescript
useEffect(() => {
  if (!isLoading && orgZone) {
    if (!form.getValues("readyDateTimezone")) form.setValue("readyDateTimezone", orgZone);
    if (!form.getValues("targetDeliveryTimezone")) form.setValue("targetDeliveryTimezone", orgZone);
  }
}, [isLoading, orgZone, form]);
```
Render a picker next to each date (Ready shown; Target identical with `targetDeliveryTimezone`):

```tsx
{/* Ready Date */}
<ZonedDateTimeField control={form.control} name="readyDate" label="Ready Date" zone={zoneFor("readyDate")} required />
<FormField
  control={form.control}
  name="readyDateTimezone"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Ready Date timezone</FormLabel>
      <FormControl>
        <TimezoneCombobox value={field.value ?? undefined} onChange={field.onChange} ariaLabel="Ready Date timezone" />
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>
```
Ensure `fromDetail(detail)` (the form `defaultValues`) includes `readyDateTimezone: detail?.readyDateTimezone ?? undefined` and `targetDeliveryTimezone: detail?.targetDeliveryTimezone ?? undefined`.

- [ ] **Step 4: Run to verify pass** — build shared + `pnpm --filter @svyft/web test -- Step1Client` → PASS; `pnpm --filter @svyft/web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/Step1Client.tsx apps/web/src/features/query-wizard/steps/Step1Client.test.tsx
git commit -m "feat(web): Step 1 Query Ready/Target zone pickers (explicit, exec-chosen)"
```

---

## Final gate (before finishing-a-development-branch)

- [ ] **Rebuild shared, then full local gate:**

```bash
pnpm --filter @svyft/shared build
pnpm run ci    # lint · typecheck · shared/web tests · build (api e2e runs on GitHub CI)
```
Expected green. (`QueriesToolbar` date-range test is a known flake — re-run once if it trips.)

- [ ] Then **superpowers:requesting-code-review** (opus whole-branch review) → address findings → **superpowers:finishing-a-development-branch** (PR). Push triggers CI which runs `migrate deploy` + the api e2e (the authoritative validation of the migration + Query-zone persistence + T2 removal). Update `docs/Stage 3 - Session Handoff.md` (Round-2 shipped; note not-yet-browser-verified E2E).

## Self-review notes (coverage vs. the Round-2 spec)
- (a) one zone per Query date → T1 (`readyDateTimezone`/`targetDeliveryTimezone`) + T9 (two pickers). (b) remove T2 only → T2. (c) default org zone → T9 seed. (d) ETA/ETB/ETD unchanged → `zones.ts` cases untouched. (e) full IANA searchable → T7. (f) mandatory Query dates / optional legs → unchanged schema. #5 labels → T1 (`zoneLabel` longOffset) + T6 (hint) + T7 (rows). Migration → T3. Persistence + decouple proof → T4 (CI). Data flow: schema (T1) → prisma/impact (T3) → api persist (T4) → web read (T5/T9).
