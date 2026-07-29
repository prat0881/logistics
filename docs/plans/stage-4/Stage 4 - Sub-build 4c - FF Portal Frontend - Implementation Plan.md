# Stage 4 · Sub-build 4c — FF Portal Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public, no-login `/ff/rfq/:token` SPA where an invited freight forwarder reviews their scoped RFQ (read-only cargo) and enters a per-leg quote with live chargeable-weight/Grand-Total recalc, Save Draft, and Submit — consuming the existing SB4b endpoints and running the same `@svyft/shared` engine client-side.

**Architecture:** Pure frontend in `apps/web` (no backend/API change). A dedicated token-in-path fetch client (NOT the shared `fetchJson`, to dodge the global-logout 401 hazard) feeds TanStack Query hooks. One React-Hook-Form form per leg (`zodResolver(quoteDraftSchema)`) with page-level RFQ currency/validity merged into each draft. `@svyft/shared` provides all math (`computeChargeableWeight`, `computeQuoteTotals`) and the client submit gate (`validateQuote`). Visual layer reuses the internal shadcn "maritime ledger" design system, polished into a trustworthy external shell with a signature live deadline countdown.

**Tech Stack:** React 18 + TypeScript, Vite, TanStack Query, React Hook Form + Zod, shadcn/ui (Radix + Tailwind), `@svyft/shared`, Vitest + React Testing Library.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the SB4c Design doc + Technical Design + the codebase facts gathered for this plan.

- **No backend/API change.** SB4b is the complete contract. This slice is `apps/web`-only. `@svyft/shared` is expected to need **no** changes (all engine/types already exist and are browser-safe — only `zod`, no `fs`/`crypto`/Prisma).
- **All new files live in** `apps/web/src/features/ff-portal/` unless a path says otherwise. One co-located `*.test.tsx` (or `*.test.ts`) per source file.
- **Dedicated portal client — never `lib/api.ts`.** `apps/web/src/lib/api.ts`'s `raise()` calls a global `onUnauthorized()` on ANY non-`/api/auth/` 401, which does `setUser(null)` + `queryClient.clear()` — i.e. it would **log out a staff member** who has the app open in another tab when a portal token expires. The portal MUST use its own `portalClient.ts` (`credentials: "omit"`, never touches `onUnauthorized`, throws a typed `PortalError`).
- **Never use `useOrgTimezone`** (it calls `/api/config/*` — auth-only). The deadline countdown is **viewer-local** (a plain duration off the ISO instant; no timezone lookup). Transit dates use `datetime-local` (viewer-local) → ISO on save.
- **Read the TOP-LEVEL `currency` / `quoteValidityUntil`** from `FfPortalRfqDto` (RFQ-level). NEVER read the draft blob's copies. These two page-level values are merged into every leg's `QuoteDraft` on Save Draft / Submit.
- **TanStack Query:** query key `["ff-rfq", token]`; the GET query uses `retry: false` (so a 401 surfaces immediately). Mutations `invalidateQueries({ queryKey: ["ff-rfq", token] })` on success.
- **Forms:** one `useForm<QuoteDraft>({ resolver: zodResolver(quoteDraftSchema), defaultValues: draftFromDto(leg, rfq) })` per leg. Use the shadcn `Form`/`FormField` pattern (field spread, `useFormContext`/`useFieldArray`), NOT bare `Controller`. **Numeric inputs must convert `"" → null` else `Number(...)`** (the schema requires `amount: number | null`, etc.) — use the shared `NumberField` (Task 1).
- **Decimals are strings in the DTO** (`grossWt`, `volumeCbm`, `dimL/W/H`, `netWt`). Convert with `Number(...)` at the boundary; render numbers `font-mono tabular-nums`.
- **Reuse** shadcn primitives from `@/components/ui/*`: `Card`(+Header/Title/Description/Content/Footer), `Input`, `Label`, `Select`(+Trigger/Value/Content/Item), `Button`, `Table`(+Header/Body/Row/Head/Cell), `Checkbox`, `Textarea`, `Form`/`FormField`/`FormItem`/`FormLabel`/`FormControl`/`FormMessage`, `Badge`, `Separator`. **`Alert` and `Skeleton` do NOT exist** — build those inline with `div` + tokens.
- **`ValidationSummary` is NOT reused verbatim** (it is hard-wired to SB3 wizard tabs — labels like "Client & Query" / "Leg & Route" and `onNavigate(tab: FindingTab)` — which are meaningless on a public quote form). Build a portal-specific `QuoteFindingsSummary` that mirrors its visual style but navigates by portal section (Task 13).
- **Engine/types import from `@svyft/shared`** with REAL imports in tests (never mock the engine — it's pure). If `@svyft/shared` were ever changed, run `pnpm --filter @svyft/shared build` before web tests (none expected here).
- **Same-origin serving:** `/api` is proxied in dev — no API base env var; fetch relative `/api/ff/rfq/...` paths.
- **Test harness:** Vitest + RTL. Stub the network with `mockFetch` from `@/test/mock-fetch` via `vi.stubGlobal("fetch", mockFetch(handler))`; `afterEach(() => vi.unstubAllGlobals())`. Component tests use `renderWithProviders` from `@/test/renderWithProviders` (wraps QueryClientProvider + AuthProvider + MemoryRouter; `route` option sets the initial entry). Run web tests with `pnpm --filter @svyft/web test`.
- **Commit after every task.** Branch: `feat/stage-4-sb4c` (worktree already at `.claude/worktrees/feat+stage-4-sb4c`, off `main`@`71feea7`).
- **Copy tone:** active voice, sentence case, from the forwarder's side. Buttons say what happens: **"Submit quote"**, **"Save draft"**. Errors give direction, never apologize.

## Design Direction (frontend-design output — implementers MUST match)

The internal app already has a distinctive, non-generic identity ("maritime ledger"): cool blue-grey ground `--background #F4F6FA`, near-navy ink `--foreground #0E1826`, deep maritime cobalt `--primary #0A4FA0`, signal amber `--accent #E08A17`, plus `--success #12795A` / `--warning #B45309` / `--destructive #BE2436`. Three self-hosted faces: **Space Grotesk** (`font-display`), **Inter** (body), **IBM Plex Mono** (`font-mono`, tabular numerals). The brief **locks** the portal to reuse this system (clean + professional + consistent); frontend-design's job is a restrained polish of the *external* shell + trust cues, not a new identity. Concretely:

- **Grounding:** the viewer is a pricing/ops person at a forwarding company, opening an unfamiliar link to price a shipment against a deadline. The page's one job: understand the scoped legs and submit a priced quote before time runs out. The vernacular is freight ledgers (THC, chargeable weight, BoL, CBM) — lean into it with the mono tabular treatment.
- **Shell:** page ground `bg-background`. A top **trust band** (`bg-card border-b border-b-primary/70`, mirroring `AppLayout` so it feels like the same company) with the **exact** brand wordmark — `font-display text-base font-semibold tracking-tight` "Svyft" + `text-primary` "Logistics" — plus a quiet eyebrow "Request for quote", and on the right the **signature** deadline countdown. Content in a centered `max-w-5xl` column of white `Card` sections. A slim footer: "Svyft Logistics · secure RFQ link".
- **Signature element — the live deadline countdown.** Rendered in `font-mono tabular-nums` ("2d 14h 03m"), a chip that color-shifts as the deadline nears: **≥24h** calm (`text-muted-foreground bg-muted`), **12–24h** `text-warning bg-warning/10`, **<12h** urgent `text-destructive bg-destructive/10`, **past** a solid destructive "Deadline passed" state. It embodies the brief (a time-boxed RFQ) and is honest information, not decoration. It is the ONE attention-drawing element — keep everything else quiet (Chanel's "remove one accessory": no numbered step markers, no progress meters).
- **Numbers are the texture.** EVERY figure — amounts, chargeable weight, CBM, dims, subtotals, Grand Total, countdown — is `font-mono tabular-nums`. The **Grand Total** is the second focal point: `font-display` label + a large mono figure in the sticky submission bar, with the resolved `currency` code.
- **Hierarchy inside a leg:** eyebrow label (`text-xs font-semibold uppercase tracking-wide text-muted-foreground`) + section title, then content. Read-only data uses `bg-muted` fills so editable inputs (white) read as "your job". DG cargo gets a `Badge variant="warning"`. Incoterms shown as a `Badge`. Status uses the existing badge variants (`success` for submitted).
- **Quality floor (unstated but required):** responsive to mobile (single column; tables scroll-x), visible keyboard focus (shadcn defaults), `prefers-reduced-motion` respected (countdown updates text only — no animation to disable, but don't add any).

## File Structure

All under `apps/web/src/features/ff-portal/` unless noted. Each `.tsx`/`.ts` has a co-located test.

| File | Responsibility |
|---|---|
| `numeric.ts` | `toNumOrNull`, `NumberField` re-export barrel is not needed; pure number helpers |
| `NumberField.tsx` | RHF-friendly numeric `<Input>` (`"" → null` conversion, mono) |
| `format.ts` | `fmtAmount`, `fmtWeight`, `fmtCbm`, `fmtDecimal`, `toDatetimeLocal`/`fromDatetimeLocal` |
| `portalClient.ts` | `PortalError` + `portalGet/portalPatch/portalPost` (`credentials:"omit"`, no `onUnauthorized`) |
| `useFfPortal.ts` | `useFfRfq`, `useSaveDraft`, `useSubmit` TanStack Query hooks |
| `draftFromDto.ts` | `draftFromDto(leg, rfq) → QuoteDraft` (seed from `leg.draft` else seeds) |
| `useCountdown.ts` | `useCountdown(deadlineIso) → { text, tier, expired }` viewer-local |
| `usePortalHead.ts` | set document title + inject `<meta name="robots" content="noindex">` |
| `findingNav.ts` | `findingSection(finding) → PortalSection` + section labels/order |
| `CargoManifestTable.tsx` | read-only manifest cargo table |
| `DensityChargeableGrid.tsx` | per-cargo density input → live chargeable weight |
| `ChargeZonePanel.tsx` | Air/Sea preset charge lines by zone + amount/note + [+ Add line] |
| `TruckingBlocks.tsx` | Road: one charge per endpoint (type/basis/amount/remarks), no add-line |
| `WarehouseStaging.tsx` | per warehouse endpoint: label + amount + acceptance window |
| `TransitPlanForm.tsx` | departure/arrival `datetime-local` + optional carrier fields |
| `QuoteSummary.tsx` | live `computeQuoteTotals` → subtotals + chargeable wt + Grand Total |
| `QuoteFindingsSummary.tsx` | portal ValidationSummary-style blocking list, section-aware nav |
| `SubmissionBar.tsx` | DG note + T&C + Save draft + Submit controls (presentational) |
| `LegSection.tsx` | one RHF form per leg; composes the above; owns save/submit + findings |
| `PortalShell.tsx` | external header (wordmark, RFQ meta, countdown) + RFQ-level currency/validity |
| `terminalStates.tsx` | `InvalidTokenCard`, `ExpiredBanner`, `AlreadySubmittedSummary` |
| `FfPortalPage.tsx` | reads `:token`, `useFfRfq`, branches terminal/loaded; noindex head |
| `apps/web/src/App.tsx` (modify) | add `<Route path="/ff/rfq/:token" element={<FfPortalPage/>}/>` outside `<Protected>` |

---

## Task 1: Number helpers — `numeric.ts`, `NumberField.tsx`, `format.ts`

**Files:**
- Create: `apps/web/src/features/ff-portal/numeric.ts`
- Create: `apps/web/src/features/ff-portal/NumberField.tsx`
- Create: `apps/web/src/features/ff-portal/format.ts`
- Test: `apps/web/src/features/ff-portal/numeric.test.ts`
- Test: `apps/web/src/features/ff-portal/format.test.ts`
- Test: `apps/web/src/features/ff-portal/NumberField.test.tsx`

**Interfaces:**
- Produces:
  - `toNumOrNull(v: string | number | null | undefined): number | null`
  - `NumberField(props: { value: number | null; onChange: (v: number | null) => void } & Omit<InputProps,"value"|"onChange"|"type">): JSX.Element`
  - `fmtAmount(v: number | null, currency?: string | null): string` — e.g. `"1,250.00"` (no currency symbol; currency shown separately)
  - `fmtWeight(t: number): string` — tonnes, 3 dp
  - `fmtCbm(v: string | number | null): string` — 4 dp or `"—"`
  - `fmtDecimal(v: string | number | null, dp?: number): string` — generic, `"—"` for null/NaN
  - `toDatetimeLocal(iso: string | null): string` — ISO → `"YYYY-MM-DDTHH:mm"` (viewer-local) or `""`
  - `fromDatetimeLocal(local: string): string | null` — `"YYYY-MM-DDTHH:mm"` → ISO or `null`

- [ ] **Step 1: Write failing tests** (`numeric.test.ts` + `format.test.ts`)

```ts
// numeric.test.ts
import { describe, it, expect } from "vitest";
import { toNumOrNull } from "./numeric";

describe("toNumOrNull", () => {
  it("maps empty/nullish to null", () => {
    for (const v of ["", null, undefined]) expect(toNumOrNull(v)).toBeNull();
  });
  it("parses numeric strings and passes numbers through", () => {
    expect(toNumOrNull("12.5")).toBe(12.5);
    expect(toNumOrNull(0)).toBe(0);
  });
  it("maps non-finite to null", () => {
    expect(toNumOrNull("abc")).toBeNull();
    expect(toNumOrNull(NaN)).toBeNull();
  });
});
```

```ts
// format.test.ts
import { describe, it, expect } from "vitest";
import { fmtAmount, fmtWeight, fmtCbm, fmtDecimal, toDatetimeLocal, fromDatetimeLocal } from "./format";

describe("format helpers", () => {
  it("fmtAmount groups thousands with 2dp, dash for null", () => {
    expect(fmtAmount(1250)).toBe("1,250.00");
    expect(fmtAmount(null)).toBe("—");
  });
  it("fmtWeight is 3dp tonnes", () => expect(fmtWeight(2.5)).toBe("2.500"));
  it("fmtCbm parses strings, 4dp, dash for null", () => {
    expect(fmtCbm("1.2")).toBe("1.2000");
    expect(fmtCbm(null)).toBe("—");
  });
  it("fmtDecimal handles NaN/null", () => expect(fmtDecimal("x")).toBe("—"));
  it("datetime-local round-trips a UTC instant back to an ISO instant", () => {
    const iso = "2026-08-01T09:30:00.000Z";
    const local = toDatetimeLocal(iso);          // viewer-local wall time
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(fromDatetimeLocal(local)!).getTime()).toBe(new Date(iso).getTime());
  });
  it("fromDatetimeLocal maps empty to null", () => expect(fromDatetimeLocal("")).toBeNull());
});
```

- [ ] **Step 2: Run tests, verify they fail** — `pnpm --filter @svyft/web test -- numeric format` → FAIL (modules not found).

- [ ] **Step 3: Implement**

```ts
// numeric.ts
export function toNumOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
```

```tsx
// NumberField.tsx
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange" | "type"> & {
  value: number | null;
  onChange: (v: number | null) => void;
};

export const NumberField = forwardRef<HTMLInputElement, Props>(function NumberField(
  { value, onChange, className, ...rest }, ref,
) {
  return (
    <Input
      ref={ref}
      type="number"
      inputMode="decimal"
      className={cn("font-mono tabular-nums", className)}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      {...rest}
    />
  );
});
```

```ts
// format.ts
export function fmtDecimal(v: string | number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : "—";
}
export function fmtAmount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtWeight(t: number): string {
  return Number.isFinite(t) ? t.toFixed(3) : "—";
}
export function fmtCbm(v: string | number | null | undefined): string {
  return fmtDecimal(v, 4);
}
function pad(n: number): string { return String(n).padStart(2, "0"); }
export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromDatetimeLocal(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);            // interpreted as viewer-local wall time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
```

- [ ] **Step 4: Write `NumberField.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumberField } from "./NumberField";

describe("NumberField", () => {
  it("emits null when cleared and a number when typed", async () => {
    const onChange = vi.fn();
    render(<NumberField aria-label="amt" value={null} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("amt"), "42");
    expect(onChange).toHaveBeenLastCalledWith(42);
  });
});
```

- [ ] **Step 5: Run all Task-1 tests → PASS.** `pnpm --filter @svyft/web test -- ff-portal/numeric ff-portal/format ff-portal/NumberField`

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(ff-portal): number + format helpers and NumberField"`

---

## Task 2: `portalClient.ts` — dedicated fetch client + `PortalError`

**Files:**
- Create: `apps/web/src/features/ff-portal/portalClient.ts`
- Test: `apps/web/src/features/ff-portal/portalClient.test.ts`

**Interfaces:**
- Produces:
  - `class PortalError extends Error { readonly status: number; readonly body: unknown; get findings(): Finding[] | undefined }`
  - `portalGet<T>(path: string): Promise<T>`
  - `portalPatch<T>(path: string, body: unknown): Promise<T>`
  - `portalPost<T>(path: string, body: unknown): Promise<T>`
  - CRITICAL: uses `fetch(path, { credentials: "omit" })`; NEVER imports from `@/lib/api`; NEVER calls `onUnauthorized`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mockFetch } from "@/test/mock-fetch";
import { portalGet, portalPatch, portalPost, PortalError } from "./portalClient";

afterEach(() => vi.unstubAllGlobals());

describe("portalClient", () => {
  it("GET returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 200, body: { rfqNumber: "R-1" } })));
    await expect(portalGet("/api/ff/rfq/tok")).resolves.toEqual({ rfqNumber: "R-1" });
  });

  it("GET sends credentials:omit (never the cookie)", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    await portalGet("/api/ff/rfq/tok");
    expect(fx).toHaveBeenCalledWith("/api/ff/rfq/tok", expect.objectContaining({ credentials: "omit" }));
  });

  it("401 throws PortalError(401) and does NOT import lib/api onUnauthorized", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 401, body: { message: "bad token" } })));
    const err = await portalGet("/api/ff/rfq/bad").catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect(err.status).toBe(401);
  });

  it("422 carries findings on the error", async () => {
    const findings = [{ rule: "Q1", severity: "blocking", scope: { type: "leg", id: "L1" }, message: "x" }];
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 422, body: { findings } })));
    const err: PortalError = await portalPost("/api/ff/rfq/tok/quotes/L1/submit", {}).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.findings).toEqual(findings);
  });

  it("409 throws PortalError(409)", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 409, body: {} })));
    const err: PortalError = await portalPost("/api/ff/rfq/tok/quotes/L1/submit", {}).catch((e) => e);
    expect(err.status).toBe(409);
  });

  it("PATCH sends JSON body + Content-Type", async () => {
    const fx = mockFetch(() => ({ status: 200, body: { ok: true } }));
    vi.stubGlobal("fetch", fx);
    await portalPatch("/api/ff/rfq/tok/quotes/L1", { legId: "L1" });
    expect(fx).toHaveBeenCalledWith(
      "/api/ff/rfq/tok/quotes/L1",
      expect.objectContaining({
        method: "PATCH",
        credentials: "omit",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ legId: "L1" }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm --filter @svyft/web test -- ff-portal/portalClient`).

- [ ] **Step 3: Implement**

```ts
// portalClient.ts — the portal's ONLY network client. Deliberately independent of
// lib/api.ts so a portal 401 can NEVER trigger the app's global logout (setUser(null)+cache clear).
import type { Finding } from "@svyft/shared";

export class PortalError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Portal request failed: ${status}`);
    this.name = "PortalError";
  }
  get findings(): Finding[] | undefined {
    const f = (this.body as Record<string, unknown> | undefined)?.findings;
    return Array.isArray(f) ? (f as Finding[]) : undefined;
  }
}

async function parse(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return undefined; }
}

export async function portalGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "omit" });
  const body = await parse(res);
  if (!res.ok) throw new PortalError(res.status, body);
  return body as T;
}

async function write<T>(method: "PATCH" | "POST", path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await parse(res);
  if (!res.ok) throw new PortalError(res.status, body);
  return body as T;
}

export const portalPatch = <T>(path: string, body: unknown) => write<T>("PATCH", path, body);
export const portalPost = <T>(path: string, body: unknown) => write<T>("POST", path, body);
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): dedicated portalClient + PortalError (no global-logout 401 hazard)"`

---

## Task 3: `useFfPortal.ts` — TanStack Query hooks

**Files:**
- Create: `apps/web/src/features/ff-portal/useFfPortal.ts`
- Test: `apps/web/src/features/ff-portal/useFfPortal.test.tsx`

**Interfaces:**
- Consumes: `portalGet/portalPatch/portalPost`, `PortalError` (Task 2); `FfPortalRfqDto`, `QuoteDraft` (`@svyft/shared`).
- Produces:
  - `useFfRfq(token: string) → UseQueryResult<FfPortalRfqDto, PortalError>` — key `["ff-rfq", token]`, `retry: false`.
  - `useSaveDraft(token: string, legId: string) → UseMutationResult<unknown, PortalError, QuoteDraft>` — PATCH, invalidates `["ff-rfq", token]`.
  - `useSubmit(token: string, legId: string) → UseMutationResult<{ quoteId: string; status: string }, PortalError, void>` — POST `.../submit` with `{}`, invalidates `["ff-rfq", token]`.

- [ ] **Step 1: Write failing test** (hook-level, with a minimal QueryClient wrapper)

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { useFfRfq, useSaveDraft } from "./useFfPortal";

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useFfPortal", () => {
  it("useFfRfq fetches the scoped RFQ", async () => {
    vi.stubGlobal("fetch", mockFetch((url) =>
      url.endsWith("/api/ff/rfq/tok") ? { status: 200, body: { rfqNumber: "R-9", legs: [] } } : { status: 404 }));
    const { result } = renderHook(() => useFfRfq("tok"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.rfqNumber).toBe("R-9");
  });

  it("useFfRfq does not retry on 401 (surfaces immediately)", async () => {
    const fx = mockFetch(() => ({ status: 401, body: {} }));
    vi.stubGlobal("fetch", fx);
    const { result } = renderHook(() => useFfRfq("bad"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as { status: number }).status).toBe(401);
    expect(fx).toHaveBeenCalledTimes(1);
  });

  it("useSaveDraft PATCHes the draft", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    const { result } = renderHook(() => useSaveDraft("tok", "L1"), { wrapper: wrapper() });
    await result.current.mutateAsync({ legId: "L1" } as never);
    expect(fx).toHaveBeenCalledWith("/api/ff/rfq/tok/quotes/L1", expect.objectContaining({ method: "PATCH" }));
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
// useFfPortal.ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FfPortalRfqDto, QuoteDraft } from "@svyft/shared";
import { portalGet, portalPatch, portalPost } from "./portalClient";

export function useFfRfq(token: string) {
  return useQuery({
    queryKey: ["ff-rfq", token],
    queryFn: () => portalGet<FfPortalRfqDto>(`/api/ff/rfq/${token}`),
    retry: false,
  });
}

export function useSaveDraft(token: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draft: QuoteDraft) => portalPatch(`/api/ff/rfq/${token}/quotes/${legId}`, draft),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ff-rfq", token] }),
  });
}

export function useSubmit(token: string, legId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => portalPost<{ quoteId: string; status: string }>(`/api/ff/rfq/${token}/quotes/${legId}/submit`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ff-rfq", token] }),
  });
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): useFfRfq/useSaveDraft/useSubmit query hooks"`

---

## Task 4: `draftFromDto.ts` — build the initial `QuoteDraft`

**Files:**
- Create: `apps/web/src/features/ff-portal/draftFromDto.ts`
- Test: `apps/web/src/features/ff-portal/draftFromDto.test.ts`

**Interfaces:**
- Consumes: `FfPortalLegDto`, `FfPortalRfqDto`, `QuoteDraft`, `AIR_CHARGE_PRESETS`, `SEA_CHARGE_PRESETS`, enums (`@svyft/shared`); `toNumOrNull` (Task 1).
- Produces: `draftFromDto(leg: FfPortalLegDto, rfq: FfPortalRfqDto): QuoteDraft`.

**Mapping rules (verbatim from the DTO shapes):**
- If `leg.draft` is non-null, return it **with** `currency`/`quoteValidityUntil` overwritten from the RFQ top-level (page-level is source of truth), and `legId`/`mode` from the leg. Otherwise build fresh:
- `legId = leg.legId`, `mode = leg.mode`.
- `currency = rfq.currency`, `quoteValidityUntil = rfq.quoteValidityUntil`.
- `cargo` = one per `leg.manifest.cargo`: `{ cargoItemId, grossWtT: Number(grossWt)/1000, cbm: toNumOrNull(volumeCbm) ?? 0, isDangerous, freightDensity: <seededDensity by cargoItemId>?.freightDensity ?? null }`.
- `charges` = one per `leg.seededCharges`: `{ zone, presetKey, label, amount: null }` (no `note`). (Only present for Air/Sea; Road legs have `seededCharges: []`.)
- `trucking` = for Road legs, one per `leg.endpoints`: `{ legEndpointPointId: pointId, truckingType: "DEDICATED", basis: "PER_TRUCK", amount: null }`. Non-Road legs → `[]`.
- `warehouse` = one per `leg.endpoints` where `warehousePosition != null`: `{ warehousePointId: pointId, position: warehousePosition, label: <"Origin warehouse" | "Destination warehouse">, amount: null }`.
- `transit = { departureDate: null, arrivalDate: null }`.
- `dgSurchargeNote = null`, `termsConditions = null`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import type { FfPortalLegDto, FfPortalRfqDto } from "@svyft/shared";
import { draftFromDto } from "./draftFromDto";

const rfq = { currency: "USD", quoteValidityUntil: "2026-09-01T00:00:00.000Z" } as FfPortalRfqDto;

function airLeg(): FfPortalLegDto {
  return {
    legId: "L1", quoteId: "Q1", status: "RFQ_SENT", mode: "AIR",
    manifest: { cargo: [{ cargoItemId: "c1", grossWt: "1500", volumeCbm: "2.5", isDangerous: true }] } as never,
    endpoints: [{ pointId: "w1", type: "WAREHOUSE", name: "W", country: "IN", warehousePosition: "ORIGIN" }],
    seededCharges: [{ zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", isPreset: true, amount: null }],
    seededDensity: [{ cargoItemId: "c1", freightDensity: 167 }],
    draft: null,
  } as never;
}

describe("draftFromDto", () => {
  it("seeds cargo (kg→t), charges (amount null), density, and RFQ currency/validity", () => {
    const d = draftFromDto(airLeg(), rfq);
    expect(d.legId).toBe("L1");
    expect(d.currency).toBe("USD");
    expect(d.quoteValidityUntil).toBe("2026-09-01T00:00:00.000Z");
    expect(d.cargo[0]).toMatchObject({ cargoItemId: "c1", grossWtT: 1.5, cbm: 2.5, isDangerous: true, freightDensity: 167 });
    expect(d.charges[0]).toMatchObject({ presetKey: "AIR_MAIN_FREIGHT", amount: null });
    expect(d.warehouse[0]).toMatchObject({ warehousePointId: "w1", position: "ORIGIN" });
    expect(d.trucking).toEqual([]);
  });

  it("Road leg builds a trucking block per endpoint and no charges", () => {
    const leg = { ...airLeg(), mode: "ROAD", seededCharges: [],
      endpoints: [{ pointId: "p1", type: "PICKUP", name: "P", country: "IN", warehousePosition: null }] } as FfPortalLegDto;
    const d = draftFromDto(leg, rfq);
    expect(d.charges).toEqual([]);
    expect(d.trucking[0]).toMatchObject({ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: null });
  });

  it("prefers an existing draft but overwrites currency/validity from the RFQ", () => {
    const leg = { ...airLeg(), draft: { legId: "L1", currency: "EUR", quoteValidityUntil: "2020-01-01T00:00:00.000Z", cargo: [], charges: [], trucking: [], warehouse: [], transit: null, dgSurchargeNote: "x", termsConditions: null, mode: "AIR" } } as FfPortalLegDto;
    const d = draftFromDto(leg, rfq);
    expect(d.currency).toBe("USD");
    expect(d.quoteValidityUntil).toBe("2026-09-01T00:00:00.000Z");
    expect(d.dgSurchargeNote).toBe("x");
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
// draftFromDto.ts
import type { FfPortalLegDto, FfPortalRfqDto, QuoteDraft, QuoteDraftWarehouse } from "@svyft/shared";
import { toNumOrNull } from "./numeric";

function warehouseLabel(position: QuoteDraftWarehouse["position"]): string {
  return position === "ORIGIN" ? "Origin warehouse" : "Destination warehouse";
}

export function draftFromDto(leg: FfPortalLegDto, rfq: FfPortalRfqDto): QuoteDraft {
  if (leg.draft) {
    return { ...leg.draft, legId: leg.legId, mode: leg.mode, currency: rfq.currency, quoteValidityUntil: rfq.quoteValidityUntil };
  }
  const cargo = leg.manifest.cargo.map((c) => {
    const seed = leg.seededDensity.find((s) => s.cargoItemId === c.cargoItemId);
    return {
      cargoItemId: c.cargoItemId,
      grossWtT: (toNumOrNull(c.grossWt) ?? 0) / 1000,
      cbm: toNumOrNull(c.volumeCbm) ?? 0,
      isDangerous: c.isDangerous,
      freightDensity: seed?.freightDensity ?? null,
    };
  });
  const charges = leg.seededCharges.map((s) => ({ zone: s.zone, presetKey: s.presetKey, label: s.label, amount: null }));
  const trucking =
    leg.mode === "ROAD"
      ? leg.endpoints.map((e) => ({ legEndpointPointId: e.pointId, truckingType: "DEDICATED" as const, basis: "PER_TRUCK" as const, amount: null }))
      : [];
  const warehouse = leg.endpoints
    .filter((e) => e.warehousePosition != null)
    .map((e) => ({ warehousePointId: e.pointId, position: e.warehousePosition!, label: warehouseLabel(e.warehousePosition!), amount: null }));
  return {
    legId: leg.legId,
    mode: leg.mode,
    currency: rfq.currency,
    quoteValidityUntil: rfq.quoteValidityUntil,
    cargo,
    charges,
    trucking,
    warehouse,
    transit: { departureDate: null, arrivalDate: null },
    dgSurchargeNote: null,
    termsConditions: null,
  };
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): draftFromDto seeds QuoteDraft from leg + RFQ"`

---

## Task 5: `useCountdown.ts` — viewer-local deadline countdown

**Files:**
- Create: `apps/web/src/features/ff-portal/useCountdown.ts`
- Test: `apps/web/src/features/ff-portal/useCountdown.test.tsx`

**Interfaces:**
- Produces: `useCountdown(deadlineIso: string) → { text: string; tier: "calm" | "warning" | "urgent" | "expired"; expired: boolean }`.
  - `text`: `"2d 14h 03m"` (drops days when 0: `"14h 03m"`; under 1h: `"03m 12s"`). `expired` → `"Deadline passed"`.
  - `tier`: `≥24h → "calm"`, `≥12h → "warning"`, `>0 → "urgent"`, else `"expired"`.
  - Recomputes on a 1s interval (cheap; the display only shows minutes until the last hour). Uses `Date.now()`.

- [ ] **Step 1: Write failing test** (fake timers)

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCountdown } from "./useCountdown";

beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-08-01T00:00:00.000Z")));
afterEach(() => vi.useRealTimers());

describe("useCountdown", () => {
  it("tiers by remaining time", () => {
    expect(renderHook(() => useCountdown("2026-08-03T00:00:00.000Z")).result.current.tier).toBe("calm");   // 48h
    expect(renderHook(() => useCountdown("2026-08-01T18:00:00.000Z")).result.current.tier).toBe("warning"); // 18h
    expect(renderHook(() => useCountdown("2026-08-01T06:00:00.000Z")).result.current.tier).toBe("urgent");  // 6h
  });
  it("formats days/hours/minutes", () => {
    expect(renderHook(() => useCountdown("2026-08-03T14:03:00.000Z")).result.current.text).toBe("2d 14h 03m");
  });
  it("goes expired past the deadline", () => {
    const { result } = renderHook(() => useCountdown("2026-08-01T00:00:10.000Z"));
    expect(result.current.expired).toBe(false);
    act(() => { vi.advanceTimersByTime(11_000); });
    expect(result.current.expired).toBe(true);
    expect(result.current.text).toBe("Deadline passed");
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
// useCountdown.ts
import { useEffect, useState } from "react";

export type CountdownTier = "calm" | "warning" | "urgent" | "expired";
export interface Countdown { text: string; tier: CountdownTier; expired: boolean; }

function pad(n: number): string { return String(n).padStart(2, "0"); }

function compute(deadlineIso: string): Countdown {
  const ms = new Date(deadlineIso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return { text: "Deadline passed", tier: "expired", expired: true };
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const text = d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : h > 0 ? `${pad(h)}h ${pad(m)}m` : `${pad(m)}m ${pad(s)}s`;
  const hours = ms / 3_600_000;
  const tier: CountdownTier = hours >= 24 ? "calm" : hours >= 12 ? "warning" : "urgent";
  return { text, tier, expired: false };
}

export function useCountdown(deadlineIso: string): Countdown {
  const [state, setState] = useState(() => compute(deadlineIso));
  useEffect(() => {
    setState(compute(deadlineIso));
    const id = setInterval(() => setState(compute(deadlineIso)), 1000);
    return () => clearInterval(id);
  }, [deadlineIso]);
  return state;
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): viewer-local useCountdown with urgency tiers"`

---

## Task 6: `CargoManifestTable.tsx` — read-only manifest

**Files:**
- Create: `apps/web/src/features/ff-portal/CargoManifestTable.tsx`
- Test: `apps/web/src/features/ff-portal/CargoManifestTable.test.tsx`

**Interfaces:**
- Consumes: `ManifestSnapshotCargo[]` (`@svyft/shared`); `fmtDecimal`, `fmtCbm` (Task 1).
- Produces: `CargoManifestTable({ cargo: ManifestSnapshotCargo[] }): JSX.Element`.

**Design:** shadcn `Table`, wrapper `overflow-x-auto`. Columns: PO / Product / HS / Package / Qty / Dims (L×W×H) / Gross (kg) / CBM / DG. Numbers `font-mono tabular-nums`. DG rows show `Badge variant="warning"` "DG". Empty → a muted "No cargo on this leg." row.

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CargoManifestTable } from "./CargoManifestTable";

const cargo = [{ cargoItemId: "c1", poReference: "PO-1", productName: "Pumps", hsCode: "8413",
  packageType: "Crate", isDangerous: true, qty: 3, dimL: "1.2", dimW: "1.0", dimH: "0.8",
  netWt: "900", grossWt: "1500", volumeCbm: "2.5" }] as never;

describe("CargoManifestTable", () => {
  it("renders cargo with a DG badge and mono numbers", () => {
    render(<CargoManifestTable cargo={cargo} />);
    expect(screen.getByText("PO-1")).toBeInTheDocument();
    expect(screen.getByText("Pumps")).toBeInTheDocument();
    expect(screen.getByText("DG")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
  });
  it("shows an empty state", () => {
    render(<CargoManifestTable cargo={[]} />);
    expect(screen.getByText(/no cargo/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (follow this exact structure; render one `TableRow` per item)

```tsx
// CargoManifestTable.tsx
import type { ManifestSnapshotCargo } from "@svyft/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { fmtDecimal, fmtCbm } from "./format";

export function CargoManifestTable({ cargo }: { cargo: ManifestSnapshotCargo[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>PO / Ref</TableHead><TableHead>Product</TableHead><TableHead>HS</TableHead>
            <TableHead>Package</TableHead><TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Dims (m)</TableHead><TableHead className="text-right">Gross (kg)</TableHead>
            <TableHead className="text-right">CBM</TableHead><TableHead>DG</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cargo.length === 0 ? (
            <TableRow><TableCell colSpan={9} className="py-6 text-center text-muted-foreground">No cargo on this leg.</TableCell></TableRow>
          ) : cargo.map((c) => (
            <TableRow key={c.cargoItemId}>
              <TableCell className="font-mono">{c.poReference}</TableCell>
              <TableCell>{c.productName}</TableCell>
              <TableCell className="font-mono">{c.hsCode ?? "—"}</TableCell>
              <TableCell>{c.packageType}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{c.qty}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtDecimal(c.dimL,2)}×{fmtDecimal(c.dimW,2)}×{fmtDecimal(c.dimH,2)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtDecimal(c.grossWt,0)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtCbm(c.volumeCbm)}</TableCell>
              <TableCell>{c.isDangerous ? <Badge variant="warning">DG</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): read-only CargoManifestTable"`

---

## Task 7: `DensityChargeableGrid.tsx` — density → live chargeable weight

**Files:**
- Create: `apps/web/src/features/ff-portal/DensityChargeableGrid.tsx`
- Test: `apps/web/src/features/ff-portal/DensityChargeableGrid.test.tsx`

**Interfaces:**
- Consumes: `QuoteDraft` form context; `computeChargeableWeight` (`@svyft/shared`); `NumberField` (Task 1); `ManifestSnapshotCargo[]` for labels.
- Produces: `DensityChargeableGrid({ cargo }: { cargo: ManifestSnapshotCargo[] }): JSX.Element` — reads/writes `cargo.${i}.freightDensity` on the surrounding RHF `QuoteDraft` form via `useFormContext` + `useFieldArray({ name: "cargo" })`. Displays read-only gross(t)/CBM and a live chargeable-weight cell.

**Behavior:** one row per form `cargo` field. Editable: `freightDensity` (`NumberField`). Read-only: gross tonnes (`grossWtT`), CBM (`cbm`). Live cell = `freightDensity == null ? "—" : fmtWeight(computeChargeableWeight(grossWtT, cbm, freightDensity))`. Use `useWatch({ control, name: "cargo" })` for reactivity.

- [ ] **Step 1: Write failing test** (mount inside a real RHF form via a tiny harness)

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { DensityChargeableGrid } from "./DensityChargeableGrid";

const cargo = [{ cargoItemId: "c1", poReference: "PO-1", productName: "Pumps", packageType: "Crate",
  isDangerous: false, qty: 1, dimL: "1", dimW: "1", dimH: "1", grossWt: "1500", volumeCbm: "2.5", hsCode: null, netWt: null }] as never;

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
    cargo: [{ cargoItemId: "c1", grossWtT: 1.5, cbm: 2.5, isDangerous: false, freightDensity: null }],
    charges: [], trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><DensityChargeableGrid cargo={cargo} /></FormProvider>;
}

describe("DensityChargeableGrid", () => {
  it("recomputes chargeable weight live when density changes", async () => {
    render(<Harness />);
    expect(screen.getByText("—")).toBeInTheDocument();                 // no density yet
    await userEvent.type(screen.getByLabelText(/density.*PO-1/i), "300"); // volumetric = 2.5*300/1000 = 0.75t < 1.5t gross
    expect(await screen.findByText("1.500")).toBeInTheDocument();       // max(1.5, 0.75)
    await userEvent.clear(screen.getByLabelText(/density.*PO-1/i));
    await userEvent.type(screen.getByLabelText(/density.*PO-1/i), "1000"); // volumetric = 2.5t > 1.5t
    expect(await screen.findByText("2.500")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```tsx
// DensityChargeableGrid.tsx
import { useFormContext, useWatch } from "react-hook-form";
import type { QuoteDraft, ManifestSnapshotCargo } from "@svyft/shared";
import { computeChargeableWeight } from "@svyft/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NumberField } from "./NumberField";
import { fmtWeight } from "./format";

export function DensityChargeableGrid({ cargo }: { cargo: ManifestSnapshotCargo[] }) {
  const { control, setValue } = useFormContext<QuoteDraft>();
  const rows = useWatch({ control, name: "cargo" });
  const poFor = (id: string) => cargo.find((c) => c.cargoItemId === id)?.poReference ?? id;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>PO / Ref</TableHead><TableHead className="text-right">Gross (t)</TableHead>
            <TableHead className="text-right">CBM</TableHead><TableHead className="text-right">Density (kg/CBM)</TableHead>
            <TableHead className="text-right">Chargeable (t)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => {
            const cw = r.freightDensity == null ? null : computeChargeableWeight(r.grossWtT, r.cbm, r.freightDensity);
            return (
              <TableRow key={r.cargoItemId}>
                <TableCell className="font-mono">{poFor(r.cargoItemId)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums bg-muted/40">{fmtWeight(r.grossWtT)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums bg-muted/40">{r.cbm.toFixed(4)}</TableCell>
                <TableCell className="text-right">
                  <NumberField aria-label={`Density for ${poFor(r.cargoItemId)}`} className="w-28 text-right"
                    value={r.freightDensity}
                    onChange={(v) => setValue(`cargo.${i}.freightDensity`, v, { shouldDirty: true })} />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums font-medium">{cw == null ? "—" : fmtWeight(cw)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): DensityChargeableGrid with live chargeable weight"`

---

## Task 8: `ChargeZonePanel.tsx` — Air/Sea zone pricing

**Files:**
- Create: `apps/web/src/features/ff-portal/ChargeZonePanel.tsx`
- Test: `apps/web/src/features/ff-portal/ChargeZonePanel.test.tsx`

**Interfaces:**
- Consumes: `QuoteDraft` form context (`useFieldArray({ name: "charges" })`); `computeQuoteTotals`, `ChargeZone` (`@svyft/shared`); `NumberField`, `fmtAmount` (Task 1).
- Produces: `ChargeZonePanel(): JSX.Element` (reads everything from form context).

**Behavior:** group `charges` fields by `zone` in fixed order ORIGIN → MAIN_FREIGHT → DESTINATION, with headings "Origin charges" / "Main freight" / "Destination charges". Each row: read-only `label` + `NumberField` bound to `charges.${idx}.amount` + a `Textarea`/`Input` note bound to `charges.${idx}.note`. Custom lines: a **[+ Add line]** ghost `Button` per zone appends `{ zone, presetKey: null, label: "Custom charge", amount: null }` (label becomes an editable `Input` when `presetKey == null`). Per-zone subtotal (live) via `useWatch` + `computeQuoteTotals`. Keep the index mapping correct: iterate the full field array, filter by zone, but bind by the field's absolute index.

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { ChargeZonePanel } from "./ChargeZonePanel";

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [],
    charges: [
      { zone: "ORIGIN", presetKey: "AIR_ORIGIN_THC", label: "Origin THC", amount: null },
      { zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", amount: null },
    ],
    trucking: [], warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><ChargeZonePanel /></FormProvider>;
}

describe("ChargeZonePanel", () => {
  it("shows preset lines grouped by zone and a live origin subtotal", async () => {
    render(<Harness />);
    expect(screen.getByText("Origin THC")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/amount.*Origin THC/i), "500");
    const origin = screen.getByTestId("zone-subtotal-ORIGIN");
    expect(within(origin).getByText("500.00")).toBeInTheDocument();
  });
  it("adds a custom line to a zone", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /add line.*origin/i }));
    expect(screen.getAllByDisplayValue("Custom charge").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — key structure (bind by absolute field index; show `label` as text when `presetKey != null`, else an editable `Input`):

```tsx
// ChargeZonePanel.tsx
import { useFormContext, useFieldArray, useWatch } from "react-hook-form";
import type { QuoteDraft, ChargeZone } from "@svyft/shared";
import { computeQuoteTotals } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "./NumberField";
import { fmtAmount } from "./format";

const ZONES: { key: ChargeZone; title: string }[] = [
  { key: "ORIGIN", title: "Origin charges" },
  { key: "MAIN_FREIGHT", title: "Main freight" },
  { key: "DESTINATION", title: "Destination charges" },
];

export function ChargeZonePanel() {
  const { control, register, setValue } = useFormContext<QuoteDraft>();
  const { fields, append } = useFieldArray({ control, name: "charges" });
  const draft = useWatch({ control });
  const totals = computeQuoteTotals(draft as QuoteDraft);
  const subtotal = (z: ChargeZone) => z === "ORIGIN" ? totals.zoneSubtotals.origin : z === "MAIN_FREIGHT" ? totals.zoneSubtotals.mainFreight : totals.zoneSubtotals.destination;

  return (
    <div className="space-y-6">
      {ZONES.map(({ key, title }) => {
        const rows = fields.map((f, idx) => ({ f, idx })).filter(({ idx }) => (draft.charges?.[idx]?.zone ?? (f as { zone: ChargeZone }).zone) === key);
        return (
          <div key={key} className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
              <div data-testid={`zone-subtotal-${key}`} className="font-mono tabular-nums text-sm">{fmtAmount(subtotal(key))}</div>
            </div>
            <div className="space-y-2">
              {rows.map(({ f, idx }) => {
                const isPreset = (draft.charges?.[idx]?.presetKey ?? null) != null;
                const label = draft.charges?.[idx]?.label ?? "";
                return (
                  <div key={f.id} className="grid grid-cols-[1fr,10rem,1fr] items-center gap-2">
                    {isPreset
                      ? <span className="text-sm">{label}</span>
                      : <Input aria-label="Custom line label" {...register(`charges.${idx}.label` as const)} />}
                    <NumberField aria-label={`Amount for ${label}`} value={draft.charges?.[idx]?.amount ?? null}
                      onChange={(v) => setValue(`charges.${idx}.amount`, v, { shouldDirty: true })} />
                    <Input aria-label={`Note for ${label}`} placeholder="Note (optional)" {...register(`charges.${idx}.note` as const)} />
                  </div>
                );
              })}
              <Button type="button" variant="ghost" size="sm"
                onClick={() => append({ zone: key, presetKey: null, label: "Custom charge", amount: null })}>
                + Add line ({title})
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): ChargeZonePanel with live zone subtotals + custom lines"`

---

## Task 9: `TruckingBlocks.tsx` — Road pricing (B8: no add-line)

**Files:**
- Create: `apps/web/src/features/ff-portal/TruckingBlocks.tsx`
- Test: `apps/web/src/features/ff-portal/TruckingBlocks.test.tsx`

**Interfaces:**
- Consumes: `QuoteDraft` form context (`useFieldArray({ name: "trucking" })`); `TruckingType`, `TruckingBasis` (`@svyft/shared`); `NumberField`; `FfPortalEndpoint[]` for endpoint names.
- Produces: `TruckingBlocks({ endpoints }: { endpoints: FfPortalEndpoint[] }): JSX.Element`.

**Behavior:** one block per `trucking` field (one per endpoint). Each: endpoint name (from `endpoints` by `legEndpointPointId`), a `Select` for `truckingType` (DEDICATED/GROUPAGE), a `Select` for `basis` (PER_TRUCK/PER_CBM/PER_TON/FIXED), a `NumberField` amount, and a `Textarea` "Remarks". **NO [+ Add Charge] button** (B8 — one charge + Remarks per block). Use shadcn `Select` (Trigger/Value/Content/Item) bound via `setValue`.

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft, FfPortalEndpoint } from "@svyft/shared";
import { TruckingBlocks } from "./TruckingBlocks";

const endpoints: FfPortalEndpoint[] = [{ pointId: "p1", type: "PICKUP", name: "Mumbai DC", country: "IN", warehousePosition: null }];
function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "ROAD", currency: "USD", quoteValidityUntil: null, cargo: [], charges: [],
    trucking: [{ legEndpointPointId: "p1", truckingType: "DEDICATED", basis: "PER_TRUCK", amount: null }],
    warehouse: [], transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><TruckingBlocks endpoints={endpoints} /></FormProvider>;
}

describe("TruckingBlocks", () => {
  it("renders one block per endpoint with type/basis/amount/remarks and NO add button", () => {
    render(<Harness />);
    expect(screen.getByText("Mumbai DC")).toBeInTheDocument();
    expect(screen.getByLabelText(/amount.*Mumbai DC/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remarks.*Mumbai DC/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add charge/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (Select options: `TruckingType` = DEDICATED, GROUPAGE; `TruckingBasis` = PER_TRUCK, PER_CBM, PER_TON, FIXED). Bind each Select's `value` from `useWatch` and `onValueChange` → `setValue`. Endpoint label via `endpoints.find(...)?.name ?? pointId`. Remarks via `register('trucking.${i}.remarks')`. Amount via `NumberField` + `setValue`. No append/Button-add.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): TruckingBlocks (B8 one charge + remarks, no add-line)"`

---

## Task 10: `WarehouseStaging.tsx` — warehouse in/out pricing

**Files:**
- Create: `apps/web/src/features/ff-portal/WarehouseStaging.tsx`
- Test: `apps/web/src/features/ff-portal/WarehouseStaging.test.tsx`

**Interfaces:**
- Consumes: `QuoteDraft` form context (`useFieldArray({ name: "warehouse" })`); `NumberField`.
- Produces: `WarehouseStaging(): JSX.Element` (reads warehouse rows from context). Renders nothing (`null`) when there are no warehouse rows.

**Behavior:** one card-row per `warehouse` field: the position `label` (server-derived, e.g. "Origin warehouse"), a `NumberField` amount bound to `warehouse.${i}.amount`, and an optional `Input` "Cargo acceptance window" bound to `warehouse.${i}.cargoAcceptanceWindow`. If `fields.length === 0` return `null`.

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { WarehouseStaging } from "./WarehouseStaging";

function Harness({ wh }: { wh: QuoteDraft["warehouse"] }) {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [], charges: [], trucking: [],
    warehouse: wh, transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><WarehouseStaging /></FormProvider>;
}

describe("WarehouseStaging", () => {
  it("renders an amount + acceptance window per warehouse endpoint", () => {
    render(<Harness wh={[{ warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: null }]} />);
    expect(screen.getByText("Origin warehouse")).toBeInTheDocument();
    expect(screen.getByLabelText(/amount.*Origin warehouse/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/acceptance window.*Origin warehouse/i)).toBeInTheDocument();
  });
  it("renders nothing with no warehouse rows", () => {
    const { container } = render(<Harness wh={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (follow the DensityChargeableGrid binding pattern; `label` shown as text; `amount` via `NumberField`+`setValue`; window via `register('warehouse.${i}.cargoAcceptanceWindow')`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): WarehouseStaging in/out pricing"`

---

## Task 11: `TransitPlanForm.tsx` — transit dates + carrier fields

**Files:**
- Create: `apps/web/src/features/ff-portal/TransitPlanForm.tsx`
- Test: `apps/web/src/features/ff-portal/TransitPlanForm.test.tsx`

**Interfaces:**
- Consumes: `QuoteDraft` form context (`transit.*` fields); `toDatetimeLocal`/`fromDatetimeLocal`, `NumberField` (Task 1).
- Produces: `TransitPlanForm(): JSX.Element`.

**Behavior:** `datetime-local` inputs for `transit.departureDate` and `transit.arrivalDate` (store ISO — read via `toDatetimeLocal(iso)`, write via `fromDatetimeLocal(local)`). Optional: `carrier` (`Input`), `flightVoyageNo` (`Input`), `carrierSurcharge` (`NumberField`), `guaranteedTransitDays` (`NumberField`). Guard `transit` possibly-null: initialize `{ departureDate: null, arrivalDate: null }` via `setValue` if `draft.transit == null` on first render, or bind with `?? null`.

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider, useWatch } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { TransitPlanForm } from "./TransitPlanForm";

function Harness() {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [], charges: [], trucking: [], warehouse: [],
    transit: { departureDate: null, arrivalDate: null }, dgSurchargeNote: null, termsConditions: null } });
  const dep = useWatch({ control: form.control, name: "transit.departureDate" });
  return <FormProvider {...form}><TransitPlanForm /><output data-testid="dep">{dep ?? ""}</output></FormProvider>;
}

describe("TransitPlanForm", () => {
  it("writes an ISO instant when a departure datetime is chosen", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText(/departure/i), "2026-08-05T10:00");
    expect(screen.getByTestId("dep").textContent).toMatch(/^2026-08-05T/);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (each date input: `value={toDatetimeLocal(watchedIso)}` `onChange={e => setValue("transit.departureDate", fromDatetimeLocal(e.target.value), { shouldDirty: true })}`; type="datetime-local").
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): TransitPlanForm (viewer-local datetime → ISO)"`

---

## Task 12: `QuoteSummary.tsx` — live totals

**Files:**
- Create: `apps/web/src/features/ff-portal/QuoteSummary.tsx`
- Test: `apps/web/src/features/ff-portal/QuoteSummary.test.tsx`

**Interfaces:**
- Consumes: `QuoteTotals`, `computeQuoteTotals` (`@svyft/shared`); `fmtAmount`, `fmtWeight` (Task 1).
- Produces: `QuoteSummary({ draft, currency }: { draft: QuoteDraft; currency: string | null }): JSX.Element` — pure/presentational; the caller passes the live-watched draft. (Kept prop-driven so it's trivially testable and reused in the submitted read-only summary.)

**Behavior:** compute `computeQuoteTotals(draft)`, render a definition list: Origin / Main freight / Destination subtotals (Air/Sea only — show only if `draft.charges.length`), Trucking subtotal (if `draft.trucking.length`), Warehouse subtotal (if `draft.warehouse.length`), Total chargeable weight (t), and a prominent **Grand total** with the `currency` code. All figures `font-mono tabular-nums`; Grand total label `font-display`.

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QuoteDraft } from "@svyft/shared";
import { QuoteSummary } from "./QuoteSummary";

const draft = {
  legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null,
  cargo: [{ cargoItemId: "c1", grossWtT: 1.5, cbm: 2.5, isDangerous: false, freightDensity: 1000 }],
  charges: [{ zone: "ORIGIN", presetKey: "x", label: "THC", amount: 500 }, { zone: "MAIN_FREIGHT", presetKey: "y", label: "Freight", amount: 2000 }],
  trucking: [], warehouse: [{ warehousePointId: "w1", position: "ORIGIN", label: "Origin warehouse", amount: 300 }],
  transit: null, dgSurchargeNote: null, termsConditions: null } as QuoteDraft;

describe("QuoteSummary", () => {
  it("shows subtotals, chargeable weight and grand total with currency", () => {
    render(<QuoteSummary draft={draft} currency="USD" />);
    expect(screen.getByTestId("grand-total")).toHaveTextContent("2,800.00");   // 500+2000+300
    expect(screen.getByTestId("grand-total")).toHaveTextContent("USD");
    expect(screen.getByTestId("total-chargeable")).toHaveTextContent("2.500"); // max(1.5, 2.5)
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (use `data-testid="grand-total"` / `"total-chargeable"`; conditional rows as specified).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): QuoteSummary live totals"`

---

## Task 13: `findingNav.ts` + `QuoteFindingsSummary.tsx` — portal blocking list

**Files:**
- Create: `apps/web/src/features/ff-portal/findingNav.ts`
- Create: `apps/web/src/features/ff-portal/QuoteFindingsSummary.tsx`
- Test: `apps/web/src/features/ff-portal/findingNav.test.ts`
- Test: `apps/web/src/features/ff-portal/QuoteFindingsSummary.test.tsx`

**Rationale:** `@/components/ValidationSummary` is hard-wired to SB3 wizard tabs (`"client"|"shipment"|"cargo"|"legs"|"notes"` with labels like "Client & Query"), driven by `findingTabKey`. Those are meaningless on a public FF quote form. This task builds a portal-native equivalent that reuses the *visual* style (the `role="alert"` destructive card, grouped clickable messages) but maps `validateQuote` findings (Q1–Q8) to **portal sections**.

**Interfaces:**
- Produces:
  - `type PortalSection = "density" | "charges" | "warehouse" | "transit" | "rfq" | "terms"`
  - `PORTAL_SECTION_LABEL: Record<PortalSection, string>` and `PORTAL_SECTION_ORDER: PortalSection[]`
  - `findingSection(f: Finding): PortalSection` — mapping (from the exact Q1–Q8 scopes):
    - `scope.type === "cargo"` → `"density"` (Q2)
    - `scope.type === "field"` && id `currency`|`quoteValidityUntil` → `"rfq"` (Q3/Q4)
    - `scope.type === "field"` && id `dgSurchargeNote` → `"terms"` (Q5)
    - `scope.type === "field"` && id `departureDate`|`arrivalDate` → `"transit"` (Q6)
    - `scope.type === "leg"` && `rule === "Q8"` → `"warehouse"`
    - `scope.type === "leg"` (Q1 / Q7 and any other) → `"charges"`
    - default → `"charges"`
  - `sectionAnchorId(legId: string, section: PortalSection): string` → `\`leg-${legId}-${section}\`` (LegSection renders matching `id=`s so navigation can `scrollIntoView`).
  - `QuoteFindingsSummary({ findings, legId, onNavigate }: { findings: Finding[]; legId: string; onNavigate: (section: PortalSection) => void }): JSX.Element | null` — filters to blocking, dedupes (reuse `dedupeFindings` from `@svyft/shared`), groups by `findingSection`, renders grouped clickable messages. Returns `null` when no blocking findings.

- [ ] **Step 1: Write failing tests**

```ts
// findingNav.test.ts
import { describe, it, expect } from "vitest";
import type { Finding } from "@svyft/shared";
import { findingSection } from "./findingNav";
const f = (rule: string, scope: Finding["scope"]): Finding => ({ rule, severity: "blocking", scope, message: "m" });

describe("findingSection", () => {
  it("maps Q1–Q8 to portal sections", () => {
    expect(findingSection(f("Q2", { type: "cargo", id: "c1" }))).toBe("density");
    expect(findingSection(f("Q4", { type: "field", id: "currency" }))).toBe("rfq");
    expect(findingSection(f("Q3", { type: "field", id: "quoteValidityUntil" }))).toBe("rfq");
    expect(findingSection(f("Q5", { type: "field", id: "dgSurchargeNote" }))).toBe("terms");
    expect(findingSection(f("Q6", { type: "field", id: "arrivalDate" }))).toBe("transit");
    expect(findingSection(f("Q8", { type: "leg", id: "L1" }))).toBe("warehouse");
    expect(findingSection(f("Q1", { type: "leg", id: "L1" }))).toBe("charges");
  });
});
```

```tsx
// QuoteFindingsSummary.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding } from "@svyft/shared";
import { QuoteFindingsSummary } from "./QuoteFindingsSummary";

const findings: Finding[] = [
  { rule: "Q4", severity: "blocking", scope: { type: "field", id: "currency" }, message: "Currency is required" },
  { rule: "Q2", severity: "blocking", scope: { type: "cargo", id: "c1" }, message: "Freight density is required for every cargo row" },
];

describe("QuoteFindingsSummary", () => {
  it("renders blocking findings and calls onNavigate on click", async () => {
    const onNavigate = vi.fn();
    render(<QuoteFindingsSummary findings={findings} legId="L1" onNavigate={onNavigate} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Currency is required"));
    expect(onNavigate).toHaveBeenCalledWith("rfq");
  });
  it("returns null with no blocking findings", () => {
    const { container } = render(<QuoteFindingsSummary findings={[]} legId="L1" onNavigate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `findingNav.ts` (the mapping above; labels: density "Density & chargeable weight", charges "Charges", warehouse "Warehousing", transit "Transit plan", rfq "Currency & validity", terms "Terms & DG note") and `QuoteFindingsSummary.tsx` mirroring `ValidationSummary`'s markup (`role="alert" className="space-y-3 rounded-md border border-destructive/30 bg-destructive/10 p-4"`, grouped `button`s calling `onNavigate(section)`), using `dedupeFindings` + `findingSection`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): section-aware QuoteFindingsSummary (portal ValidationSummary)"`

---

## Task 14: `SubmissionBar.tsx` — DG note, T&C, Save/Submit controls

**Files:**
- Create: `apps/web/src/features/ff-portal/SubmissionBar.tsx`
- Test: `apps/web/src/features/ff-portal/SubmissionBar.test.tsx`

**Interfaces:**
- Consumes: `QuoteDraft` form context (for `dgSurchargeNote`, `termsConditions`); shadcn `Textarea`, `Checkbox`, `Button`.
- Produces: `SubmissionBar(props): JSX.Element` where
```ts
interface SubmissionBarProps {
  showDgNote: boolean;                 // true if any cargo isDangerous
  currency: string | null;
  grandTotal: number;                  // for the sticky total figure
  saving: boolean; submitting: boolean; savedAt: number | null;
  disabled: boolean;                   // deadline passed / not RFQ_SENT
  onSaveDraft: () => void; onSubmit: () => void;
}
```
Presentational only — the save/submit *flow* lives in `LegSection` (Task 15). Renders: DG surcharge note `Textarea` bound to `dgSurchargeNote` (only when `showDgNote`), a T&C `Checkbox` bound to `termsConditions` (checked ⇢ store the acceptance text, unchecked ⇢ `null`), the sticky Grand total, **Save draft** (`variant="outline"`, shows "Saved ✓" when `savedAt` and not dirty), **Submit quote** (`variant="default"`). Buttons disabled per `disabled`/`saving`/`submitting`.

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import type { QuoteDraft } from "@svyft/shared";
import { SubmissionBar } from "./SubmissionBar";

function Harness(props: Partial<React.ComponentProps<typeof SubmissionBar>>) {
  const form = useForm<QuoteDraft>({ defaultValues: {
    legId: "L1", mode: "AIR", currency: "USD", quoteValidityUntil: null, cargo: [], charges: [], trucking: [], warehouse: [],
    transit: null, dgSurchargeNote: null, termsConditions: null } });
  return <FormProvider {...form}><SubmissionBar showDgNote={false} currency="USD" grandTotal={2800}
    saving={false} submitting={false} savedAt={null} disabled={false}
    onSaveDraft={() => {}} onSubmit={() => {}} {...props} /></FormProvider>;
}

describe("SubmissionBar", () => {
  it("shows the grand total and fires callbacks", async () => {
    const onSaveDraft = vi.fn(); const onSubmit = vi.fn();
    render(<Harness onSaveDraft={onSaveDraft} onSubmit={onSubmit} />);
    expect(screen.getByText("2,800.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));
    expect(onSaveDraft).toHaveBeenCalled(); expect(onSubmit).toHaveBeenCalled();
  });
  it("shows the DG note field only when required", () => {
    const { rerender } = render(<Harness showDgNote={false} />);
    expect(screen.queryByLabelText(/dg surcharge note/i)).toBeNull();
    rerender(<Harness showDgNote={true} />);
    expect(screen.getByLabelText(/dg surcharge note/i)).toBeInTheDocument();
  });
  it("disables actions when disabled", () => {
    render(<Harness disabled={true} />);
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (T&C checkbox: `onCheckedChange={(c) => setValue("termsConditions", c ? "Accepted" : null)}`, checked = `!!watch("termsConditions")`; DG note `Textarea` via `register("dgSurchargeNote")` with `aria-label="DG surcharge note"`; total `font-mono tabular-nums` + currency).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): SubmissionBar controls (DG note, T&C, save/submit)"`

---

## Task 15: `LegSection.tsx` — per-leg form + compose + save/submit flow

**Files:**
- Create: `apps/web/src/features/ff-portal/LegSection.tsx`
- Test: `apps/web/src/features/ff-portal/LegSection.test.tsx`

**Interfaces:**
- Consumes: `draftFromDto` (T4), all leaf components (T6–T14), `useSaveDraft`/`useSubmit` (T3), `validateQuote`/`computeQuoteTotals` (`@svyft/shared`), `findingSection`/`sectionAnchorId` (T13), `quoteDraftSchema` (`@svyft/shared`), `zodResolver`.
- Produces:
```ts
interface LegSectionProps {
  token: string;
  rfq: FfPortalRfqDto;                 // for deadline + top-level currency/validity
  leg: FfPortalLegDto;
  currency: string | null;             // page-level (source of truth)
  quoteValidityUntil: string | null;   // page-level (source of truth)
  readOnly: boolean;                    // deadline passed OR leg not RFQ_SENT
}
```

**Behavior:**
1. `const form = useForm<QuoteDraft>({ resolver: zodResolver(quoteDraftSchema), defaultValues: draftFromDto(leg, rfq) })`. Wrap children in `<FormProvider {...form}>`.
2. **Status branch:** `leg.status === "QUOTED"` → render the **already-submitted read-only summary** (`AlreadySubmittedSummary` from T17 with a computed `QuoteSummary`), not the editable form. `leg.status !== "RFQ_SENT"` (other) → read-only manifest + a muted "This leg is not open for quoting." Otherwise render the editable form.
3. **Live draft:** `const watched = useWatch({ control: form.control })`; `const draft = useMemo(() => ({ ...watched, currency, quoteValidityUntil }), [watched, currency, quoteValidityUntil])`. Feeds `QuoteSummary` and the live findings.
4. **Findings state:** `const [attempted, setAttempted] = useState(false)`. `const findings = attempted ? validateQuote(draft as QuoteDraft, rfq.submissionDeadline, new Date().toISOString()) : []`. Render `<QuoteFindingsSummary findings={findings} legId={leg.legId} onNavigate={(s) => document.getElementById(sectionAnchorId(leg.legId, s))?.scrollIntoView({ behavior: "smooth", block: "center" })} />` above the SubmissionBar.
5. Wrap each section in a `<section id={sectionAnchorId(leg.legId, s)}>` for anchor navigation (density/charges|trucking/warehouse/transit; rfq lives in PortalShell so 'rfq' nav scrolls to the top form — pass an `onNavigateRfq` up, OR give the shared bar a stable DOM id `rfq-fields` and scroll to it here).
6. **`buildDraft()`** = `{ ...form.getValues(), currency, quoteValidityUntil }`.
7. **Save draft:** `const saved = useSaveDraft(token, leg.legId)`; `onSaveDraft = () => saved.mutate(buildDraft(), { onSuccess: () => setSavedAt(Date.now()) })`. No validation.
8. **Submit:** `onSubmit = async () => { setAttempted(true); const draft = buildDraft(); const f = validateQuote(draft, rfq.submissionDeadline, new Date().toISOString()); if (f.length) return;  await saved.mutateAsync(draft); submit.mutate(); }` where `const submit = useSubmit(token, leg.legId)`. On `submit` success the query invalidates → the leg re-renders as QUOTED. On `PortalError`: `422` → set findings from `err.findings` (surface + `setAttempted(true)`); `409` → the invalidation/refetch shows the already-submitted state.
9. Mode pricing: `leg.mode === "ROAD"` → `<TruckingBlocks endpoints={leg.endpoints} />`; `AIR`/`SEA` → `<ChargeZonePanel />`.
10. `showDgNote = draft.cargo.some((c) => c.isDangerous)`; pass `grandTotal = computeQuoteTotals(draft).grandTotal`.

- [ ] **Step 1: Write failing test** — cover: editable render; submit-with-invalid shows findings and does NOT call the network submit; submit-with-valid calls PATCH then POST submit.

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { LegSection } from "./LegSection";
import type { FfPortalLegDto, FfPortalRfqDto } from "@svyft/shared";

afterEach(() => vi.unstubAllGlobals());
const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
};
const rfq = { rfqNumber: "R-1", incoterms: "FOB", submissionDeadline: "2999-01-01T00:00:00.000Z",
  currency: "USD", quoteValidityUntil: "2999-02-01T00:00:00.000Z", freightForwarder: { companyName: "Acme" }, legs: [] } as FfPortalRfqDto;
const leg = { legId: "L1", quoteId: "Q1", status: "RFQ_SENT", mode: "AIR",
  manifest: { cargo: [{ cargoItemId: "c1", poReference: "PO-1", productName: "P", packageType: "Box", isDangerous: false, qty: 1, dimL: "1", dimW: "1", dimH: "1", grossWt: "1000", volumeCbm: "1", hsCode: null, netWt: null }] },
  endpoints: [], seededCharges: [{ zone: "MAIN_FREIGHT", presetKey: "AIR_MAIN_FREIGHT", label: "Air Freight", isPreset: true, amount: null }],
  seededDensity: [{ cargoItemId: "c1", freightDensity: 167 }], draft: null } as unknown as FfPortalLegDto;

describe("LegSection submit gate", () => {
  it("blocks submit on client findings and does not POST", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    render(wrap(<LegSection token="tok" rfq={rfq} leg={leg} currency="USD" quoteValidityUntil={rfq.quoteValidityUntil} readOnly={false} />));
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();            // findings shown (charges unpriced etc.)
    expect(fx).not.toHaveBeenCalledWith(expect.stringContaining("/submit"), expect.anything());
  });
});
```

(The reviewer/implementer should add a positive-path test that fills the required fields — density already seeded, price the one preset charge, set transit dates — and asserts a PATCH then a POST to `/submit`. Because that requires driving many inputs, the authoritative happy-path assertion lives in the Task 19 integration test; keep this task's test focused on the block-on-findings gate.)

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** per the Behavior spec. Compose in this order inside the editable form: `CargoManifestTable` → `<section id={sectionAnchorId(legId,"density")}><DensityChargeableGrid cargo={leg.manifest.cargo} /></section>` → mode pricing section (`id=...charges`) → `<section id=...warehouse><WarehouseStaging/></section>` → `<section id=...transit><TransitPlanForm/></section>` → `<QuoteSummary draft={draft} currency={currency} />` → `<QuoteFindingsSummary .../>` → `<SubmissionBar .../>`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): LegSection form + client-validated save/submit flow"`

---

## Task 16: `PortalShell.tsx` — external header + RFQ-level fields

**Files:**
- Create: `apps/web/src/features/ff-portal/PortalShell.tsx`
- Test: `apps/web/src/features/ff-portal/PortalShell.test.tsx`

**Interfaces:**
- Consumes: `useCountdown` (T5); shadcn `Card`, `Select`, `Input`, `Label`, `Badge`.
- Produces:
```ts
interface PortalShellProps {
  rfq: FfPortalRfqDto;
  currency: string | null; onCurrencyChange: (v: string) => void;
  quoteValidityUntil: string | null; onValidityChange: (iso: string | null) => void;
  children: ReactNode;               // the leg sections
}
```

**Behavior:** the trust band header (wordmark, "Request for quote" eyebrow, `freightForwarder.companyName` as "Prepared for {name}", `rfqNumber` in mono, incoterms `Badge`, and the countdown chip from `useCountdown(rfq.submissionDeadline)` colored by `tier`). Below the header, a `Card id="rfq-fields"` with the **RFQ-level** Currency `Select` (options: at least USD/EUR/GBP/INR/AED — pre-filled from `currency`) and **Quote validity until** date input (`type="date"`; value from `quoteValidityUntil` sliced to `YYYY-MM-DD`, onChange → ISO at midnight local or `null`). Then `{children}` in a `max-w-5xl` column. Footer "Svyft Logistics · secure RFQ link".

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PortalShell } from "./PortalShell";
import type { FfPortalRfqDto } from "@svyft/shared";

beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-08-01T00:00:00.000Z")));
afterEach(() => vi.useRealTimers());
const rfq = { rfqNumber: "R-42", incoterms: "FOB", submissionDeadline: "2026-08-03T00:00:00.000Z",
  currency: "USD", quoteValidityUntil: "2026-09-01T00:00:00.000Z", freightForwarder: { companyName: "Acme Freight" }, legs: [] } as FfPortalRfqDto;

describe("PortalShell", () => {
  it("renders company, RFQ number, incoterms and a countdown", () => {
    render(<PortalShell rfq={rfq} currency="USD" onCurrencyChange={() => {}} quoteValidityUntil={rfq.quoteValidityUntil} onValidityChange={() => {}}>x</PortalShell>);
    expect(screen.getByText(/Acme Freight/)).toBeInTheDocument();
    expect(screen.getByText("R-42")).toBeInTheDocument();
    expect(screen.getByText("FOB")).toBeInTheDocument();
    expect(screen.getByText("2d 00h 00m")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → FAIL.** (Note: mock ResizeObserver already handled by `src/test/setup.ts`.)
- [ ] **Step 3: Implement** per Behavior + Design Direction. Countdown chip classes by `tier`: calm `text-muted-foreground bg-muted`, warning `text-warning bg-warning/10`, urgent/expired `text-destructive bg-destructive/10`; all `font-mono tabular-nums rounded-md px-2.5 py-1 text-sm`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): PortalShell external header + RFQ-level currency/validity"`

---

## Task 17: `terminalStates.tsx` — invalid / expired / already-submitted

**Files:**
- Create: `apps/web/src/features/ff-portal/terminalStates.tsx`
- Test: `apps/web/src/features/ff-portal/terminalStates.test.tsx`

**Interfaces:**
- Produces:
  - `InvalidTokenCard(): JSX.Element` — centered `Card`: "This RFQ link is invalid or has expired." + a line "If you believe this is a mistake, contact your Svyft Logistics representative." No retry button.
  - `ExpiredBanner(): JSX.Element` — a `role="status"` destructive banner: "The submission deadline has passed — this RFQ can no longer be submitted."
  - `AlreadySubmittedSummary({ leg, rfq }: { leg: FfPortalLegDto; rfq: FfPortalRfqDto }): JSX.Element` — a `success`-badged read-only card ("Quote submitted") rendering `<CargoManifestTable>` + `<QuoteSummary draft={leg.draft ?? draftFromDto(leg, rfq)} currency={rfq.currency} />`.

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvalidTokenCard, ExpiredBanner } from "./terminalStates";

describe("terminalStates", () => {
  it("invalid token card has no retry", () => {
    render(<InvalidTokenCard />);
    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry|try again/i })).toBeNull();
  });
  it("expired banner announces the passed deadline", () => {
    render(<ExpiredBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/deadline has passed/i);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (also add an `AlreadySubmittedSummary` test asserting "Quote submitted" + a grand total renders).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): terminal state cards (invalid/expired/submitted)"`

---

## Task 18: `FfPortalPage.tsx` + `usePortalHead.ts` + route wiring

**Files:**
- Create: `apps/web/src/features/ff-portal/FfPortalPage.tsx`
- Create: `apps/web/src/features/ff-portal/usePortalHead.ts`
- Modify: `apps/web/src/App.tsx` (add the route outside `<Protected>`)
- Test: `apps/web/src/features/ff-portal/FfPortalPage.test.tsx`
- Test: `apps/web/src/features/ff-portal/usePortalHead.test.ts`

**Interfaces:**
- Consumes: `useFfRfq` (T3), `PortalError` (T2), `PortalShell` (T16), `LegSection` (T15), terminal states (T17), `usePortalHead`.
- Produces: `FfPortalPage(): JSX.Element` (reads `:token` via `useParams`). `usePortalHead(title: string): void` (sets `document.title` + injects/updates `<meta name="robots" content="noindex">`, cleaned up on unmount).

**Behavior (branching, §9.6):**
1. `usePortalHead("Request for quote · Svyft Logistics")`.
2. `const { data: rfq, isLoading, error } = useFfRfq(token)`.
3. `isLoading` → a centered spinner/skeleton (inline `div` — no `Skeleton` primitive exists).
4. `error instanceof PortalError && error.status === 401` (or any error) → `<InvalidTokenCard />`.
5. Loaded: page-level state `const [currency, setCurrency] = useState(rfq.currency)` and `const [validity, setValidity] = useState(rfq.quoteValidityUntil)` (seed from the top-level DTO fields; re-seed via `useEffect` when `rfq` identity changes so a refetch doesn't clobber unsaved edits — seed only when the previous value was null/undefined, else keep user edits). `const expired = Date.now() > Date.parse(rfq.submissionDeadline)`.
6. Render `<PortalShell rfq currency onCurrencyChange quoteValidityUntil={validity} onValidityChange>`, with `{expired && <ExpiredBanner/>}` then one `<LegSection key={leg.legId} token rfq leg currency={currency} quoteValidityUntil={validity} readOnly={expired} />` per `rfq.legs`.

- [ ] **Step 1: Write failing tests** — terminal states + editable, via `renderWithProviders` with a `Routes` wrapper so `useParams` resolves.

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { FfPortalPage } from "./FfPortalPage";

afterEach(() => vi.unstubAllGlobals());
const renderAt = (token: string) =>
  renderWithProviders(<Routes><Route path="/ff/rfq/:token" element={<FfPortalPage />} /></Routes>, { route: `/ff/rfq/${token}` });

const okRfq = { rfqNumber: "R-1", incoterms: "FOB", submissionDeadline: "2999-01-01T00:00:00.000Z",
  currency: "USD", quoteValidityUntil: "2999-02-01T00:00:00.000Z", freightForwarder: { companyName: "Acme" }, legs: [] };

describe("FfPortalPage terminal states", () => {
  it("shows the invalid-token card on 401", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => url.includes("/api/ff/rfq/") ? { status: 401, body: {} } : { status: 401 }));
    renderAt("bad");
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
  });
  it("renders the shell when loaded", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => url.includes("/api/ff/rfq/tok") ? { status: 200, body: okRfq } : { status: 401 }));
    renderAt("tok");
    expect(await screen.findByText(/Acme/)).toBeInTheDocument();
  });
  it("shows the expired banner when the deadline is past", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => url.includes("/api/ff/rfq/tok") ? { status: 200, body: { ...okRfq, submissionDeadline: "2000-01-01T00:00:00.000Z" } } : { status: 401 }));
    renderAt("tok");
    expect(await screen.findByText(/deadline has passed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `usePortalHead.ts`, `FfPortalPage.tsx`, and wire the route. In `App.tsx`, add **outside** `<Protected>` (next to `/login`):

```tsx
// App.tsx — import and add:
import { FfPortalPage } from "@/features/ff-portal/FfPortalPage";
// inside <Routes>, as a sibling of the /login route:
<Route path="/ff/rfq/:token" element={<FfPortalPage />} />
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(ff-portal): FfPortalPage terminal/loaded branching + noindex + route"`

---

## Task 19: Integration test — happy-path submit, currency/validity merge, 422 surfacing

**Files:**
- Test: `apps/web/src/features/ff-portal/FfPortal.integration.test.tsx`

**Interfaces:** consumes the whole feature end-to-end via `FfPortalPage` + `mockFetch`.

**Coverage (design doc §6 + §5):**
1. **Happy path:** load an Air leg (one preset charge, seeded density, no warehouse), price the charge, set transit departure + arrival, ensure T&C, click **Submit quote** → assert a **PATCH** to `/api/ff/rfq/tok/quotes/L1` fires, then a **POST** to `/api/ff/rfq/tok/quotes/L1/submit`, and the PATCH body carries the RFQ-level `currency: "USD"` and `quoteValidityUntil` (the merge). Return `201 { quoteId, status: "QUOTED" }`; the follow-up refetch returns the leg as `QUOTED` → assert the "Quote submitted" summary shows.
2. **422 surfacing:** make `/submit` return `422 { findings: [{ rule: "Q1", severity: "blocking", scope: { type: "leg", id: "L1" }, message: "Charge line ... must be priced" }] }` → assert the `role="alert"` shows the server message.
3. **Currency merge assertion:** capture the PATCH body via the mock and assert `body.currency` + `body.quoteValidityUntil` equal the RFQ top-level values even though they were never typed into a per-leg field.

- [ ] **Step 1: Write the integration test** (drive inputs with `userEvent`; capture request bodies by having the `mockFetch` handler push `{ url, init }` into an array). Assert PATCH-before-POST ordering and the merged body.
- [ ] **Step 2: Run → iterate** until green. If a real bug in Tasks 1–18 surfaces, fix it in that file (with a regression test there) — do not paper over it in the integration test.
- [ ] **Step 3: Commit** — `git commit -am "test(ff-portal): e2e happy-path submit + currency/validity merge + 422 surfacing"`

---

## Final verification (before PR)

- [ ] `pnpm --filter @svyft/web test` → all green.
- [ ] `pnpm --filter @svyft/web typecheck` → clean (no `any` leaks at the DTO/engine boundary; numeric fields are `number | null`).
- [ ] `pnpm --filter @svyft/web lint` → clean.
- [ ] `pnpm --filter @svyft/web build` → succeeds (portal bundles `@svyft/shared`; confirm no Node-only import crept in).
- [ ] Manual smoke (optional, via `preview_*`): a `/ff/rfq/<token>` with a live token renders the shell, live recalc works, Save draft + Submit behave; an invalid token shows the terminal card WITHOUT logging out a separate staff tab.
- [ ] Whole-branch review on **opus** (per the SB4c build workflow), then PR `feat/stage-4-sb4c` → `main`.

## Self-Review (author checklist — completed during planning)

- **Spec coverage:** Route+noindex (T18) ✓ · dedicated portal client / 401 hazard (T2) ✓ · hooks (T3) ✓ · terminal states loading/invalid/expired/submitted (T17,T18) ✓ · PortalShell header+countdown+RFQ currency/validity (T5,T16) ✓ · per-leg RHF form (T15) ✓ · CargoManifestTable (T6) ✓ · DensityChargeableGrid live chargeable weight (T7) ✓ · ChargeZonePanel Air/Sea + custom lines (T8) ✓ · TruckingBlocks Road B8 no-add (T9) ✓ · WarehouseStaging (T10) ✓ · TransitPlanForm (T11) ✓ · QuoteSummary Grand Total (T12) ✓ · client `validateQuote` submit gate + findings (T13,T15) ✓ · Save-then-Submit + 422/409 handling (T15) ✓ · DG note + T&C (T14) ✓ · RFQ-level merge into each draft (T15, asserted T19) ✓ · testing coverage list (each task + T19) ✓. Deferred per design (PDF, ScopedRouteDiagram, FF Preview) — intentionally out of scope.
- **Placeholder scan:** no TBD/"handle edge cases"/"similar to Task N" — leaf UI tasks that share a binding idiom reference the concrete pattern shown in T7/T8 and restate their own props/tests.
- **Type consistency:** `QuoteDraft` sub-shapes, enum string values, `computeQuoteTotals` return (`zoneSubtotals.{origin,mainFreight,destination}`), `validateQuote(draft, deadlineIso, nowIso)`, `Finding.scope`, `FfPortalSeededCharge/Density`, and hook signatures all match the verified `@svyft/shared` source.
