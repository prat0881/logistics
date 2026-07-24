# Fix — Route Canvas Incomplete Legs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Step-4 dead-end where an incomplete leg (missing/dangling origin or destination) is invisible on the route diagram — un-clickable, un-editable, un-deletable — yet still fails Create-Query validation (C1).

**Architecture:** Three targeted changes in the Step-4 subtree plus one server-side guard. (1) **LegEditor** re-adds a structural hard-block: Save (add + edit) requires both endpoints. (2) **PointEditor** blocks deleting a point a leg still references (client), and **PointsService.remove** enforces the same on the server (409) — because the `Leg→Point` FK is `onDelete: SetNull`, so today deleting a referenced point silently nulls the leg's endpoints (manufacturing the dangling leg this fix targets). (3) **LegsStep** grows a compact "Incomplete legs" strip listing legs that can't be drawn, each clickable → LegEditor edit mode — the escape hatch that remediates already-broken legs.

**Tech Stack:** React 18 + Vite + Tailwind + shadcn/ui + RHF + Zod · Vitest + `renderWithProviders`/`mockFetch` (web) · NestJS 10 + Prisma 5 · Supertest e2e (api, runs on GitHub CI).

## Global Constraints

- **`pnpm --filter @svyft/shared build && pnpm run ci` MUST be green before finishing.** Baseline on `main` after PR #18 (timezone): **shared 163 · web 200 · api 105**. This fix: **shared unchanged (163)** (no shared code touched); **web grows** (~+5 tests); **api grows +1 e2e → 106**. **No migration.**
- **Local gate order:** `pnpm --filter @svyft/shared build` FIRST (web vitest reads `@svyft/shared` from `dist`; root `pnpm run ci` runs `test` before `build` so it won't pre-build shared). No new shared runtime code here, so the `main` dist suffices — but build once to be safe.
- **Web CI gotcha:** run `pnpm --filter @svyft/web typecheck` (esbuild/`vite build` SKIPS type errors) and `pnpm --filter @svyft/web lint` (per-task vitest does not lint) before finishing.
- **API e2e runs on GitHub CI only** (no local DB this session, as with the timezone increment). CI uses a fresh **migrated-but-UNSEEDED** Postgres → every test is **seed-independent + self-cleaning** (own rows by a unique prefix; a `query.delete` cascades). The new points e2e MUST follow that pattern.
- **Preserve the relaxed model (increment 1 / Round-1 Common #5):** do NOT re-require `mode` / `assignedCargoIds` / `readyDate` / `targetDelivery` on a leg — those stay optional. Only `originPointId` + `destinationPointId` become required (they are *structural*, not draftable). **Points still save with no minimum** (self-anchoring — do not touch `pointSaveSchema` / the PointEditor save path). Keep the existing `legSaveSchema` refines (self-loop G12, ready ≤ target G10) and the V-M1 422 handling.
- **Web test conventions:** Vitest + `renderWithProviders` + `mockFetch`/`makeFetchMock`; `afterEach(vi.unstubAllGlobals())`. **Radix Select is jsdom-flaky** → drive the hidden native `<select aria-hidden="true">` (order: origin 0, destination 1, mode 2) via `fireEvent.change`, mirroring the existing LegEditor tests. Use valid UUIDs for `.uuid()` fields.
- **Commit per deliverable** (`fix(web)…` / `fix(api)…` / `test(...)…`). **Branch:** `fix/route-canvas-incomplete-legs` off `main`.
- **Out of scope:** any RouteDiagram change (the diagram intentionally still skips drawing an endpoint-less edge — the strip is the surface for those); the `pointSaveSchema` / point-required-fields model; the shared engine; the SetNull FK itself (kept as a DB last-resort behind the new service guard).

---

## Design decisions (read before implementing)

- **Why re-tighten leg Save (a deliberate exception to increment-1's "Save never blocks").** Increment 1 relaxed Point/Leg editors to save partial drafts. Endpoints are different from the other relaxed fields: a leg with no origin/destination is not a "draft leg", it is a *structurally invalid* graph edge that the diagram cannot render and that C1 always blocks at Create. Re-requiring the two endpoints (only) removes the dead-end at its source while keeping `mode`/`cargo`/`readyDate`/`targetDelivery` optional. Points stay unrestricted (a lone point is a valid, renderable node).
- **Hard-block lives in the submit callback, not the resolver.** `legSaveSchema` keeps `originPointId`/`destinationPointId` `.optional()` (shared, server-shared — untouched). The block is a targeted guard inside `form.handleSubmit(...)`: since the resolver passes for missing endpoints, the valid callback runs, we `form.setError` on the two fields and `return` before any POST/PATCH. RHF re-runs the resolver on the next submit (clearing the manual errors), so fixing both endpoints and re-saving proceeds normally.
- **Point-delete guard — client + server (defense-in-depth).** The `Leg→Point` FK is `onDelete: SetNull` ([schema.prisma:364-366](../../../prisma/schema.prisma)) and `PointsService.remove` relies on it, so deleting a referenced point today does **not** raise Prisma P2003 — Postgres nulls the leg's `originPointId`/`destinationPointId`, creating a dangling leg. The handoff's "P2003 → 500 → map to 409" premise is therefore moot (a P2003 mapping would be dead code). The correct fix: **PointEditor** blocks the delete client-side (clear inline message naming the referencing leg), and **PointsService.remove** enforces the same rule server-side by pre-checking for a referencing leg and throwing `ConflictException` (409) before the mediated delete. This reverses PR #17's "deleting a referenced point is allowed" design in line with the business decision to *guard point-deletion*.
- **Incomplete-legs strip is the escape hatch for already-broken legs.** Tasks 1–2 stop *new* dangling legs; the strip remediates ones that already exist (a stuck test query, or any pre-fix data). It lists every leg whose origin/destination is null or points at a non-existent point, each row clickable → LegEditor edit mode (complete it, or Delete it via the RC-T4 Delete button). It is a pure derivation of `detail` — no new persistence.

## File Structure

**`apps/web/src/features/query-wizard/steps/legs/`**
- `LegEditor.tsx` — MODIFY: endpoint hard-block in `handleSubmit` (T1).
- `LegEditor.test.tsx` — MODIFY: flip the partial-leg test → blocks; add edit-blocks + endpoints-only-saves (T1).
- `PointEditor.tsx` — MODIFY: `legs` prop + referencing-leg guard in `handleDelete` + inline error (T2).
- `PointEditor.test.tsx` — MODIFY: referenced → blocked (no DELETE); unreferenced → deletes (T2).
- `LegsStep.tsx` — MODIFY: `IncompleteLegsStrip` + thread `legs` into PointEditor call sites (T3, T2).
- `LegsStep.test.tsx` — MODIFY: incomplete-leg appears in strip + click opens dialog (T3).
- `LegEditor.tsx` — MODIFY: thread `detail.legs` into its nested "+ New point" PointEditor (T2).

**`apps/api/src/modules/points/`**
- `points.service.ts` — MODIFY: referencing-leg guard → `ConflictException` in `remove` (T2).
**`apps/api/test/`**
- `points.e2e-spec.ts` — MODIFY: 409 on deleting a referenced point (T2).

---

## Task 1: LegEditor — require Origin + Destination to Save

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx` (the `handleSubmit` callback, ~lines 149-167)
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegEditor.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — Save (add + edit) now no-ops (with inline field errors) unless both `originPointId` and `destinationPointId` are set.

- [ ] **Step 1: Flip / add the failing tests**

In `LegEditor.test.tsx`: **replace** the existing `it("saves a partial leg without hard-blocking (Round-1 Common #5)", …)` test (currently ~lines 499-537) with the three tests below. The first is the flip; the second exercises the edit path; the third guarantees the other fields stay optional.

```tsx
  it("blocks saving a NEW leg with no origin/destination (asserts no POST)", async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock({
      "/legs": (_url, init) =>
        Promise.resolve({
          ok: true,
          status: init?.method === "POST" ? 201 : 200,
          json: () => Promise.resolve({ id: "should-not-post" }),
          text: () => Promise.resolve("{}"),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor open detail={baseDetail} queryId={QUERY_ID} onSaved={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    // Leave origin + destination empty; click Save.
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Inline required errors appear on both endpoint fields.
    expect(await screen.findByText(/origin is required/i)).toBeInTheDocument();
    expect(screen.getByText(/destination is required/i)).toBeInTheDocument();

    // No POST fired.
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `/api/queries/${QUERY_ID}/legs` && (init as RequestInit)?.method === "POST",
    );
    expect(postCall).toBeFalsy();
  });

  it("blocks saving an EDIT when an endpoint is missing (asserts no PATCH)", async () => {
    const user = userEvent.setup();
    const EDIT_LEG_ID = "0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a";
    const editLeg = {
      id: EDIT_LEG_ID,
      tenantId: null,
      queryId: QUERY_ID,
      legCode: "L1",
      legName: null,
      mode: "ROAD" as const,
      originPointId: null, // dangling origin — the dead-end scenario
      destinationPointId: DELIVERY_POINT_ID,
      assignedCargoIds: [] as string[],
      readyDate: null,
      targetDelivery: null,
      status: "DRAFT" as const,
      executionStatus: "PENDING" as const,
      totalChargeableWeight: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
      rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
    };
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor open leg={editLeg} detail={baseDetail} queryId={QUERY_ID} onSaved={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/origin is required/i)).toBeInTheDocument();

    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `/api/queries/${QUERY_ID}/legs/${EDIT_LEG_ID}` &&
        (init as RequestInit)?.method === "PATCH",
    );
    expect(patchCall).toBeFalsy();
  });

  it("saves a leg with origin+destination but no mode/cargo/dates (relaxed fields stay optional)", async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock({
      "/legs": (_url, init) =>
        Promise.resolve({
          ok: true,
          status: init?.method === "POST" ? 201 : 200,
          json: () => Promise.resolve({ id: "0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b" }),
          text: () => Promise.resolve("{}"),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor open detail={baseDetail} queryId={QUERY_ID} onSaved={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    // Set only origin + destination (no mode, no cargo, no dates).
    const selects = getHiddenSelects();
    fireEvent.change(selects[0], { target: { value: PICKUP_POINT_ID } });
    fireEvent.change(selects[1], { target: { value: DELIVERY_POINT_ID } });

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/legs` && (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @svyft/web test LegEditor`
Expected: the two "blocks…" tests FAIL (Save still POSTs/PATCHes; no "required" text) — the endpoints-only test may already pass.

- [ ] **Step 3: Implement the hard-block**

In `LegEditor.tsx`, replace the `handleSubmit` definition (lines 149-167) with:

```tsx
  const handleSubmit = form.handleSubmit(async (data) => {
    setServerFindings([]);

    // Structural hard-block (add + edit): a leg with no origin/destination is not a
    // draft, it's an invalid graph edge (C1 always blocks it, the diagram can't draw
    // it). Unlike mode/cargo/dates, endpoints are required to Save. See the fix plan.
    let blocked = false;
    if (!data.originPointId) {
      form.setError("originPointId", { type: "manual", message: "Origin is required" });
      blocked = true;
    }
    if (!data.destinationPointId) {
      form.setError("destinationPointId", { type: "manual", message: "Destination is required" });
      blocked = true;
    }
    if (blocked) return;

    try {
      if (isEdit && leg) {
        await update(leg.id, data);
      } else {
        await add(data);
      }
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.findings?.length) {
        setServerFindings(err.findings);
        // Keep dialog open — do not call onClose()
      } else {
        throw err;
      }
    }
  });
```

(No other change — the Origin/Destination `FormField`s already render `<FormMessage />`, which surfaces the manual errors.)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @svyft/web test LegEditor && pnpm --filter @svyft/web typecheck`
Expected: PASS (all LegEditor tests, including the pre-existing "Save posts the correct payload…" and "surfaces server 422…" which set both endpoints).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx apps/web/src/features/query-wizard/steps/legs/LegEditor.test.tsx
git commit -m "fix(web): LegEditor requires Origin + Destination to Save (blocks add + edit)"
```

---

## Task 2: Block deleting a point a leg references — PointEditor (client) + PointsService (server)

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx` (thread `detail.legs` into the nested PointEditor)
- Modify: `apps/api/src/modules/points/points.service.ts`
- Modify: `apps/api/test/points.e2e-spec.ts`

**Interfaces:**
- Consumes: `QueryLegDto` (already exported from `@svyft/shared`).
- Produces: `PointEditorProps` gains `legs?: QueryLegDto[]` (default `[]`). `PointsService.remove` now throws `ConflictException` (409) if a leg references the point.

### Part A — PointEditor client guard

- [ ] **Step 1: Write the failing tests**

In `PointEditor.test.tsx`, add these two tests (inside the top-level `describe("PointEditor", …)`). The referencing leg fixture uses the same `EDIT_POINT_ID` as the point:

```tsx
  it("blocks deleting a point referenced by a leg (no DELETE) and shows a message", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const REF_POINT_ID = "aaaa1111-aaaa-1111-aaaa-1111aaaa1111";
    const refPoint = {
      id: REF_POINT_ID,
      type: "PICKUP" as const,
      name: "Used Point",
      streetAddress: "1 Test St",
      city: "London",
      postalCode: "SW1A",
      country: "UK",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      timezone: null,
    };
    // A leg whose origin is this point.
    const legs = [
      {
        id: "bbbb2222-bbbb-2222-bbbb-2222bbbb2222",
        tenantId: null,
        queryId: QUERY_ID,
        legCode: "L1",
        legName: null,
        originPointId: REF_POINT_ID,
        destinationPointId: null,
        mode: null,
        readyDate: null,
        targetDelivery: null,
        status: "DRAFT" as const,
        executionStatus: "PENDING" as const,
        totalChargeableWeight: null,
        createdAt: "2026-01-01T00:00:00+00:00",
        updatedAt: "2026-01-01T00:00:00+00:00",
        assignedCargoIds: [],
        rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
      },
    ];

    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(url.includes("/api/auth/me") ? { user: testUser } : {}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open point={refPoint} legs={legs} onSaved={vi.fn()} onClose={vi.fn()} />,
      { user: testUser },
    );

    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    // A clear message naming the leg appears; no confirm, no DELETE.
    expect(await screen.findByText(/used by leg L1/i)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    const deleteCall = fetchMock.mock.calls.find(
      ([url, init]) => (init as RequestInit)?.method === "DELETE",
    );
    expect(deleteCall).toBeFalsy();
  });

  it("deletes an unreferenced point (legs present but none reference it)", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const FREE_POINT_ID = "cccc3333-cccc-3333-cccc-3333cccc3333";
    const freePoint = {
      id: FREE_POINT_ID,
      type: "WAREHOUSE" as const,
      name: "Unused WH",
      streetAddress: "9 Free St",
      city: "Leeds",
      postalCode: "LS1",
      country: "UK",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      timezone: null,
    };
    // A leg that references OTHER points, not freePoint.
    const legs = [
      {
        id: "dddd4444-dddd-4444-dddd-4444dddd4444",
        tenantId: null,
        queryId: QUERY_ID,
        legCode: "L1",
        legName: null,
        originPointId: "eeee5555-eeee-5555-eeee-5555eeee5555",
        destinationPointId: "ffff6666-ffff-6666-ffff-6666ffff6666",
        mode: "ROAD" as const,
        readyDate: null,
        targetDelivery: null,
        status: "DRAFT" as const,
        executionStatus: "PENDING" as const,
        totalChargeableWeight: null,
        createdAt: "2026-01-01T00:00:00+00:00",
        updatedAt: "2026-01-01T00:00:00+00:00",
        assignedCargoIds: [],
        rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
      },
    ];

    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(url.includes("/api/auth/me") ? { user: testUser } : {}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <PointEditor queryId={QUERY_ID} open point={freePoint} legs={legs} onSaved={vi.fn()} onClose={vi.fn()} />,
      { user: testUser },
    );

    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/points/${FREE_POINT_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });
```

- [ ] **Step 2: Run to verify (Part A fails)**

Run: `pnpm --filter @svyft/web test PointEditor`
Expected: "blocks deleting a point referenced by a leg" FAILS (today `handleDelete` deletes unconditionally). The `legs` prop is also a typecheck error until Step 3.

- [ ] **Step 3: Implement the client guard**

In `PointEditor.tsx`:

1. Add the `QueryLegDto` type import (extend the existing `@svyft/shared` type import):
```tsx
import type {
  PointSaveInput,
  PointUpdateInput,
  PointType,
  QueryLegDto,
} from "@svyft/shared";
```

2. Add `legs` to `PointEditorProps` (after `point?`):
```tsx
  /** Legs in this query — used to block deleting a point a leg still references. */
  legs?: QueryLegDto[];
```

3. Destructure it with a default in the component signature (add `legs = [],` alongside `point,`):
```tsx
export function PointEditor({
  queryId,
  open,
  type: typeProp,
  point,
  legs = [],
  onSaved,
  onClose,
}: PointEditorProps) {
```

4. Add a delete-error state next to the other state (after `selectedType`):
```tsx
  const [deleteError, setDeleteError] = useState<string | null>(null);
```

5. Replace `handleDelete` (lines 168-173) with the guarded version:
```tsx
  const handleDelete = async () => {
    if (!point) return;
    const referencing = legs.find(
      (l) => l.originPointId === point.id || l.destinationPointId === point.id,
    );
    if (referencing) {
      setDeleteError(
        `This point is used by leg ${referencing.legCode} — edit or remove that leg first.`,
      );
      return;
    }
    if (!window.confirm("Delete this point?")) return;
    await remove(point.id);
    onSaved(point as unknown as Record<string, unknown>);
    onClose();
  };
```

6. Render the message just above the `<DialogFooter>` (inside the `<form>`, after the optional-contacts block, before `<DialogFooter>`):
```tsx
            {deleteError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {deleteError}
              </p>
            )}

            <DialogFooter>
```

- [ ] **Step 4: Thread `detail.legs` into both PointEditor call sites**

`LegsStep.tsx` — the body's PointEditor (currently ~lines 159-166) gains `legs={detail.legs}`:
```tsx
      <PointEditor
        key={editingPoint?.id ?? "new-point"}
        queryId={queryId}
        open={pointEditorOpen}
        point={editingPoint as unknown as ComponentProps<typeof PointEditor>["point"]}
        legs={detail.legs}
        onSaved={closePointEditor}
        onClose={closePointEditor}
      />
```

`LegEditor.tsx` — the nested "+ New point" PointEditor (currently ~lines 382-389) gains `legs={detail.legs}` (harmless — it is always add-mode, so the guard never triggers, but it keeps the prop wired):
```tsx
      {showPointEditor && (
        <PointEditor
          queryId={queryId}
          open={Boolean(showPointEditor)}
          legs={detail.legs}
          onSaved={(saved) => handlePointSaved(showPointEditor, saved)}
          onClose={() => setShowPointEditor(null)}
        />
      )}
```

- [ ] **Step 5: Run to verify (Part A passes)**

Run: `pnpm --filter @svyft/web test PointEditor && pnpm --filter @svyft/web typecheck`
Expected: PASS. (The pre-existing "edit mode shows a Delete button that removes the point after confirm" renders WITHOUT `legs` → default `[]` → no referencing leg → still deletes.)

- [ ] **Step 6: Commit Part A**

```bash
git add apps/web/src/features/query-wizard/steps/legs/PointEditor.tsx apps/web/src/features/query-wizard/steps/legs/PointEditor.test.tsx apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx apps/web/src/features/query-wizard/steps/legs/LegEditor.tsx
git commit -m "fix(web): block deleting a point a leg references (PointEditor guard)"
```

### Part B — PointsService server guard (verified on GitHub CI)

- [ ] **Step 7: Write the failing e2e test**

In `apps/api/test/points.e2e-spec.ts`, add after the "patches and deletes a point" test (before the closing `});` of the describe):

```tsx
  it("409s when deleting a point referenced by a leg (does not null the endpoint)", async () => {
    const pu = await prisma.point.create({ data: { queryId, type: "PICKUP", name: "RefPU" } });
    const de = await prisma.point.create({ data: { queryId, type: "DELIVERY", name: "RefDE" } });
    const leg = await prisma.leg.create({
      data: { queryId, legCode: `${PFX}L1`, originPointId: pu.id, destinationPointId: de.id, mode: "ROAD" },
    });

    await request(app.getHttpServer())
      .delete(`/api/queries/${queryId}/points/${pu.id}`)
      .set("Cookie", cookie())
      .expect(409);

    // The leg still references the point — the SetNull FK was NOT reached.
    const reloaded = await prisma.leg.findUnique({ where: { id: leg.id } });
    expect(reloaded?.originPointId).toBe(pu.id);

    // Cleanup this test's leg so it doesn't collide with other specs' legCode scans.
    await prisma.leg.delete({ where: { id: leg.id } });
  });
```

(`legCode` is prefixed with `PFX` to stay self-cleaning; the leg is deleted inline, and `afterAll` cascades the query.)

- [ ] **Step 8: Implement the server guard**

In `apps/api/src/modules/points/points.service.ts`:

1. Add `ConflictException` to the `@nestjs/common` import:
```tsx
import { Injectable, NotFoundException, ConflictException } from "@nestjs/common";
```

2. Replace `remove` (lines 69-78) with the guarded version:
```tsx
  async remove(queryId: string, pointId: string, user: RequestUser) {
    await this.load(queryId, pointId);

    // Guard: a point still used by a leg cannot be deleted. Without this the
    // Leg→Point SetNull FK would silently null the leg's endpoint, manufacturing
    // a dangling (un-drawable, C1-blocking) leg. Mirror of the PointEditor guard.
    const referencingLeg = await this.prisma.leg.findFirst({
      where: { queryId, OR: [{ originPointId: pointId }, { destinationPointId: pointId }] },
      select: { legCode: true },
    });
    if (referencingLeg) {
      throw new ConflictException(
        `Point is referenced by leg ${referencingLeg.legCode} — remove or edit that leg first`,
      );
    }

    await this.mediator.apply(
      { entity: "point", id: pointId, action: "@delete", queryId, actorId: user.userId },
      async (tx) => {
        await tx.point.delete({ where: { id: pointId } });
      },
    );
  }
```

(The old "Referencing legs' endpoints are nulled by the SetNull FK" comment is removed — that path is now guarded off.)

- [ ] **Step 9: Verify locally as far as possible (no DB → e2e runs on CI)**

Run: `pnpm --filter @svyft/api build` (compiles the service; e2e itself runs on GitHub CI).
Expected: build PASS. Note the e2e assertion runs in CI — confirm green there before merge.

- [ ] **Step 10: Commit Part B**

```bash
git add apps/api/src/modules/points/points.service.ts apps/api/test/points.e2e-spec.ts
git commit -m "fix(api): 409 when deleting a point a leg references (guard the SetNull FK)"
```

---

## Task 3: LegsStep — "Incomplete legs" escape strip

**Files:**
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx`
- Modify: `apps/web/src/features/query-wizard/steps/legs/LegsStep.test.tsx`

**Interfaces:**
- Consumes: `detail.legs`, `detail.points`, `grouped.byLeg` (from `useRouteFindings`), and `handleEdit(leg)` (already present in `LegsStepBody`).
- Produces: a compact strip listing un-drawable legs, each row → `handleEdit(leg)` (LegEditor edit mode).

- [ ] **Step 1: Write the failing test**

In `LegsStep.test.tsx`, add a fixture leg with a null endpoint and a test. Put the fixture near `legDto` (after it):

```tsx
const danglingLegDto = {
  ...legDto,
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  legCode: "L2",
  originPointId: null, // dangling — RouteDiagram can't draw it
  destinationPointId: DELIVERY_POINT_ID,
  assignedCargoIds: [],
  rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
};
const detailWithDangling = { ...baseDetail, legs: [danglingLegDto] };
```

Then add the test:

```tsx
  it("lists an incomplete (dangling-endpoint) leg in the escape strip and opens the editor on click", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: detailWithDangling };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );
    await navigateToStep4();

    // The strip names the incomplete leg + the "needs origin & destination" hint.
    const stripRow = await screen.findByRole("button", { name: /L2.*needs origin & destination/i });
    expect(stripRow).toBeInTheDocument();

    // Clicking the row opens the LegEditor dialog (edit mode) so it can be completed/deleted.
    await user.click(stripRow);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @svyft/web test LegsStep`
Expected: FAIL (no strip row → `findByRole("button", { name: /L2.*needs origin/i })` times out).

- [ ] **Step 3: Implement the strip**

In `LegsStep.tsx`, inside `LegsStepBody`, after the existing `handleEdit`/close handlers and before the `return`, derive the incomplete legs:

```tsx
  // Legs the RouteDiagram cannot draw (missing/dangling endpoints) — the escape
  // hatch below is the only place to reach them. Pure derivation of `detail`.
  const incompleteLegs = detail.legs.filter(
    (l) =>
      !l.originPointId ||
      !l.destinationPointId ||
      !detail.points.some((p) => p.id === l.originPointId) ||
      !detail.points.some((p) => p.id === l.destinationPointId),
  );
```

Then render the strip in the JSX, between the toolbar and the `<RouteDiagram>` (after the closing `</div>` of the toolbar block, before `{/* Route diagram … */}`):

```tsx
      {/* Incomplete-legs escape strip — only when there are un-drawable legs. */}
      {incompleteLegs.length > 0 && (
        <div
          role="group"
          aria-label="Incomplete legs"
          className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
        >
          <p className="font-medium text-warning">
            {incompleteLegs.length} incomplete leg
            {incompleteLegs.length === 1 ? "" : "s"} can't be shown on the route — click to fix or
            delete:
          </p>
          <ul className="space-y-1">
            {incompleteLegs.map((l) => {
              const finding = grouped.byLeg.get(l.id)?.[0]?.message;
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => handleEdit(l)}
                    className="w-full rounded px-2 py-1 text-left hover:bg-warning/20"
                  >
                    <span className="mr-2 font-mono text-xs">{l.legCode}</span>
                    <span className="text-muted-foreground">needs origin & destination</span>
                    {finding && <span className="ml-2 text-destructive">— {finding}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
```

- [ ] **Step 4: Run the full web suite + typecheck + lint**

Run: `pnpm --filter @svyft/web test && pnpm --filter @svyft/web typecheck && pnpm --filter @svyft/web lint`
Expected: all green. (A Radix Select test may flake once → re-run. The existing "shows route findings as a hover tooltip on the diagram edge" test uses `detailWithLeg` whose leg has both endpoints → NOT incomplete → strip absent → unaffected.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/query-wizard/steps/legs/LegsStep.tsx apps/web/src/features/query-wizard/steps/legs/LegsStep.test.tsx
git commit -m "fix(web): incomplete-legs escape strip in LegsStep (reach un-drawable legs)"
```

---

## Definition of Done

- [ ] All three tasks committed on `fix/route-canvas-incomplete-legs` (Task 2 = two commits: web guard + api guard).
- [ ] **`pnpm --filter @svyft/shared build && pnpm run ci` green** locally for shared + web (shared **163** unchanged; web **~205**). `pnpm --filter @svyft/web typecheck` + `pnpm --filter @svyft/web lint` clean.
- [ ] **GitHub CI green** — the api e2e (`points.e2e-spec.ts` 409 test → api **106**) runs there (no local DB this session).
- [ ] Opus **whole-branch review** — expect it to probe: the endpoint hard-block covering add AND edit (and NOT re-blocking mode/cargo/dates); the point-delete guard on both client + server (referenced → blocked; unreferenced → deletes; 409 does not null the endpoint); the strip listing exactly the un-drawable legs and click → edit dialog; and that the relaxed point-save model + the RouteDiagram are untouched.
- [ ] Finish via `superpowers:finishing-a-development-branch` → PR to `main`. **PR note:** this re-tightens leg Save (a deliberate exception to increment-1's "Save never blocks" — endpoints are structural, unlike the other relaxed fields; points still save with no minimum since they're self-anchoring), and adds a server-side 409 guard because the `Leg→Point` FK is `SetNull` (P2003 never fires). Update `docs/Stage 3 - Session Handoff.md` with a short note that this fix landed (before Plan 7).

## Self-Review notes (spec coverage)

- LegEditor requires Origin+Destination to Save (add + edit), inline errors, other fields stay optional, refines/V-M1 preserved → **Task 1** (+ flipped/added tests).
- Block deleting a referenced point, message names the leg, `detail.legs` threaded from LegsStep (+ LegEditor's nested editor) → **Task 2 Part A**; server 409 guard + e2e (real fix for the SetNull silent-null, per the user's decision) → **Task 2 Part B**.
- Incomplete-legs strip (null OR dangling-to-missing-point endpoints), legCode + hint + finding, click → LegEditor edit mode, placed above the RouteDiagram, rendered only when non-empty → **Task 3** (+ test).
- Relaxed point-save model + RouteDiagram + shared engine untouched → Global Constraints / Out of scope.
