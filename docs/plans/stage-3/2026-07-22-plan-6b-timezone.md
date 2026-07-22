# Timezone Increment (Plan 6b · Round-1 #4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the floating-wall-clock date model with a location-anchored, zone-labeled one: store true UTC + a per-Point IANA zone, display operational times local-to-location and system times viewer-local (both labeled), and compare all temporal rules on real UTC instants.

**Architecture:** Pure isomorphic timezone helpers land in `@svyft/shared` (native `Intl`, no new runtime dep) with the org-timezone config schema and the new `Point.timezone` field. A Prisma migration adds `Point.timezone` (backfilled to the org default) + a key-value `AppSetting` table; the config module exposes the org default zone (GET any-role, PATCH admin). The web replaces `toIsoOffset`/`isoToLocalInput` with a single reusable `ZonedDateTimeField` that round-trips each datetime through its **anchor zone** (resolved per field), adds the Point zone picker, and labels every date display.

**Tech Stack:** pnpm monorepo · `@svyft/shared` (zod, vitest) · NestJS 10 + Prisma 5 (Postgres) · Vite/React 18 + RHF + zodResolver + shadcn + TanStack Query · native `Intl.DateTimeFormat`/`Intl.supportedValuesOf` (no date-fns-tz).

## Global Constraints

- **Design of record:** `docs/Stage 3 - Req & Issues - Round 1 - Design.md` → "Issue 3 — resolved design". Decisions: (a) query Ready/Target = org zone until points, then re-anchor to first/last point; (b) Response Deadline = org zone; (c) org default = `"Asia/Kolkata"`, seeded admin-editable `AppSetting`; (d) manual IANA zone picker per Point (default = org zone).
- **Org default zone value:** `"Asia/Kolkata"`. **Setting key:** `"orgDefaultTimezone"`. Both are shared constants (`DEFAULT_ORG_TIMEZONE`, `ORG_TIMEZONE_KEY`).
- **No new datetime library.** Use native `Intl` (Node ≥20 full-ICU + modern browsers support `timeZone`, `formatToParts`, `Intl.supportedValuesOf`). *(Deviation from the design doc's "date-fns-tz" — a cleaner, dependency-free realization of the same behavior. Fall back to `date-fns-tz@^3.2` only if a native edge case surfaces.)*
- **Operational datetime columns stay Prisma `DateTime` (UTC).** No `timestamptz` switch — explicit non-goal.
- **Enums/const-arrays:** `const X = {...} as const` + `type X = (typeof X)[keyof typeof X]` + `Object.values(X) as [X, ...X[]]`. Never a TS `enum`.
- **Zod bound at param level** via `ZodValidationPipe`. `PrismaExceptionFilter` maps P2025→404; **P2003 (FK) not mapped** — verify referenced ids in services.
- **Build gotcha:** web **vitest** resolves `@svyft/shared` from the compiled **dist** (`apps/web/vitest.config.ts` aliases only `@`). Any web test that imports NEW shared runtime code (the timezone helpers, the `timezone` field) requires **`pnpm --filter @svyft/shared build` FIRST**. The api e2e runner maps `@svyft/shared`→source (no rebuild needed). Root `pnpm run ci` runs `test` before `build`, so **run `pnpm --filter @svyft/shared build` before the local gate**; GitHub CI already builds shared first.
- **Web typecheck must run** (`pnpm --filter @svyft/web typecheck`) — `vite build`/esbuild skips type errors.
- **API CI DB is fresh-migrated + UNSEEDED** → every e2e test seeds its own reference data (call `seedReferenceData`) and is self-cleaning (own rows by a unique prefix; query delete cascades). Verify against `prisma migrate reset --force --skip-seed` + `pnpm run ci` before pushing.
- **Gate:** `pnpm run ci` green (lint · typecheck · test · build) before finishing. Commit per task (conventional commits: `feat(shared|api|web)`, `test(...)`, `chore(prisma)`).
- **Branch:** `feat/plan-6b-req-issues-round1-timezone` off `origin/main` (already cut). Ship plan doc + implementation as one PR.

## File Structure

**Create**
- `packages/shared/src/timezone.ts` — pure `Intl`-based helpers: `zonedInputToUtc`, `utcToZonedInput`, `formatInZone`, `zoneLabel`, `isValidIanaZone`, `viewerZone`.
- `packages/shared/src/timezone.test.ts` — zone conversions across representative zones + a DST boundary.
- `apps/web/src/lib/zones.ts` — pure anchor-zone resolvers: `resolveQueryFieldZone`, `resolveLegFieldZone` (+ `zones.test.ts`).
- `apps/web/src/features/config/useOrgTimezone.ts` — TanStack Query hook for the org default zone.
- `apps/web/src/components/ZonedDateTimeField.tsx` — reusable zone-aware datetime-local field (+ `ZonedDateTimeField.test.tsx`).
- `prisma/migrations/<ts>_timezone/migration.sql` — add `Point.timezone` (+ backfill), create `AppSetting`.

**Modify**
- `packages/shared/src/index.ts` — export `./timezone`.
- `packages/shared/src/config.ts` — `ORG_TIMEZONE_KEY`, `DEFAULT_ORG_TIMEZONE`, `orgTimezoneUpdateSchema`, `OrgTimezoneDto`.
- `packages/shared/src/points.ts` — add `timezone` to `pointSaveSchema` + every `POINT_REQUIRED_FIELDS` entry.
- `packages/shared/src/query.ts` — F3 (ETA/ETB/ETD) string-compare → instant-compare.
- `packages/shared/package.json` — (no dep change; native Intl).
- `prisma/schema.prisma` — `Point.timezone String?`; new `model AppSetting`.
- `apps/api/src/seed/reference-seed.ts` — upsert the `orgDefaultTimezone` `AppSetting`.
- `apps/api/src/modules/config/config-data.service.ts` + `config-data.controller.ts` — org-timezone GET + admin PATCH.
- `apps/api/src/modules/points/point.impact.ts` — classify the new `timezone` field.
- `apps/web/src/lib/dates.ts` — retire `toIsoOffset`/`isoToLocalInput`.
- `apps/web/src/features/query-wizard/steps/Step1Client.tsx` — 7 datetime fields → `ZonedDateTimeField`.
- `apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx` — 2 leg datetime fields → `ZonedDateTimeField`.
- `apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx` — required IANA `timezone` dropdown.
- `apps/web/src/features/query-list/columns.tsx` — zone-labeled date cells (columns become a factory taking `orgZone`).

---

## Task 1: Shared timezone primitives (`@svyft/shared`)

Pure, isomorphic `Intl`-based conversion + formatting. Everything else depends on this.

**Files:**
- Create: `packages/shared/src/timezone.ts`
- Create: `packages/shared/src/timezone.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces — Produces:**
- `isValidIanaZone(zone: string): boolean`
- `viewerZone(): string` — the runtime's IANA zone (`Intl…resolvedOptions().timeZone`).
- `zonedInputToUtc(wallClock: string, zone: string): string` — `"YYYY-MM-DDTHH:mm"`(or `:ss`) interpreted **in `zone`** → UTC ISO (`"…Z"`, valid for `z.string().datetime({offset:true})`).
- `utcToZonedInput(utcIso: string, zone: string): string` — UTC ISO → `"YYYY-MM-DDTHH:mm"` wall-clock in `zone` (datetime-local value).
- `zoneLabel(zone: string, atUtcIso?: string): string` — short zone name (e.g. `"GMT+5:30"`, `"EST"`).
- `formatInZone(utcIso: string, zone: string): string` — `"dd-MM-yyyy HH:mm <zoneLabel>"`.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/shared/src/timezone.test.ts
import { describe, it, expect } from "vitest";
import {
  isValidIanaZone,
  zonedInputToUtc,
  utcToZonedInput,
  zoneLabel,
  formatInZone,
} from "./timezone";

describe("isValidIanaZone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidIanaZone("Asia/Kolkata")).toBe(true);
    expect(isValidIanaZone("America/New_York")).toBe(true);
    expect(isValidIanaZone("UTC")).toBe(true);
    expect(isValidIanaZone("Not/AZone")).toBe(false);
    expect(isValidIanaZone("")).toBe(false);
  });
});

describe("zonedInputToUtc / utcToZonedInput round-trip", () => {
  it("interprets the wall-clock in the given zone (IST, +05:30, no DST)", () => {
    // 09:00 in Kolkata is 03:30 UTC.
    expect(zonedInputToUtc("2026-06-15T09:00", "Asia/Kolkata")).toBe("2026-06-15T03:30:00.000Z");
    expect(utcToZonedInput("2026-06-15T03:30:00.000Z", "Asia/Kolkata")).toBe("2026-06-15T09:00");
  });

  it("interprets the wall-clock in Singapore (+08:00)", () => {
    expect(zonedInputToUtc("2026-06-15T09:00", "Asia/Singapore")).toBe("2026-06-15T01:00:00.000Z");
    expect(utcToZonedInput("2026-06-15T01:00:00.000Z", "Asia/Singapore")).toBe("2026-06-15T09:00");
  });

  it("round-trips a value back to the same wall-clock digits", () => {
    const wall = "2026-03-10T14:45";
    for (const z of ["Asia/Kolkata", "America/New_York", "Australia/Sydney", "UTC"]) {
      expect(utcToZonedInput(zonedInputToUtc(wall, z), z)).toBe(wall);
    }
  });

  it("handles a DST boundary (America/New_York: EST −05:00 in Jan, EDT −04:00 in Jul)", () => {
    // Winter: 09:00 EST = 14:00 UTC.
    expect(zonedInputToUtc("2026-01-15T09:00", "America/New_York")).toBe("2026-01-15T14:00:00.000Z");
    // Summer: 09:00 EDT = 13:00 UTC.
    expect(zonedInputToUtc("2026-07-15T09:00", "America/New_York")).toBe("2026-07-15T13:00:00.000Z");
    // And back.
    expect(utcToZonedInput("2026-01-15T14:00:00.000Z", "America/New_York")).toBe("2026-01-15T09:00");
    expect(utcToZonedInput("2026-07-15T13:00:00.000Z", "America/New_York")).toBe("2026-07-15T09:00");
  });
});

describe("zoneLabel / formatInZone", () => {
  it("labels a zone with a non-empty short name", () => {
    expect(zoneLabel("America/New_York", "2026-01-15T14:00:00.000Z")).toMatch(/E[SD]T|GMT/);
    expect(zoneLabel("Asia/Kolkata", "2026-06-15T03:30:00.000Z").length).toBeGreaterThan(0);
  });
  it("formats an instant as dd-MM-yyyy HH:mm + a zone label", () => {
    expect(formatInZone("2026-06-15T03:30:00.000Z", "Asia/Kolkata")).toMatch(
      /^15-06-2026 09:00 .+/,
    );
  });
  it("returns empty string for a null/empty instant", () => {
    expect(formatInZone("", "Asia/Kolkata")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/shared test -- timezone`
Expected: FAIL — `Cannot find module "./timezone"`.

- [ ] **Step 3: Implement `packages/shared/src/timezone.ts`**

```typescript
// packages/shared/src/timezone.ts
// Location-anchored timezone helpers (Issue 3). Pure + isomorphic — native Intl only.
// Operational times are stored as true UTC and interpreted/displayed in an anchor zone.

const pad = (n: number) => String(n).padStart(2, "0");

/** True iff `zone` is a resolvable IANA timezone id. */
export function isValidIanaZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The runtime's IANA zone (browser/server local). */
export function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// ms that `zone` is ahead of UTC at instant `date` (DST-aware).
function zoneOffsetMs(zone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = dtf.formatToParts(date).reduce<Record<string, string>>((a, x) => {
    if (x.type !== "literal") a[x.type] = x.value;
    return a;
  }, {});
  const hour = p.hour === "24" ? 0 : Number(p.hour); // some engines emit "24" for midnight
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second),
  );
  return asIfUtc - date.getTime();
}

/**
 * Interpret a wall-clock ("YYYY-MM-DDTHH:mm" or ":ss") AS IF in `zone`; return the UTC ISO instant.
 * Two-pass offset resolution handles DST transitions.
 */
export function zonedInputToUtc(wallClock: string, zone: string): string {
  if (!wallClock) return "";
  const provisional = new Date(`${wallClock.length === 16 ? `${wallClock}:00` : wallClock}Z`);
  let utcMs = provisional.getTime() - zoneOffsetMs(zone, provisional);
  const off2 = zoneOffsetMs(zone, new Date(utcMs));
  utcMs = provisional.getTime() - off2; // re-resolve at the candidate instant (DST edges)
  return new Date(utcMs).toISOString();
}

/** UTC ISO → the "YYYY-MM-DDTHH:mm" wall-clock in `zone` (for a datetime-local input). */
export function utcToZonedInput(utcIso: string, zone: string): string {
  if (!utcIso) return "";
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return "";
  const off = zoneOffsetMs(zone, d);
  const local = new Date(d.getTime() + off);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/** Short zone name at an optional instant (e.g. "GMT+5:30", "EST"). */
export function zoneLabel(zone: string, atUtcIso?: string): string {
  const d = atUtcIso ? new Date(atUtcIso) : new Date(0);
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
    .formatToParts(Number.isNaN(d.getTime()) ? new Date(0) : d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

/** UTC ISO → "dd-MM-yyyy HH:mm <zoneLabel>" in `zone`. Empty for empty input. */
export function formatInZone(utcIso: string, zone: string): string {
  if (!utcIso) return "";
  const input = utcToZonedInput(utcIso, zone); // "YYYY-MM-DDTHH:mm"
  if (!input) return "";
  const [date, time] = input.split("T");
  const [y, m, day] = date.split("-");
  return `${day}-${m}-${y} ${time} ${zoneLabel(zone, utcIso)}`;
}
```

- [ ] **Step 4: Export from the barrel** — add to `packages/shared/src/index.ts` (after `export * from "./route";`):

```typescript
export * from "./timezone";
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @svyft/shared test -- timezone`
Expected: PASS (all timezone tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/timezone.ts packages/shared/src/timezone.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): Intl-based location-anchored timezone helpers (Issue 3)"
```

---

## Task 2: Shared schema wiring — org-timezone config, `Point.timezone`, F3 instant-compare

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/points.ts`
- Modify: `packages/shared/src/query.ts`
- Modify/Create tests: `packages/shared/src/config.test.ts`, `packages/shared/src/points.test.ts`, `packages/shared/src/query.test.ts`

**Interfaces — Consumes:** `isValidIanaZone` (Task 1).
**Interfaces — Produces:**
- `ORG_TIMEZONE_KEY = "orgDefaultTimezone"`, `DEFAULT_ORG_TIMEZONE = "Asia/Kolkata"`
- `orgTimezoneUpdateSchema = z.object({ timezone: <valid IANA> })`, `type OrgTimezoneUpdateInput`, `interface OrgTimezoneDto { timezone: string }`
- `pointSaveSchema` gains `timezone?: string` (valid IANA when present); `POINT_REQUIRED_FIELDS[*]` each include `"timezone"`.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/shared/src/config.test.ts  (add)
import { describe, it, expect } from "vitest";
import { ORG_TIMEZONE_KEY, DEFAULT_ORG_TIMEZONE, orgTimezoneUpdateSchema } from "./config";

describe("org timezone config", () => {
  it("pins the setting key + default", () => {
    expect(ORG_TIMEZONE_KEY).toBe("orgDefaultTimezone");
    expect(DEFAULT_ORG_TIMEZONE).toBe("Asia/Kolkata");
  });
  it("accepts a valid IANA zone and rejects junk", () => {
    expect(orgTimezoneUpdateSchema.safeParse({ timezone: "Asia/Singapore" }).success).toBe(true);
    expect(orgTimezoneUpdateSchema.safeParse({ timezone: "Nope/Zone" }).success).toBe(false);
    expect(orgTimezoneUpdateSchema.safeParse({}).success).toBe(false);
  });
});
```

```typescript
// packages/shared/src/points.test.ts  (add)
import { pointSaveSchema, POINT_REQUIRED_FIELDS, POINT_TYPES } from "./points";
// ...
describe("Point.timezone", () => {
  it("accepts a valid IANA timezone and rejects junk when present", () => {
    expect(pointSaveSchema.safeParse({ type: "PICKUP", timezone: "Asia/Kolkata" }).success).toBe(true);
    expect(pointSaveSchema.safeParse({ type: "PICKUP", timezone: "Bad/Zone" }).success).toBe(false);
  });
  it("marks timezone required for every point type", () => {
    for (const t of POINT_TYPES) expect(POINT_REQUIRED_FIELDS[t]).toContain("timezone");
  });
});
```

```typescript
// packages/shared/src/query.test.ts  (add)
import { querySaveSchema } from "./query";
describe("F3 compares real instants across zones", () => {
  it("accepts ETA<ETB<ETD even when the offset strings sort differently than the instants", () => {
    // ETA 10:00+05:30 = 04:30Z ; ETB 06:00Z ; ETD 07:00Z — instants ordered, strings are not.
    const ok = querySaveSchema.safeParse({
      eta: "2026-06-15T10:00:00+05:30",
      etb: "2026-06-15T06:00:00+00:00",
      etd: "2026-06-15T07:00:00+00:00",
    });
    expect(ok.success).toBe(true);
  });
  it("rejects when the real instants are out of order", () => {
    const bad = querySaveSchema.safeParse({
      eta: "2026-06-15T06:00:00+00:00",
      etb: "2026-06-15T10:00:00+05:30", // = 04:30Z, before ETA
    });
    expect(bad.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared test` → FAIL (missing exports / `timezone` not required / F3 string-compare passes the wrong case).

- [ ] **Step 3: Implement `config.ts`** — append:

```typescript
import { isValidIanaZone } from "./timezone";

export const ORG_TIMEZONE_KEY = "orgDefaultTimezone" as const;
export const DEFAULT_ORG_TIMEZONE = "Asia/Kolkata" as const;

export const orgTimezoneUpdateSchema = z.object({
  timezone: z.string().refine(isValidIanaZone, { message: "Must be a valid IANA timezone" }),
});
export type OrgTimezoneUpdateInput = z.infer<typeof orgTimezoneUpdateSchema>;

export interface OrgTimezoneDto {
  timezone: string;
}
```

- [ ] **Step 4: Implement `points.ts`** — add to `pointSaveSchema` (after `terminal`):

```typescript
  timezone: z
    .string()
    .refine(isValidIanaZone, { message: "Must be a valid IANA timezone" })
    .optional(),
```
Add the import at the top: `import { isValidIanaZone } from "./timezone";`
Then add `"timezone"` to **every** array in `POINT_REQUIRED_FIELDS` (PICKUP, DELIVERY, WAREHOUSE, AIRPORT, SEAPORT).

- [ ] **Step 5: Implement `query.ts` F3** — replace the three F3 refines' comparators (string `<`) with instant compares:

```typescript
  .refine((q) => !(q.eta && q.etb) || new Date(q.eta).getTime() < new Date(q.etb).getTime(), {
    message: "ETA must be before ETB",
    path: ["eta"],
  })
  .refine((q) => !(q.etb && q.etd) || new Date(q.etb).getTime() < new Date(q.etd).getTime(), {
    message: "ETB must be before ETD",
    path: ["etb"],
  })
  .refine((q) => !(q.eta && q.etd) || new Date(q.eta).getTime() < new Date(q.etd).getTime(), {
    message: "ETA must be before ETD",
    path: ["eta"],
  })
```

- [ ] **Step 6: Verify route-engine R8 picks up `timezone`.** Open `packages/shared/src/route.ts` and find the per-type point required-field check (R8). If it iterates `POINT_REQUIRED_FIELDS`, no change is needed (a point missing `timezone` now yields a create-phase finding automatically). If it hardcodes a field list, add `timezone`. Add/extend a `route.test.ts` case asserting a `create`-phase point missing `timezone` produces an R8 finding.

- [ ] **Step 7: Run to verify pass** — `pnpm --filter @svyft/shared test` → PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): org-timezone config + required Point.timezone + F3 instant-compare"
```

---

## Task 3: Prisma migration — `Point.timezone` + `AppSetting` + seed

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_timezone/migration.sql`
- Modify: `apps/api/src/seed/reference-seed.ts`

**Interfaces — Produces:** `Point.timezone` column (backfilled `"Asia/Kolkata"`); `AppSetting { key, value, updatedAt }`; seeded `orgDefaultTimezone` row.

- [ ] **Step 1: Edit `prisma/schema.prisma`** — add to `model Point` (after `terminal String?`):

```prisma
  timezone      String?
```
Add a new model (near `CodeSequence`):

```prisma
model AppSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 2: Generate the migration** (needs the local Postgres up — see `README.md`, Docker Postgres on `:5433`):

Run: `pnpm prisma migrate dev --name timezone --create-only`
Then open the generated `prisma/migrations/<ts>_timezone/migration.sql` and ensure it matches (append the backfill `UPDATE` if Prisma didn't include it):

```sql
-- AlterTable: per-Point IANA timezone (Issue 3(d))
ALTER TABLE "Point" ADD COLUMN "timezone" TEXT;

-- Stamp existing rows with the org default zone (Issue 3 migration)
UPDATE "Point" SET "timezone" = 'Asia/Kolkata' WHERE "timezone" IS NULL;

-- CreateTable: key-value app settings (org default timezone, Issue 3(c))
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
```
*(If no local DB is available, hand-author the folder + `migration.sql` above verbatim; CI's `migrate deploy` applies it and `prisma validate` checks the schema.)*

- [ ] **Step 3: Apply + regenerate client** — `pnpm prisma migrate dev --name timezone` (applies) then `pnpm prisma generate`. Expected: `Point.timezone` + `AppSetting` in the generated client.

- [ ] **Step 4: Seed the org default in `reference-seed.ts`** — import the constants and upsert (create-only, never overwrite an admin edit):

```typescript
import { ORG_TIMEZONE_KEY, DEFAULT_ORG_TIMEZONE } from "@svyft/shared";
// ...inside seedReferenceData, after the checklist loop:
await prisma.appSetting.upsert({
  where: { key: ORG_TIMEZONE_KEY },
  create: { key: ORG_TIMEZONE_KEY, value: DEFAULT_ORG_TIMEZONE },
  update: {},
});
```

- [ ] **Step 5: Verify** — `pnpm prisma validate` → OK. `pnpm --filter @svyft/shared build` (so the api picks up the new shared exports).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/src/seed/reference-seed.ts
git commit -m "chore(prisma): add Point.timezone + AppSetting; seed org default zone"
```

---

## Task 4: API — org-timezone config endpoint (GET any-role, PATCH admin)

**Files:**
- Modify: `apps/api/src/modules/config/config-data.service.ts`
- Modify: `apps/api/src/modules/config/config-data.controller.ts`
- Create: `apps/api/test/org-timezone.e2e-spec.ts`

**Interfaces — Consumes:** `ORG_TIMEZONE_KEY`, `DEFAULT_ORG_TIMEZONE`, `orgTimezoneUpdateSchema`, `OrgTimezoneDto` (Task 2); `AppSetting` (Task 3).
**Interfaces — Produces:** `GET /api/config/org-timezone → { timezone }`; `PATCH /api/config/org-timezone` (admin) `{ timezone }`.

- [ ] **Step 1: Write the failing e2e** (mirrors `config-data.e2e-spec.ts` — supertest + jwt cookie; seeds reference data):

```typescript
// apps/api/test/org-timezone.e2e-spec.ts
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-access-secret";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import cookieParser from "cookie-parser";
import { JwtService } from "@nestjs/jwt";
import { Role, ACCESS_TOKEN_COOKIE } from "@svyft/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { seedReferenceData } from "../src/seed/reference-seed";
import { PrismaExceptionFilter } from "../src/common/prisma-exception.filter";

describe("Org timezone (e2e)", () => {
  let app: INestApplication;
  let jwt: JwtService;
  const cookie = (role: Role) =>
    `${ACCESS_TOKEN_COOKIE}=${jwt.sign({ sub: `u-${role}`, role, tenantId: null })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new PrismaExceptionFilter());
    app.setGlobalPrefix("api");
    await app.init();
    jwt = moduleRef.get(JwtService);
    await seedReferenceData(moduleRef.get(PrismaService));
  });
  afterAll(async () => {
    // restore the default so the suite is idempotent
    await request(app.getHttpServer())
      .patch("/api/config/org-timezone")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ timezone: "Asia/Kolkata" });
    await app.close();
  });

  it("any role reads the seeded org default zone", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/config/org-timezone")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.timezone).toBe("Asia/Kolkata");
  });

  it("only Admin may change it (Manager → 403; Admin → 200 + persisted)", async () => {
    await request(app.getHttpServer())
      .patch("/api/config/org-timezone")
      .set("Cookie", cookie(Role.MANAGER))
      .send({ timezone: "Asia/Singapore" })
      .expect(403);
    await request(app.getHttpServer())
      .patch("/api/config/org-timezone")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ timezone: "Asia/Singapore" })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get("/api/config/org-timezone")
      .set("Cookie", cookie(Role.EXECUTIVE))
      .expect(200);
    expect(res.body.timezone).toBe("Asia/Singapore");
  });

  it("rejects an invalid IANA zone (Zod 400)", async () => {
    await request(app.getHttpServer())
      .patch("/api/config/org-timezone")
      .set("Cookie", cookie(Role.ADMINISTRATOR))
      .send({ timezone: "Nope/Zone" })
      .expect(400);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/api test -- org-timezone` → FAIL (404 route).

- [ ] **Step 3: Implement the service** — add to `ConfigDataService`:

```typescript
import { ORG_TIMEZONE_KEY, DEFAULT_ORG_TIMEZONE } from "@svyft/shared";
import type { OrgTimezoneDto, OrgTimezoneUpdateInput } from "@svyft/shared";
// ...
async orgTimezone(): Promise<OrgTimezoneDto> {
  const row = await this.prisma.appSetting.findUnique({ where: { key: ORG_TIMEZONE_KEY } });
  return { timezone: row?.value ?? DEFAULT_ORG_TIMEZONE };
}

async updateOrgTimezone(input: OrgTimezoneUpdateInput): Promise<OrgTimezoneDto> {
  const row = await this.prisma.appSetting.upsert({
    where: { key: ORG_TIMEZONE_KEY },
    create: { key: ORG_TIMEZONE_KEY, value: input.timezone },
    update: { value: input.timezone },
  });
  return { timezone: row.value };
}
```

- [ ] **Step 4: Implement the controller** — add to `ConfigDataController`:

```typescript
import { orgTimezoneUpdateSchema } from "@svyft/shared";
import type { OrgTimezoneUpdateInput } from "@svyft/shared";
// ...
@Get("org-timezone")
orgTimezone() {
  return this.config.orgTimezone();
}

@Roles(Role.ADMINISTRATOR)
@Patch("org-timezone")
updateOrgTimezone(
  @Body(new ZodValidationPipe(orgTimezoneUpdateSchema)) body: OrgTimezoneUpdateInput,
) {
  return this.config.updateOrgTimezone(body);
}
```

- [ ] **Step 5: Run to verify pass** — `pnpm --filter @svyft/api test -- org-timezone` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/config apps/api/test/org-timezone.e2e-spec.ts
git commit -m "feat(api): org-timezone config endpoint (GET any-role, PATCH admin)"
```

---

## Task 5: API — persist & require `Point.timezone`

The service already spreads `...input` into the Prisma create/update, so `timezone` flows through once the impact map accepts it.

**Files:**
- Modify: `apps/api/src/modules/points/point.impact.ts`
- Modify: `apps/api/test/points.e2e-spec.ts`

**Interfaces — Consumes:** `pointSaveSchema.timezone`, `Point.timezone`.

- [ ] **Step 1: Write the failing e2e** (add to `points.e2e-spec.ts`):

```typescript
it("persists and returns a point timezone", async () => {
  const res = await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/points`)
    .set("Cookie", cookie())
    .send({ type: "PICKUP", name: "Shipper", timezone: "Asia/Singapore" })
    .expect(201);
  expect(res.body.timezone).toBe("Asia/Singapore");
});

it("rejects an invalid point timezone (Zod 400)", async () => {
  await request(app.getHttpServer())
    .post(`/api/queries/${queryId}/points`)
    .set("Cookie", cookie())
    .send({ type: "PICKUP", timezone: "Bad/Zone" })
    .expect(400);
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/api test -- points` → FAIL: the `ChangeMediator`/`ImpactRegistry` typing or runtime rejects the unclassified `timezone` field (impact map is `Record<keyof PointSaveInput | "@create" | "@delete", ImpactClass>` — now missing `timezone`), or a typecheck error.

- [ ] **Step 3: Classify `timezone` in `point.impact.ts`** — open the file, find `pointImpactMap`, and add a `timezone` entry mirroring the location fields (`city`/`country`) — the same `ImpactClass` those use (the map is typed for compile-time completeness, so the build fails until it's present). Example (match the file's existing class import + values):

```typescript
  timezone: /* same ImpactClass as country/city, e.g. */ ImpactClass.RfqDefining,
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @svyft/api test -- points` → PASS. Also `pnpm --filter @svyft/api typecheck` → clean (proves the impact map is complete).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/points/point.impact.ts apps/api/test/points.e2e-spec.ts
git commit -m "feat(api): classify + persist Point.timezone through the change mediator"
```

---

## Task 6: Web — org-timezone hook + anchor-zone resolvers

**Files:**
- Create: `apps/web/src/features/config/useOrgTimezone.ts`
- Create: `apps/web/src/lib/zones.ts`
- Create: `apps/web/src/lib/zones.test.ts`

**Interfaces — Consumes:** `OrgTimezoneDto`, `DEFAULT_ORG_TIMEZONE`; `fetchJson` (`@/lib/api`); `QueryDetail` graph shape (`detail.points`, `detail.legs`).
**Interfaces — Produces:**
- `useOrgTimezone(): { orgZone: string; isLoading: boolean }`
- `resolveQueryFieldZone(field, detail, orgZone): string` — for `queryDate` (viewer), `responseDeadline` (org), `readyDate`/`targetDelivery` (first/last point else org), `eta`/`etb`/`etd` (first SEAPORT point else org).
- `resolveLegFieldZone(field: "readyDate" | "targetDelivery", leg, points, orgZone): string`

- [ ] **Step 1: Write failing tests for `zones.ts`** (pure — no shared rebuild needed since these don't import new shared runtime code; they take `orgZone` as a param):

```typescript
// apps/web/src/lib/zones.test.ts
import { describe, it, expect } from "vitest";
import { resolveQueryFieldZone, resolveLegFieldZone } from "./zones";

const ORG = "Asia/Kolkata";
const sea = { id: "s1", type: "SEAPORT", timezone: "Asia/Singapore" };
const air = { id: "a1", type: "AIRPORT", timezone: "Europe/London" };

describe("resolveQueryFieldZone", () => {
  it("responseDeadline → org zone", () => {
    expect(resolveQueryFieldZone("responseDeadline", { points: [], legs: [] }, ORG)).toBe(ORG);
  });
  it("queryDate → viewer zone (Intl local)", () => {
    const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveQueryFieldZone("queryDate", { points: [], legs: [] }, ORG)).toBe(viewer);
  });
  it("readyDate → first point zone once points exist, else org", () => {
    expect(resolveQueryFieldZone("readyDate", { points: [], legs: [] }, ORG)).toBe(ORG);
    expect(resolveQueryFieldZone("readyDate", { points: [air, sea], legs: [] }, ORG)).toBe(
      "Europe/London",
    );
  });
  it("targetDelivery → last point zone", () => {
    expect(resolveQueryFieldZone("targetDelivery", { points: [air, sea], legs: [] }, ORG)).toBe(
      "Asia/Singapore",
    );
  });
  it("eta/etb/etd → first SEAPORT zone, else org", () => {
    expect(resolveQueryFieldZone("eta", { points: [air], legs: [] }, ORG)).toBe(ORG);
    expect(resolveQueryFieldZone("etb", { points: [air, sea], legs: [] }, ORG)).toBe(
      "Asia/Singapore",
    );
  });
});

describe("resolveLegFieldZone", () => {
  const points = [
    { id: "p1", timezone: "Asia/Kolkata" },
    { id: "p2", timezone: "Asia/Singapore" },
  ];
  const leg = { originPointId: "p1", destinationPointId: "p2" };
  it("readyDate → origin point zone; targetDelivery → destination point zone", () => {
    expect(resolveLegFieldZone("readyDate", leg, points, ORG)).toBe("Asia/Kolkata");
    expect(resolveLegFieldZone("targetDelivery", leg, points, ORG)).toBe("Asia/Singapore");
  });
  it("falls back to org zone when the endpoint (or its zone) is missing", () => {
    expect(resolveLegFieldZone("readyDate", {}, points, ORG)).toBe(ORG);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/web test -- zones` → FAIL (module missing).

- [ ] **Step 3: Implement `apps/web/src/lib/zones.ts`**

```typescript
// apps/web/src/lib/zones.ts
// Which IANA zone anchors each datetime field (Issue 3 anchor rules). Pure.
type PointLike = { id: string; type?: string | null; timezone?: string | null };
type LegLike = { originPointId?: string | null; destinationPointId?: string | null };
type GraphLike = { points: PointLike[]; legs: LegLike[] };

export type QueryZonedField =
  | "queryDate"
  | "responseDeadline"
  | "readyDate"
  | "targetDelivery"
  | "eta"
  | "etb"
  | "etd";

const viewer = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const zoneOf = (p?: PointLike, org?: string) => p?.timezone || org || "UTC";

export function resolveQueryFieldZone(
  field: QueryZonedField,
  graph: GraphLike,
  orgZone: string,
): string {
  const pts = graph.points ?? [];
  switch (field) {
    case "queryDate":
      return viewer(); // system/audit time
    case "responseDeadline":
      return orgZone; // internal SLA
    case "readyDate":
      return pts.length ? zoneOf(pts[0], orgZone) : orgZone;
    case "targetDelivery":
      return pts.length ? zoneOf(pts[pts.length - 1], orgZone) : orgZone;
    case "eta":
    case "etb":
    case "etd": {
      const seaport = pts.find((p) => p.type === "SEAPORT");
      return seaport ? zoneOf(seaport, orgZone) : orgZone;
    }
  }
}

export function resolveLegFieldZone(
  field: "readyDate" | "targetDelivery",
  leg: LegLike,
  points: PointLike[],
  orgZone: string,
): string {
  const id = field === "readyDate" ? leg.originPointId : leg.destinationPointId;
  const pt = points.find((p) => p.id === id);
  return zoneOf(pt, orgZone);
}
```

- [ ] **Step 4: Implement `apps/web/src/features/config/useOrgTimezone.ts`** (mirrors the `ConfigPage` `useQuery` pattern):

```typescript
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { DEFAULT_ORG_TIMEZONE, type OrgTimezoneDto } from "@svyft/shared";

export function useOrgTimezone(): { orgZone: string; isLoading: boolean } {
  const q = useQuery({
    queryKey: ["org-timezone"],
    queryFn: () => fetchJson<OrgTimezoneDto>("/api/config/org-timezone"),
    staleTime: 5 * 60_000,
  });
  return { orgZone: q.data?.timezone ?? DEFAULT_ORG_TIMEZONE, isLoading: q.isLoading };
}
```

- [ ] **Step 5: Rebuild shared, then run** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- zones` → PASS. `pnpm --filter @svyft/web typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/zones.ts apps/web/src/lib/zones.test.ts apps/web/src/features/config/useOrgTimezone.ts
git commit -m "feat(web): org-timezone hook + anchor-zone resolvers"
```

---

## Task 7: Web — reusable `ZonedDateTimeField`; retire the floating-wall-clock helpers

**Files:**
- Create: `apps/web/src/components/ZonedDateTimeField.tsx`
- Create: `apps/web/src/components/ZonedDateTimeField.test.tsx`
- Modify: `apps/web/src/lib/dates.ts` (remove `toIsoOffset` / `isoToLocalInput`)

**Interfaces — Consumes:** `zonedInputToUtc`, `utcToZonedInput`, `zoneLabel` (`@svyft/shared`).
**Interfaces — Produces:** `<ZonedDateTimeField control name label zone required? readOnly? onChanged? />` — a shadcn `FormField` whose datetime-local value round-trips through `zone`, with a muted `"Times in <zoneLabel>"` hint.

- [ ] **Step 1: Write the failing component test** (rebuild shared first — imports new shared code):

```tsx
// apps/web/src/components/ZonedDateTimeField.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { ZonedDateTimeField } from "./ZonedDateTimeField";

function Harness({ zone, initial }: { zone: string; initial?: string }) {
  const form = useForm({ defaultValues: { at: initial } });
  return (
    <Form {...form}>
      <ZonedDateTimeField control={form.control} name="at" label="Ready" zone={zone} />
      <output data-testid="val">{String(form.watch("at") ?? "")}</output>
    </Form>
  );
}

describe("ZonedDateTimeField", () => {
  it("shows the stored UTC instant as the zone's wall-clock", () => {
    render(<Harness zone="Asia/Kolkata" initial="2026-06-15T03:30:00.000Z" />);
    expect((screen.getByLabelText(/Ready/i) as HTMLInputElement).value).toBe("2026-06-15T09:00");
    expect(screen.getByText(/Times in/i)).toBeInTheDocument();
  });
  it("writes back a UTC instant interpreted in the zone", () => {
    render(<Harness zone="Asia/Kolkata" />);
    fireEvent.change(screen.getByLabelText(/Ready/i), { target: { value: "2026-06-15T09:00" } });
    expect(screen.getByTestId("val").textContent).toBe("2026-06-15T03:30:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- ZonedDateTimeField` → FAIL (module missing).

- [ ] **Step 3: Implement the component**

```tsx
// apps/web/src/components/ZonedDateTimeField.tsx
import type { Control } from "react-hook-form";
import { zonedInputToUtc, utcToZonedInput, zoneLabel } from "@svyft/shared";
import { Input } from "@/components/ui/input";
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";

interface Props {
  control: Control<any>;
  name: string;
  label: string;
  zone: string;
  required?: boolean;
  readOnly?: boolean;
  onChanged?: () => void;
}

export function ZonedDateTimeField({
  control,
  name,
  label,
  zone,
  required,
  readOnly,
  onChanged,
}: Props) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            {label}
            {required ? <span className="text-destructive"> *</span> : null}
          </FormLabel>
          <FormControl>
            <Input
              type="datetime-local"
              readOnly={readOnly}
              className={readOnly ? "bg-muted" : undefined}
              value={utcToZonedInput(field.value ?? "", zone)}
              onChange={(e) => {
                const v = e.target.value;
                field.onChange(v ? zonedInputToUtc(v, zone) : undefined);
                onChanged?.();
              }}
            />
          </FormControl>
          <p className="text-xs text-muted-foreground">Times in {zoneLabel(zone)}</p>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
```

- [ ] **Step 4: Retire the floating-wall-clock helpers** — remove `toIsoOffset` and `isoToLocalInput` from `apps/web/src/lib/dates.ts` and their tests from `dates.test.ts` (keep `formatDate`/`formatDateTime` if still referenced elsewhere). This will surface unused-import/compile errors at their old call sites (Step1Client, LegEditor, QueriesToolbar) — those are migrated in Tasks 8–9; for QueriesToolbar's date-range filter, replace `toIsoOffset(x)` with `new Date(x).toISOString()` (the list filter is a real instant, not a wall-clock).

- [ ] **Step 5: Rebuild shared + run** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- ZonedDateTimeField` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ZonedDateTimeField.tsx apps/web/src/components/ZonedDateTimeField.test.tsx apps/web/src/lib/dates.ts apps/web/src/lib/dates.test.ts
git commit -m "feat(web): ZonedDateTimeField; retire floating-wall-clock helpers"
```

---

## Task 8: Web — Step 1 datetime fields → anchor zones

Replace all 7 `Step1Client.tsx` datetime `FormField`s with `ZonedDateTimeField`, each wired to its anchor zone.

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/Step1Client.test.tsx` (or add if absent)

**Interfaces — Consumes:** `ZonedDateTimeField` (Task 7); `useOrgTimezone`, `resolveQueryFieldZone` (Task 6); `useWizard().detail` for the point graph.

Zone map (per `resolveQueryFieldZone`):

| Field | Anchor zone | Notes |
|---|---|---|
| `queryDate` | viewer | `readOnly` unless Administrator (unchanged behavior) |
| `responseDeadline` | org | `onChanged` sets `deadlineTouchedRef.current = true` |
| `eta` / `etb` / `etd` | first SEAPORT point, else org | |
| `readyDate` | first point, else org | `required` |
| `targetDelivery` | last point, else org | `required` |

- [ ] **Step 1: Write/extend the failing test** — render `Step1Client` (with `renderWithProviders`, stub `/api/config/org-timezone` → `{ timezone: "Asia/Kolkata" }` and `/api/auth/me`), assert: the Response Deadline field shows a "Times in …" hint; a `readyDate` field with a stored `…Z` instant renders the org-zone wall-clock (no points yet). Rebuild shared first.

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- Step1Client` → FAIL.

- [ ] **Step 3: Implement** — add near the top of the component:

```typescript
import { useOrgTimezone } from "@/features/config/useOrgTimezone";
import { resolveQueryFieldZone } from "@/lib/zones";
import { ZonedDateTimeField } from "@/components/ZonedDateTimeField";
// ...inside the component:
const { orgZone } = useOrgTimezone();
const graph = { points: detail?.points ?? [], legs: detail?.legs ?? [] };
const zoneFor = (f: Parameters<typeof resolveQueryFieldZone>[0]) =>
  resolveQueryFieldZone(f, graph, orgZone);
```
Replace each datetime `FormField` (Query Date, Response Deadline, ETA, ETB, ETD, Ready Date, Target Delivery) with, e.g.:

```tsx
<ZonedDateTimeField
  control={form.control}
  name="queryDate"
  label="Query Date"
  zone={zoneFor("queryDate")}
  readOnly={!isAdmin}
/>
{/* Response Deadline */}
<ZonedDateTimeField
  control={form.control}
  name="responseDeadline"
  label="Response Deadline"
  zone={zoneFor("responseDeadline")}
  onChanged={() => { deadlineTouchedRef.current = true; }}
/>
{/* eta / etb / etd — zone={zoneFor("eta"|"etb"|"etd")} */}
{/* Ready Date — required, zone={zoneFor("readyDate")} */}
{/* Target Delivery — required, zone={zoneFor("targetDelivery")} */}
```
Remove the now-unused `toIsoOffset`/`isoToLocalInput` import.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- Step1Client` → PASS; `pnpm --filter @svyft/web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/Step1Client.tsx apps/web/src/features/query-wizard/steps/Step1Client.test.tsx
git commit -m "feat(web): Step 1 datetimes anchor to their zones (viewer/org/point)"
```

---

## Task 9: Web — Leg editor datetimes → point zones

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegEditor.test.tsx` (or add)

**Interfaces — Consumes:** `ZonedDateTimeField`; `resolveLegFieldZone`, `useOrgTimezone`; `detail.points` + the watched `originPointId`/`destinationPointId`.

- [ ] **Step 1: Write the failing test** — render `LegEditor` with an origin point in `Asia/Kolkata` and a destination in `Asia/Singapore`; assert the Ready field reflects the origin zone and Target the destination zone (a stored `…Z` value renders as each zone's wall-clock, and the "Times in …" hints differ). Rebuild shared first.

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- LegEditor` → FAIL.

- [ ] **Step 3: Implement** — the editor already computes `originPoint`/`destPoint` via `detail.points.find(...)`. Add:

```typescript
import { useOrgTimezone } from "@/features/config/useOrgTimezone";
import { resolveLegFieldZone } from "@/lib/zones";
import { ZonedDateTimeField } from "@/components/ZonedDateTimeField";
// ...
const { orgZone } = useOrgTimezone();
const legLike = { originPointId: watchedOriginId, destinationPointId: watchedDestId };
```
Replace the Ready Date + Target Delivery `FormField`s:

```tsx
<ZonedDateTimeField
  control={form.control}
  name="readyDate"
  label="Ready Date"
  zone={resolveLegFieldZone("readyDate", legLike, detail.points, orgZone)}
/>
<ZonedDateTimeField
  control={form.control}
  name="targetDelivery"
  label="Target Delivery"
  zone={resolveLegFieldZone("targetDelivery", legLike, detail.points, orgZone)}
/>
```
Remove the unused `toIsoOffset`/`isoToLocalInput` import.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- LegEditor` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx apps/web/src/features/query-wizard/steps/legs/LegEditor.test.tsx
git commit -m "feat(web): leg Ready/Target datetimes anchor to origin/destination point zones"
```

---

## Task 10: Web — Point editor IANA timezone picker (required, default = org zone)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx` (or add)

**Interfaces — Consumes:** `useOrgTimezone` (default value for new points); `Intl.supportedValuesOf('timeZone')` (options); the existing `RequiredMark` (already used for country).

- [ ] **Step 1: Write the failing test** — render `PointEditor` (add mode, `useOrgTimezone` stubbed → `Asia/Kolkata`): assert a "Timezone" field renders with a required mark and defaults to `Asia/Kolkata`; in edit mode with `point.timezone = "Asia/Singapore"` it shows that value. Rebuild shared first (imports the new `timezone` in `POINT_REQUIRED_FIELDS`/schema). Drive the hidden native `<select>` (Radix Select is jsdom-flaky).

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- PointEditor` → FAIL.

- [ ] **Step 3: Implement** — compute the zone option list once (module scope) and default new points to the org zone:

```typescript
import { useOrgTimezone } from "@/features/config/useOrgTimezone";
// module scope:
const IANA_ZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
```
In the component, seed the default for **new** points (extend the non-edit `defaultValues`): `timezone: typeProp ? undefined : orgZone` — actually set it after `useOrgTimezone()`:

```typescript
const { orgZone } = useOrgTimezone();
// in the create-branch defaultValues, add: timezone: orgZone
```
Add the field immediately after the Country `FormField` (before the "Contact Details" divider), as a searchable Select over `IANA_ZONES`:

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
        <Select value={field.value ?? ""} onValueChange={field.onChange}>
          <SelectTrigger><SelectValue placeholder="Select timezone" /></SelectTrigger>
          <SelectContent className="max-h-72">
            {IANA_ZONES.map((z) => (
              <SelectItem key={z} value={z}>{z}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormControl>
      <FormMessage />
    </FormItem>
  )}
/>
```
*(If the editors use a searchable `cmdk` combobox elsewhere, prefer that for the long zone list; a plain Select with a scroll cap is acceptable.)* `RequiredMark` already reads `POINT_REQUIRED_FIELDS`, so `timezone` shows its marker for every type automatically.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- PointEditor` → PASS; `pnpm --filter @svyft/web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx
git commit -m "feat(web): required IANA timezone picker on the Point editor (default = org zone)"
```

---

## Task 11: Web — Query List date columns carry zone labels

**Files:**
- Modify: `apps/web/src/features/query-list/columns.tsx`
- Modify: the Query List page that builds the columns (wherever `columns` is imported — pass `orgZone`)
- Modify: `apps/web/src/features/query-list/columns.test.tsx` (or the list page test)

**Interfaces — Consumes:** `formatInZone` (`@svyft/shared`), `viewerZone` (or `Intl` local), `useOrgTimezone`.
**Interfaces — Produces:** `makeColumns(orgZone: string)` — `queryDate`/`updatedAt` render viewer-local + label; `responseDeadline` renders org-zone + label.

- [ ] **Step 1: Write the failing test** — assert the Query Date cell renders `formatInZone(value, viewerZone)` (contains a zone label) and Response By renders in the org zone. Rebuild shared first.

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- columns` (or the list test) → FAIL.

- [ ] **Step 3: Implement** — convert the exported `columns` array to a factory:

```typescript
import { formatInZone, viewerZone } from "@svyft/shared";
export function makeColumns(orgZone: string): ColumnDef<QueryListRow>[] {
  const local = viewerZone();
  return [
    // ...
    {
      accessorKey: "queryDate",
      header: "Query Date",
      cell: ({ getValue }) => (
        <span className="font-mono tabular-nums text-muted-foreground">
          {formatInZone(getValue<string>(), local)}
        </span>
      ),
    },
    // responseDeadline → formatInZone(value, orgZone) || "—"
    // updatedAt → formatInZone(value, local)
  ];
}
```
Update the list page: `const { orgZone } = useOrgTimezone(); const columns = useMemo(() => makeColumns(orgZone), [orgZone]);` (keep a `columns` default export only if other imports rely on it; otherwise migrate them).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @svyft/shared build && pnpm --filter @svyft/web test -- columns` → PASS; `pnpm --filter @svyft/web typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-list
git commit -m "feat(web): Query List dates show zone labels (viewer-local; Response By org-zone)"
```

---

## Final gate (before finishing-a-development-branch)

- [ ] **Rebuild shared, then full local gate:**

```bash
pnpm --filter @svyft/shared build
pnpm run ci        # lint · typecheck · test · build (web + shared locally; api e2e runs in GitHub CI)
```
Expected: green. (If a local Postgres is available, also run the api e2e: `pnpm --filter @svyft/api test`. Otherwise GitHub CI runs it against a fresh migrated-unseeded DB — confirm the migration + seed changes there.)

- [ ] **Sanity vs. a fresh DB (if DB available):** `pnpm prisma migrate reset --force --skip-seed` then `pnpm run ci` — proves the migration applies clean and tests are seed-independent.

- [ ] Then invoke **superpowers:requesting-code-review** (opus whole-branch review) → address findings → **superpowers:finishing-a-development-branch** (PR). Update `docs/Stage 3 - Session Handoff.md`: mark increment 4 (timezone) shipped; note the native-`Intl` deviation; flag it as **not yet browser-verified E2E** (prod smoke-test of the zone display + Point picker is the closing step).

## Self-review notes (coverage vs. Issue 3)
- (a) query Ready/Target zone → Task 6 `resolveQueryFieldZone` + Task 8. (b) Response Deadline org zone → Task 6/8. (c) org default seeded admin config → Tasks 3/4. (d) manual Point zone picker → Tasks 2/5/10.
- Store true UTC → Task 1 (`zonedInputToUtc`) + `DateTime` columns unchanged. Zone labels everywhere → Tasks 7–11. UTC-instant temporal math → Task 2 (F3) + existing instant-based G10/T1/T2/T3/F4. Migration stamps existing rows → Task 3. DST-boundary test → Task 1.
