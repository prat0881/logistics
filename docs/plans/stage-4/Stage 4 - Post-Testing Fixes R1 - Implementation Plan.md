# Stage 4 · Post-Testing Fixes R1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 6 testing-team fixes on the internal Query Workspace (portal-link copy+regenerate, read-only route canvas, consolidated cargo characteristic icons, hide zero net weight, FF-card cleanup, full country names) and align the requirement docs.

**Architecture:** All changes are `apps/web` UI + a couple of pure `@svyft/shared`/`lib` helpers — **no DB migration, no new backend endpoint** (the re-issue endpoint already exists). New shared building blocks (`copyToClipboard`, `PortalLinkRow`, `getCountryName`, `useReissueToken`, `CargoTagIcons`, `RegeneratePortalLink`) are added once and reused; the six items then wire them into existing components.

**Tech Stack:** React 18 + TS, TanStack Query, shadcn/ui, `lucide-react`, `@svyft/shared`, Vitest + React Testing Library.

## Global Constraints

Every task implicitly includes these (verbatim from the design doc):

- **Scope:** `apps/web` + `@svyft/shared` only. **No Prisma migration. No new API endpoint.** Keep `paymentTerms`/`typicalLeadTime` in the DB, the `FreightForwarderDto`, and the FF-master editor — only the FF *selection card* stops showing them.
- **`@svyft/shared` rebuild:** the web app reads the built `dist`. After editing anything in `packages/shared/src`, run `pnpm --filter @svyft/shared build` BEFORE running web tests. (Only Task 1 touches shared.)
- **TDD + typecheck per task:** failing test → minimal impl → green. Run the focused test, then `pnpm --filter @svyft/web test` (full), AND `pnpm --filter @svyft/web typecheck` (vitest uses esbuild and does NOT type-check — errors hide in test files otherwise). Output must be pristine (no warnings).
- **Icons:** `lucide-react` (already a dep). Any icon-only affordance carries BOTH a `title` (tooltip) and an `aria-label` — meaning lives in the accessible label, not the glyph.
- **Clipboard:** `copyToClipboard` must work over plain HTTP (prod is HTTP until SB5) — try `navigator.clipboard`, fall back to `document.execCommand("copy")`. Never assume a secure context.
- **Reuse:** shadcn primitives from `@/components/ui/*`; `PortalLinkRow` is reused by both link surfaces (Task 3 built once, consumed by Tasks 6 & 8). `postJson`/`fetchJson`/`putJson` from `@/lib/api` for network.
- **Copy tone:** active voice, sentence case (buttons: "Regenerate portal link"; feedback: "Copied", "Couldn't copy — select the link above").
- **Commit after each task.** Branch: `fix/stage-4-testing-r1` (worktree already set up off `main`@`ac26611`).

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `packages/shared/src/reference.ts` (modify) | 1 | add `getCountryName(code)` |
| `apps/web/src/lib/clipboard.ts` (create) | 2 | `copyToClipboard` (clipboard → execCommand fallback) |
| `apps/web/src/features/rfq-workspace/PortalLinkRow.tsx` (create) | 3 | selectable link + robust copy + feedback |
| `apps/web/src/features/rfq-workspace/useRfq.ts` (modify) | 4 | `useReissueToken` mutation hook |
| `apps/web/src/features/rfq-workspace/CargoTagIcons.tsx` (create) | 5 | deduped Heavy/Fragile/Non-stackable/DG icons |
| `apps/web/src/features/rfq-workspace/RegeneratePortalLink.tsx` (create) | 6 | per-FF regenerate button → link (item 1b) |
| `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx` (modify) | 7 | items 5, 6, and wire item 1b |
| `apps/web/src/features/rfq-workspace/DistributeLegAction.tsx` (modify) | 8 | item 1a — use `PortalLinkRow` |
| `apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx` (modify) | 9 | item 3 — wire `CargoTagIcons` under Totals |
| `apps/web/src/features/rfq-workspace/LegPanel.tsx` (modify) | 10 | item 4 — hide net weight when 0 |
| `apps/web/src/features/rfq-workspace/RfqWorkspace.tsx` (modify) | 11 | item 2 — read-only `RouteDiagram` before distribution |
| `docs/**` (modify) | 12 | align Functional Spec + Technical Design + Session Handoff |

---

## Task 1: `getCountryName` (item 6 helper)

**Files:**
- Modify: `packages/shared/src/reference.ts`
- Test: `packages/shared/src/reference.test.ts` (create or extend)

**Interfaces — Produces:** `getCountryName(code: string): string` — maps a country code to its full name via `COUNTRIES` (`{ code, name }[]`), falling back to the raw `code` for unknowns.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { getCountryName } from "./reference";

describe("getCountryName", () => {
  it("maps a known code to its full name", () => {
    expect(getCountryName("IN")).toBe("India");
  });
  it("falls back to the raw code when unknown", () => {
    expect(getCountryName("ZZ")).toBe("ZZ");
  });
});
```

- [ ] **Step 2: Run → FAIL** — `pnpm --filter @svyft/shared test -- reference` (getCountryName not exported).

- [ ] **Step 3: Implement** (append to `reference.ts`, after the `COUNTRIES` const):

```ts
const COUNTRY_NAME_BY_CODE: Map<string, string> = new Map(COUNTRIES.map((c) => [c.code, c.name]));
export function getCountryName(code: string): string {
  return COUNTRY_NAME_BY_CODE.get(code) ?? code;
}
```

- [ ] **Step 4: Run → PASS**, then **build shared** so the web app picks it up: `pnpm --filter @svyft/shared build`.

- [ ] **Step 5: Commit** — `git commit -am "feat(shared): getCountryName code→full-name helper"`

---

## Task 2: `copyToClipboard` util

**Files:**
- Create: `apps/web/src/lib/clipboard.ts`
- Test: `apps/web/src/lib/clipboard.test.ts`

**Interfaces — Produces:** `copyToClipboard(text: string): Promise<boolean>` — tries `navigator.clipboard.writeText`; on absence/failure falls back to a hidden-textarea `document.execCommand("copy")`. Returns success; never throws.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { copyToClipboard } from "./clipboard";

afterEach(() => vi.restoreAllMocks());

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

describe("copyToClipboard", () => {
  it("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await copyToClipboard("http://x/ff/rfq/T")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("http://x/ff/rfq/T");
  });

  it("falls back to execCommand when clipboard is unavailable (HTTP)", async () => {
    setClipboard(undefined);
    const exec = vi.spyOn(document, "execCommand").mockReturnValue(true);
    expect(await copyToClipboard("y")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("returns false when both paths fail", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    expect(await copyToClipboard("z")).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `pnpm --filter @svyft/web test -- lib/clipboard`.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/clipboard.ts
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* secure-context path failed — fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(web): copyToClipboard with HTTP execCommand fallback"`

---

## Task 3: `PortalLinkRow` component

**Files:**
- Create: `apps/web/src/features/rfq-workspace/PortalLinkRow.tsx`
- Test: `apps/web/src/features/rfq-workspace/PortalLinkRow.test.tsx`

**Interfaces:**
- Consumes: `copyToClipboard` (Task 2); shadcn `Input`, `Button`.
- Produces: `PortalLinkRow({ url }: { url: string }): JSX.Element` — a read-only, selectable `Input` showing `url` + a Copy button; shows "Copied" on success, "Couldn't copy — select the link above" on failure.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortalLinkRow } from "./PortalLinkRow";
import * as clip from "@/lib/clipboard";

afterEach(() => vi.restoreAllMocks());

describe("PortalLinkRow", () => {
  it("renders the url in a readonly field and copies it", async () => {
    const spy = vi.spyOn(clip, "copyToClipboard").mockResolvedValue(true);
    render(<PortalLinkRow url="http://host/ff/rfq/TOK" />);
    expect(screen.getByLabelText(/portal link/i)).toHaveValue("http://host/ff/rfq/TOK");
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(spy).toHaveBeenCalledWith("http://host/ff/rfq/TOK");
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it("shows a fallback message when copy fails", async () => {
    vi.spyOn(clip, "copyToClipboard").mockResolvedValue(false);
    render(<PortalLinkRow url="http://host/ff/rfq/TOK" />);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByText(/couldn't copy/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```tsx
// apps/web/src/features/rfq-workspace/PortalLinkRow.tsx
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

export function PortalLinkRow({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  async function copy() {
    setState((await copyToClipboard(url)) ? "ok" : "fail");
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Portal link"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      {state === "ok" && <p className="text-xs text-success">Copied ✓</p>}
      {state === "fail" && <p className="text-xs text-warning">Couldn't copy — select the link above</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(rfq-workspace): PortalLinkRow (selectable link + robust copy)"`

---

## Task 4: `useReissueToken` hook

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/useRfq.ts`
- Test: `apps/web/src/features/rfq-workspace/useRfq.test.tsx` (extend if present, else create)

**Interfaces:**
- Consumes: `postJson` from `@/lib/api`; `ReissueTokenResult` from `@svyft/shared` (`{ rfqId, rfqNumber, freightForwarderId, accessToken }`).
- Produces: `useReissueToken(queryId: string)` — `useMutation`; `mutateAsync(freightForwarderId: string)` POSTs `/api/queries/${queryId}/rfqs/reissue-token` with `{ freightForwarderId }` → `ReissueTokenResult`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { useReissueToken } from "./useRfq";

afterEach(() => vi.unstubAllGlobals());
const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("useReissueToken", () => {
  it("posts freightForwarderId and returns the new token", async () => {
    const fx = mockFetch(() => ({ status: 200, body: { rfqId: "r1", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: "TOK" } }));
    vi.stubGlobal("fetch", fx);
    const { result } = renderHook(() => useReissueToken("q1"), { wrapper: wrapper() });
    const res = await result.current.mutateAsync("ff1");
    expect(res.accessToken).toBe("TOK");
    expect(fx).toHaveBeenCalledWith(
      "/api/queries/q1/rfqs/reissue-token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ freightForwarderId: "ff1" }) }),
    );
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (add to `useRfq.ts`; add `ReissueTokenResult` to the `@svyft/shared` type import):

```ts
export function useReissueToken(queryId: string) {
  return useMutation({
    mutationFn: (freightForwarderId: string) =>
      postJson<ReissueTokenResult>(`/api/queries/${queryId}/rfqs/reissue-token`, { freightForwarderId }),
  });
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(rfq-workspace): useReissueToken mutation hook"`

---

## Task 5: `CargoTagIcons` (item 3 component)

**Files:**
- Create: `apps/web/src/features/rfq-workspace/CargoTagIcons.tsx`
- Test: `apps/web/src/features/rfq-workspace/CargoTagIcons.test.tsx`

**Interfaces:**
- Consumes: `CargoDto`, `ReferenceTag` from `@svyft/shared`; `lucide-react` icons.
- Produces: `CargoTagIcons({ cargo }: { cargo: CargoDto[] }): JSX.Element | null` — one deduped icon per characteristic present across ALL cargo (Heavy/Fragile/Non-stackable from `referenceTags`; DG from `isDangerous`). `null` when none.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CargoDto } from "@svyft/shared";
import { CargoTagIcons } from "./CargoTagIcons";

const cargo = (over: Partial<CargoDto>): CargoDto => ({
  id: "c", rowIndex: 0, poReference: "PO", productName: "P", referenceTags: [], isDangerous: false,
  packageType: "BOX", quantity: 1, dimL: null, dimW: null, dimH: null, netWt: null, grossWt: null, volumeCbm: null,
  ...over,
} as CargoDto);

describe("CargoTagIcons", () => {
  it("shows each characteristic once, deduped across rows", () => {
    render(<CargoTagIcons cargo={[cargo({ isDangerous: true, referenceTags: ["HEAVY"] }), cargo({ isDangerous: true })]} />);
    expect(screen.getAllByLabelText(/dangerous goods/i)).toHaveLength(1); // deduped
    expect(screen.getByLabelText(/heavy/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/fragile/i)).toBeNull();
  });
  it("renders nothing when there are no characteristics", () => {
    const { container } = render(<CargoTagIcons cargo={[cargo({})]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

(NOTE to implementer: confirm the exact `CargoDto` fields by reading `packages/shared/src/cargo.ts` and adjust the test fixture's non-relevant fields to match — the assertions on `referenceTags`/`isDangerous` are what matter.)

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (icon-led; label carries meaning). Pick the clearest available `lucide-react` icons — `Weight`, `Wine`, `Layers`, `TriangleAlert` all exist:

```tsx
// apps/web/src/features/rfq-workspace/CargoTagIcons.tsx
import { Weight, Wine, Layers, TriangleAlert } from "lucide-react";
import type { CargoDto } from "@svyft/shared";

export function CargoTagIcons({ cargo }: { cargo: CargoDto[] }) {
  const has = (tag: string) => cargo.some((c) => c.referenceTags.includes(tag as never));
  const dg = cargo.some((c) => c.isDangerous);
  const items: { key: string; label: string; icon: JSX.Element }[] = [];
  if (has("HEAVY")) items.push({ key: "HEAVY", label: "Heavy", icon: <Weight className="h-4 w-4" /> });
  if (has("FRAGILE")) items.push({ key: "FRAGILE", label: "Fragile", icon: <Wine className="h-4 w-4" /> });
  if (has("NON_STACKABLE")) items.push({ key: "NON_STACKABLE", label: "Non-stackable", icon: <Layers className="h-4 w-4" /> });
  if (dg) items.push({ key: "DG", label: "Dangerous goods", icon: <TriangleAlert className="h-4 w-4 text-warning" /> });
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((it) => (
        <span key={it.key} title={it.label} aria-label={it.label} className="text-muted-foreground">
          {it.icon}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(rfq-workspace): CargoTagIcons (deduped Heavy/Fragile/Non-stackable/DG)"`

---

## Task 6: `RegeneratePortalLink` (item 1b component)

**Files:**
- Create: `apps/web/src/features/rfq-workspace/RegeneratePortalLink.tsx`
- Test: `apps/web/src/features/rfq-workspace/RegeneratePortalLink.test.tsx`

**Interfaces:**
- Consumes: `useReissueToken` (Task 4), `PortalLinkRow` (Task 3); shadcn `Button`.
- Produces: `RegeneratePortalLink({ queryId, freightForwarderId }: { queryId: string; freightForwarderId: string }): JSX.Element` — a "Regenerate portal link" button; on success renders `<PortalLinkRow url={\`${origin}/ff/rfq/${accessToken}\`} />` + an "invalidates the previous link" caption.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { RegeneratePortalLink } from "./RegeneratePortalLink";

afterEach(() => vi.unstubAllGlobals());
const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
};

describe("RegeneratePortalLink", () => {
  it("regenerates and shows the new link + invalidation note", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 200, body: { rfqId: "r", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: "NEWTOK" } })));
    render(wrap(<RegeneratePortalLink queryId="q1" freightForwarderId="ff1" />));
    await userEvent.click(screen.getByRole("button", { name: /regenerate portal link/i }));
    const field = await screen.findByLabelText(/portal link/i);
    expect(field).toHaveValue(expect.stringContaining("/ff/rfq/NEWTOK"));
    expect(screen.getByText(/invalidates the previous link/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```tsx
// apps/web/src/features/rfq-workspace/RegeneratePortalLink.tsx
import { Button } from "@/components/ui/button";
import { useReissueToken } from "./useRfq";
import { PortalLinkRow } from "./PortalLinkRow";

export function RegeneratePortalLink({ queryId, freightForwarderId }: { queryId: string; freightForwarderId: string }) {
  const reissue = useReissueToken(queryId);
  const token = reissue.data?.accessToken;
  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" size="sm"
        disabled={reissue.isPending}
        onClick={() => reissue.mutate(freightForwarderId)}>
        {reissue.isPending ? "Regenerating…" : "Regenerate portal link"}
      </Button>
      {token && (
        <>
          <PortalLinkRow url={`${window.location.origin}/ff/rfq/${token}`} />
          <p className="text-xs text-muted-foreground">This invalidates the previous link.</p>
        </>
      )}
      {reissue.isError && <p className="text-xs text-destructive">Couldn't regenerate the link. Try again.</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(rfq-workspace): RegeneratePortalLink (recover a missed FF link)"`

---

## Task 7: `FfSelectionGrid` — items 5, 6, and wire 1b

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/FfSelectionGrid.tsx`
- Test: `apps/web/src/features/rfq-workspace/FfSelectionGrid.test.tsx` (extend — read the existing test first, keep its cases green)

**Interfaces:**
- Consumes: `getCountryName` (Task 1), `RegeneratePortalLink` (Task 6). `queryId` is already a prop; `isFrozen` (status ≠ SELECT) already marks distributed FFs.

**Edits (inside the card `.map`, currently `:118-123`):**
- Line 119 country codes → full names: `{f.availableCountries.map(getCountryName).join(", ")} · {f.modes.join(", ")}`.
- **Remove** the payment-terms/lead-time paragraph (`:121-123`).
- After the country line, when `isFrozen`, render the regenerate action: `{isFrozen && <RegeneratePortalLink queryId={queryId} freightForwarderId={f.id} />}`.

- [ ] **Step 1: Add failing tests** (mirror the existing test's `mockFetch` + `renderWithProviders` setup; a `legQuotes` entry with `status: "RFQ_SENT"` makes an FF frozen/distributed):

```tsx
// In FfSelectionGrid.test.tsx — read the file first for the exact render helper + eligible-ffs mock.
it("shows full country names, hides payment terms/lead time, and offers regenerate for distributed FFs", async () => {
  // Arrange: eligible-ffs returns one FF (id "ff1", availableCountries ["IN"], paymentTerms "NET30", typicalLeadTime "5d");
  // legQuotes = [{ freightForwarderId: "ff1", status: "RFQ_SENT" }] so it's frozen/distributed.
  // ...render FfSelectionGrid with those props...
  expect(await screen.findByText(/India/)).toBeInTheDocument();          // full name, not "IN"
  expect(screen.queryByText(/NET30|Lead/)).toBeNull();                    // payment terms + lead time gone
  expect(screen.getByRole("button", { name: /regenerate portal link/i })).toBeInTheDocument();
});
```

Also add/keep a case asserting a **SELECT** (not-yet-distributed) FF shows **no** regenerate button.

- [ ] **Step 2: Run → FAIL** (`pnpm --filter @svyft/web test -- ff-selection` or the file name).
- [ ] **Step 3: Implement** the three edits above. Import `getCountryName` from `@svyft/shared` and `RegeneratePortalLink` from `./RegeneratePortalLink`.
- [ ] **Step 4: Run → PASS** (focused + full suite). **Typecheck.**
- [ ] **Step 5: Commit** — `git commit -am "feat(rfq-workspace): FF card — full country names, drop payment/lead-time, regenerate link"`

---

## Task 8: `DistributeLegAction` — item 1a (use `PortalLinkRow`)

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/DistributeLegAction.tsx:99-111`
- Test: `apps/web/src/features/rfq-workspace/DistributeLegAction.test.tsx` (extend; read it first)

**Edit:** where a minted RFQ currently renders the "Copy portal link" `Button` (`:99-111`), when `r.accessToken` is present render `<PortalLinkRow url={\`${window.location.origin}/ff/rfq/${r.accessToken}\`} />` instead.

- [ ] **Step 1: Update/add the test** — after a distribute result with `accessToken: "TOK"`, assert a readonly field with the `/ff/rfq/TOK` URL renders (replaces the old "Copy portal link" assertion). Keep the "updated"/no-token row assertions.

```tsx
// after triggering a successful distribute whose rfqs[0].accessToken = "TOK":
expect(await screen.findByLabelText(/portal link/i)).toHaveValue(expect.stringContaining("/ff/rfq/TOK"));
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the swap (import `PortalLinkRow` from `./PortalLinkRow`).
- [ ] **Step 4: Run → PASS** (focused + full). **Typecheck.**
- [ ] **Step 5: Commit** — `git commit -am "fix(rfq-workspace): distribute result shows a copyable portal link (HTTP-safe)"`

---

## Task 9: `QueryOverviewHeader` — item 3 (icons under Totals)

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/QueryOverviewHeader.tsx:78-80`
- Test: `apps/web/src/features/rfq-workspace/QueryOverviewHeader.test.tsx` (create or extend)

**Edit:** render `<CargoTagIcons cargo={query.cargo} />` inside the `Totals` `Field`, below the "X pkg · Y CBM · Z kg" line. (`query.cargo: CargoDto[]` is already on `QueryDetail`.)

- [ ] **Step 1: Write the failing test** — a `QueryDetail` whose `cargo` has a DG row → the "Dangerous goods" icon (by `aria-label`) renders in the header. (Build a minimal `QueryDetail` fixture; reuse any existing header test fixture.)

```tsx
// render(<QueryOverviewHeader query={queryWithDgCargo} />);
expect(screen.getByLabelText(/dangerous goods/i)).toBeInTheDocument();
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```tsx
// inside the Totals <Field>:
<Field label="Totals">
  <div className="space-y-1">
    <div>{totals.pkg} pkg · {totals.cbm} CBM · {totals.gross} kg</div>
    <CargoTagIcons cargo={query.cargo} />
  </div>
</Field>
```
(import `CargoTagIcons` from `./CargoTagIcons`.)

- [ ] **Step 4: Run → PASS.** **Typecheck.**
- [ ] **Step 5: Commit** — `git commit -am "feat(rfq-workspace): consolidated cargo characteristic icons under Totals"`

---

## Task 10: `LegPanel` — item 4 (hide net weight when 0)

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/LegPanel.tsx:82-83`
- Test: `apps/web/src/features/rfq-workspace/LegPanel.test.tsx` (extend; read it first)

**Edit:** the "Manifest totals" line currently ends `· {leg.rollup.totalGrossWt} kg gross · {leg.rollup.totalNetWt} kg net`. Render the `· … kg net` segment only when `leg.rollup.totalNetWt > 0`.

- [ ] **Step 1: Add failing tests** — a leg with `rollup.totalNetWt: 0` does NOT render "kg net" (but still shows gross/pkg/CBM); a leg with `totalNetWt: 120` renders "120 kg net".

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```tsx
{leg.rollup.totalPackages} pkg · {leg.rollup.totalCbm} CBM ·{" "}
{leg.rollup.totalGrossWt} kg gross
{leg.rollup.totalNetWt > 0 && <> · {leg.rollup.totalNetWt} kg net</>}
```

- [ ] **Step 4: Run → PASS.** **Typecheck.**
- [ ] **Step 5: Commit** — `git commit -am "fix(rfq-workspace): hide per-leg net weight when zero"`

---

## Task 11: `RfqWorkspace` — item 2 (read-only route canvas before distribution)

**Files:**
- Modify: `apps/web/src/features/rfq-workspace/RfqWorkspace.tsx:44`
- Test: `apps/web/src/features/rfq-workspace/RfqWorkspace.test.tsx` (extend; read it first)

**Edit:** after `<QueryOverviewHeader query={q} />`, render the read-only route canvas only before distribution. Wrap it in a labelled section so it's easy to assert:

```tsx
import { RouteDiagram } from "@/features/query-wizard/steps/legs/RouteDiagram";
const PRE_DISTRIBUTION = new Set(["DRAFT", "CREATED", "RFQ_READY"]);
// ...after the header:
{PRE_DISTRIBUTION.has(q.status) && (
  <section aria-label="Route overview" className="rounded-lg border border-border bg-card p-4 sm:p-6">
    <h2 className="mb-3 font-display text-sm font-semibold text-muted-foreground">Route overview</h2>
    <RouteDiagram detail={q} findings={[]} />
  </section>
)}
```
(Omitting `onEditPoint`/`onEditLeg` makes `RouteDiagram` read-only; its hover tooltips are built in. No new fetch — `q` is already loaded.)

- [ ] **Step 1: Add failing tests** — read the existing `RfqWorkspace.test.tsx` for its `mockFetch` shape (it stubs `GET /api/queries/:id` and `/rfq-state`). Add: a query with `status: "RFQ_READY"` renders the "Route overview" section (`getByRole("region", { name: /route overview/i })` or `getByLabelText(/route overview/i)`); a query with `status: "RFQ_SENT"` does NOT.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the gated section.
- [ ] **Step 4: Run → PASS** (focused + full). **Typecheck.** (Watch: `RouteDiagram` may need points/legs in the fixture — mirror the existing workspace test's query fixture; if it renders nothing meaningful without legs, add a leg+points to the fixture so the section has content.)
- [ ] **Step 5: Commit** — `git commit -am "feat(rfq-workspace): read-only route overview before RFQ distribution"`

---

## Task 12: Align requirement docs

**Files (modify):**
- `docs/Stage 4 - RFQ Send to Freight Forwarder (v2) - Functional Spec.md`
- `docs/Stage 4 - Technical Design.md`
- `docs/Stage 4 - Session Handoff.md`

No tests (docs). Make **targeted change-notes** (do not rewrite):

- [ ] **Functional Spec** — in the FF selection-grid section (§7.2.x): the FF card shows **full country names** and **no longer shows payment terms / lead time** (those remain in the FF master). In the query-overview/header section (§7.1): the **Totals** now shows consolidated **cargo characteristic icons** (Heavy / Fragile / Non-stackable / DG), deduped across all cargo. Add the **per-leg net-weight rule** (hidden when 0). Add a **read-only route overview** shown in the workspace **before** RFQ distribution (complements the deferred FF-scoped diagram §7.3.4). In the distribute / portal-link section (§13): the portal link is **copyable over HTTP** (selectable + fallback) and can be **regenerated per forwarder** from the workspace (invalidates the old link).
- [ ] **Technical Design** — note the new web helpers (`copyToClipboard`, `PortalLinkRow`, `getCountryName`, `CargoTagIcons`, `RegeneratePortalLink`, `useReissueToken`) and that portal-link copy must not assume a secure context (HTTP-until-SB5). No schema/API change.
- [ ] **Session Handoff** — add a "Post-testing fixes — Round 1 (PR: fix/stage-4-testing-r1)" entry under *Known issues / carried notes* listing the 6 items + this design/plan path.
- [ ] **Commit** — `git commit -am "docs(stage-4): align spec/TD/handoff with post-testing fixes R1"`

---

## Final verification (before PR)

- [ ] `pnpm --filter @svyft/shared build` (reference.ts changed) then `pnpm --filter @svyft/web test` → all green, pristine.
- [ ] `pnpm --filter @svyft/web typecheck` → 0 errors. `pnpm --filter @svyft/web lint` → clean. `pnpm --filter @svyft/web build` → succeeds.
- [ ] Whole-branch review on **opus**, then PR `fix/stage-4-testing-r1` → `main`.

## Self-Review (author checklist — completed during planning)

- **Spec coverage:** item 1a (Task 8) ✓ · 1b (Tasks 4,6,7) ✓ · item 2 route canvas (Task 11) ✓ · item 3 tags+DG icons (Tasks 5,9) ✓ · item 4 net weight (Task 10) ✓ · item 5 payment/lead-time removal (Task 7) ✓ · item 6 country names (Tasks 1,7) ✓ · shared blocks (Tasks 1–6) ✓ · docs (Task 12) ✓.
- **Placeholder scan:** the two edit-heavy tests (Tasks 7, 8, 11) intentionally say "read the existing test first + mirror its harness" rather than reproducing an unknown fixture — the concrete assertions are given; the harness is what already exists in-repo. No TBD/"handle edge cases".
- **Type consistency:** `getCountryName(code)`, `copyToClipboard(text)→Promise<boolean>`, `PortalLinkRow({url})`, `useReissueToken(queryId).mutateAsync(ffId)→ReissueTokenResult`, `CargoTagIcons({cargo})`, `RegeneratePortalLink({queryId,freightForwarderId})` are consistent across producer/consumer tasks. `leg.rollup.totalNetWt` is a `number` (guard `> 0`). `frozen`/`isFrozen` (status≠SELECT) is the distributed gate.
