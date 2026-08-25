import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import type { QuotationDto } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { renderWithProviders } from "@/test/renderWithProviders";
import { QuotationPage } from "./QuotationPage";

afterEach(() => vi.unstubAllGlobals());

// `AuthProvider`'s `/api/auth/me` round trip is async — `useAuth()`'s `user` is `null` for one or
// more microtask hops after `render()` returns, which makes any role gate read `false` REGARDLESS
// of the role passed in. An absence assertion taken before this settles would pass identically
// whether `QuotationPage`'s Manager+ gate is correct or completely inverted. `AuthProbe` renders a
// value that only exists once `AuthProvider` has actually resolved, so `await
// screen.findByText(role)` forces every assertion after it to run post-settle (same mechanism as
// `ComparisonGrid.test.tsx`'s "Checker action bar" block / `CompareQuotesPage.test.tsx`).
function AuthProbe() {
  const { user, loading } = useAuth();
  return <span data-testid="auth-probe">{loading ? "loading" : (user?.role ?? "anonymous")}</span>;
}

const QUERY_DETAIL = {
  id: "q1",
  queryCode: "YAL26-0001",
  status: "QUOTING_CLIENT",
  incoterms: "FOB",
  contactEmail: null as string | null,
  freightMode: [],
  origin: [],
  destination: [],
  cargos: [],
  points: [],
  legs: [],
};

/**
 * One leg, two groups — ORIGIN (two lines: 60/66, 40/44) and FREIGHT (one line: 200/220) — at
 * marginPct 10 (`clientAmount(cost, 10) = cost * 1.1`). Two lines in ORIGIN (rather than one) so a
 * group's rolled-up total is never numerically identical to either of its own lines, which keeps
 * `screen.getByText(...)` assertions scoped by `data-testid` unambiguous rather than needing every
 * single check to be `within(...)`.
 */
function baseQuotation(overrides: Partial<QuotationDto> = {}): QuotationDto {
  return {
    id: "quo1",
    queryId: "q1",
    version: 1,
    status: "DRAFT",
    marginPct: 10,
    overrides: {},
    pricing: {
      legs: [
        {
          legId: "l1",
          legCode: "LEG-1",
          forwarderName: "TCI Freight",
          variantLabel: "Dedicated",
          groups: [
            {
              group: "ORIGIN",
              label: "Origin charges",
              lines: [
                {
                  id: "ORIGIN:0",
                  group: "ORIGIN",
                  label: "Origin handling",
                  costNative: 60,
                  costUsd: 60,
                  clientUsd: 66,
                  overridden: false,
                },
                {
                  id: "ORIGIN:1",
                  group: "ORIGIN",
                  label: "Origin documentation",
                  costNative: 40,
                  costUsd: 40,
                  clientUsd: 44,
                  overridden: false,
                },
              ],
              costUsd: 100,
              clientUsd: 110,
            },
            {
              group: "FREIGHT",
              label: "Freight",
              lines: [
                {
                  id: "FREIGHT:0",
                  group: "FREIGHT",
                  label: "Ocean freight",
                  costNative: 200,
                  costUsd: 200,
                  clientUsd: 220,
                  overridden: false,
                },
              ],
              costUsd: 200,
              clientUsd: 220,
            },
          ],
          costUsd: 300,
          clientUsd: 330,
        },
      ],
      costTotalUsd: 300,
      clientTotalUsd: 330,
      marginValueUsd: 30,
    },
    validUntil: null,
    previewSubject: "Quotation YAL26-0001-Q1 · Ref YAL26-0001",
    previewBody: "Dear Acme Ltd,\n\nTotal — all inclusive: USD 330.00\n\nRegards,\nYankalfa Logistics",
    recipientEmail: null,
    subject: null,
    bodyText: null,
    issuedAt: null,
    issuedByUserId: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage(
  opts: {
    role?: string;
    quotation?: QuotationDto;
    queryDetail?: typeof QUERY_DETAIL;
    onPatch?: (body: unknown) => void;
    /** nth PATCH call gets the nth response; the last entry repeats once exhausted. */
    patchResponses?: QuotationDto[];
    /** S5.9.3 Task 1 re-review (IMPORTANT) — awaited before a PATCH response resolves, so a test
     *  can hold a margin/override PATCH "in flight" for an observable window (assert on
     *  `pricingPending`-gated UI, then release it) instead of racing a promise that always settles
     *  in the same microtask. Defaults to an already-resolved promise, so every other test's PATCH
     *  behaves exactly as before (settles on the next microtask, same as the old `mockFetch`-based
     *  stub). */
    patchGate?: Promise<void>;
    onIssuePost?: (body: unknown) => void;
    issueResponse?: { status: number; body?: unknown };
    /** S5.9.3 final review (IMPORTANT #1) — models a SECOND client having repriced this quotation
     *  behind this browser's back. The real sequence is: the other tab PATCHes (the server row
     *  changes; this browser is told nothing), then this browser's issue POST is refused as
     *  stale, then its refetch finally sees the new row. Applied at the moment the issue POST is
     *  refused, which is the first point in that sequence where this harness is involved at all. */
    repricedByAnotherClientTo?: QuotationDto;
    onRevisePost?: () => void;
    reviseResponse?: { status: number; body?: unknown };
    captureUrl?: (url: string) => void;
  } = {},
) {
  const role = opts.role ?? "MANAGER";
  // Stateful, not a fixed closed-over value: `usePatchQuotation`/`useIssueQuotation`/
  // `useReviseQuotation` all `setQueryData` AND `invalidateQueries` on the same key (the brief's
  // explicit "invalidate after a mutation" instruction), so a successful mutation triggers a
  // background re-GET. A REAL server would answer that re-GET with the just-mutated state; a mock
  // that always hands back the original fixture would race the fresh `setQueryData` and win,
  // making every post-mutation assertion flaky/false — so `currentQuotation` tracks what the
  // "server" would actually have after each PATCH/issue/revise.
  let currentQuotation = opts.quotation ?? baseQuotation();
  let patchCall = 0;
  const respond = (status: number, body?: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? {},
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    }) as Response;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      opts.captureUrl?.(url);
      if (url.endsWith("/api/queries/q1/quotation") && init?.method === "PATCH") {
        if (opts.patchGate) await opts.patchGate;
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        opts.onPatch?.(body);
        const responses = opts.patchResponses ?? [currentQuotation];
        const res = responses[Math.min(patchCall, responses.length - 1)];
        patchCall += 1;
        currentQuotation = res;
        return respond(200, res);
      }
      if (url.endsWith("/api/queries/q1/quotation/issue") && init?.method === "POST") {
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        opts.onIssuePost?.(body);
        const res = opts.issueResponse ?? {
          status: 200,
          body: { ...currentQuotation, status: "ISSUED", recipientEmail: body?.recipientEmail ?? null },
        };
        if (res.status < 300) currentQuotation = res.body as QuotationDto;
        else if (opts.repricedByAnotherClientTo) currentQuotation = opts.repricedByAnotherClientTo;
        return respond(res.status, res.body);
      }
      if (url.endsWith("/api/queries/q1/quotation/revise") && init?.method === "POST") {
        opts.onRevisePost?.();
        const res = opts.reviseResponse ?? {
          status: 200,
          body: { ...currentQuotation, status: "DRAFT", version: currentQuotation.version + 1 },
        };
        if (res.status < 300) currentQuotation = res.body as QuotationDto;
        return respond(res.status, res.body);
      }
      if (url.endsWith("/api/queries/q1/quotation")) return respond(200, currentQuotation);
      if (url.endsWith("/api/queries/q1")) return respond(200, opts.queryDetail ?? QUERY_DETAIL);
      return respond(404);
    }),
  );
  return renderWithProviders(
    <>
      <AuthProbe />
      <Routes>
        <Route path="/queries/:id/quotation" element={<QuotationPage />} />
      </Routes>
    </>,
    { route: "/queries/q1/quotation", user: { id: "u1", name: "Viewer", email: "v@x.com", role } },
  );
}

describe("QuotationPage", () => {
  // S5.8 Task 6 replaces the Task-5 disabled stub with the real dialog — clicking "Preview
  // quotation" on a DRAFT opens `QuotationPreviewDialog`, showing the server-rendered letter.
  it("renders the builder for a MANAGER, with a working Preview quotation button", async () => {
    renderPage();
    await screen.findByText("MANAGER");
    expect(await screen.findByTestId("quotation-page")).toBeInTheDocument();

    const preview = screen.getByRole("button", { name: /preview quotation/i });
    expect(preview).not.toBeDisabled();

    await userEvent.click(preview);
    // S5.9.3 Task 1: the letter is now an editable textarea — `toHaveValue`, not
    // `toHaveTextContent`, is the correct matcher for a form control's value.
    const letter = await screen.findByTestId("quotation-letter");
    expect((letter as HTMLTextAreaElement).value).toContain("USD 330.00");
  });

  it("hides the builder for an EXECUTIVE and never issues the Manager+-only quotation request", async () => {
    const urls: string[] = [];
    renderPage({ role: "EXECUTIVE", captureUrl: (u) => urls.push(u) });

    // Positive control BEFORE the absence assertion (see AuthProbe doc comment above).
    await screen.findByText("EXECUTIVE");

    expect(screen.queryByTestId("quotation-page")).not.toBeInTheDocument();
    expect(urls.some((u) => u.includes("/quotation"))).toBe(false);
  });

  it("shows forwarder cost and client price for every line", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /origin charges/i }));

    const row0 = screen.getByTestId("line-l1-ORIGIN:0");
    expect(within(row0).getByText("$60.00")).toBeInTheDocument();
    expect(within(row0).getByDisplayValue("66")).toBeInTheDocument();

    const row1 = screen.getByTestId("line-l1-ORIGIN:1");
    expect(within(row1).getByText("$40.00")).toBeInTheDocument();
    expect(within(row1).getByDisplayValue("44")).toBeInTheDocument();
  });

  it("typing a margin recalculates unpinned lines and the grand total", async () => {
    const patchBodies: unknown[] = [];
    const at20Pct = baseQuotation({
      marginPct: 20,
      pricing: {
        legs: [
          {
            legId: "l1",
            legCode: "LEG-1",
            forwarderName: "TCI Freight",
            variantLabel: "Dedicated",
            groups: [
              {
                group: "ORIGIN",
                label: "Origin charges",
                lines: [
                  {
                    id: "ORIGIN:0",
                    group: "ORIGIN",
                    label: "Origin handling",
                    costNative: 60,
                    costUsd: 60,
                    clientUsd: 72,
                    overridden: false,
                  },
                  {
                    id: "ORIGIN:1",
                    group: "ORIGIN",
                    label: "Origin documentation",
                    costNative: 40,
                    costUsd: 40,
                    clientUsd: 48,
                    overridden: false,
                  },
                ],
                costUsd: 100,
                clientUsd: 120,
              },
              {
                group: "FREIGHT",
                label: "Freight",
                lines: [
                  {
                    id: "FREIGHT:0",
                    group: "FREIGHT",
                    label: "Ocean freight",
                    costNative: 200,
                    costUsd: 200,
                    clientUsd: 240,
                    overridden: false,
                  },
                ],
                costUsd: 200,
                clientUsd: 240,
              },
            ],
            costUsd: 300,
            clientUsd: 360,
          },
        ],
        costTotalUsd: 300,
        clientTotalUsd: 360,
        marginValueUsd: 60,
      },
    });

    renderPage({ onPatch: (b) => patchBodies.push(b), patchResponses: [at20Pct] });

    const marginInput = await screen.findByLabelText(/margin/i);
    // A single deterministic `fireEvent.change` (the same pattern used for other numeric/date
    // inputs in this codebase, e.g. `PortalShell.test.tsx`), not `userEvent.clear` + `type`
    // character-by-character — the latter is a real flake source here: each keystroke schedules
    // and cancels a debounce timer against the (async, `act()`-batched) React state, and a stray
    // race between `clear()`'s own state flush and the first keystroke can leave the OLD "10"
    // un-cleared, so typing "20" lands as "1020" instead of replacing it.
    fireEvent.change(marginInput, { target: { value: "20" } });

    await waitFor(() => expect(patchBodies).toHaveLength(1), { timeout: 2000 });
    expect(patchBodies[0]).toEqual({ marginPct: 20 });

    expect(await screen.findByTestId("grand-total")).toHaveTextContent("$360.00");

    await userEvent.click(screen.getByRole("button", { name: /origin charges/i }));
    expect(
      within(screen.getByTestId("line-l1-ORIGIN:0")).getByDisplayValue("72"),
    ).toBeInTheDocument();
  });

  // ── S5.9.3 Task 1 re-review (IMPORTANT) — closing the reprice-while-open window ─────────────
  //
  // Before this fix, "Preview quotation" had no gating at all (unlike "Reset overrides", which
  // already disables on `patch.isPending`). A margin edit still mid-debounce, or an override PATCH
  // still in flight, could be immediately followed by opening the preview — the dialog would then
  // hold the OLD total while the query cache's `quotation.pricing` moved on underneath it.

  it('"Preview quotation" disables while a margin edit is still debounced, and re-enables once it resolves with the new total', async () => {
    const at20Pct = baseQuotation({
      marginPct: 20,
      previewBody: "Dear Acme Ltd,\n\nTotal — all inclusive: USD 360.00\n\nRegards,\nYankalfa Logistics",
      pricing: {
        legs: [
          {
            legId: "l1",
            legCode: "LEG-1",
            forwarderName: "TCI Freight",
            variantLabel: "Dedicated",
            groups: [
              {
                group: "ORIGIN",
                label: "Origin charges",
                lines: [
                  { id: "ORIGIN:0", group: "ORIGIN", label: "Origin handling", costNative: 60, costUsd: 60, clientUsd: 72, overridden: false },
                  { id: "ORIGIN:1", group: "ORIGIN", label: "Origin documentation", costNative: 40, costUsd: 40, clientUsd: 48, overridden: false },
                ],
                costUsd: 100,
                clientUsd: 120,
              },
              {
                group: "FREIGHT",
                label: "Freight",
                lines: [
                  { id: "FREIGHT:0", group: "FREIGHT", label: "Ocean freight", costNative: 200, costUsd: 200, clientUsd: 240, overridden: false },
                ],
                costUsd: 200,
                clientUsd: 240,
              },
            ],
            costUsd: 300,
            clientUsd: 360,
          },
        ],
        costTotalUsd: 300,
        clientTotalUsd: 360,
        marginValueUsd: 60,
      },
    });

    renderPage({ patchResponses: [at20Pct] });

    const marginInput = await screen.findByLabelText(/margin/i);
    const preview = screen.getByRole("button", { name: /preview quotation/i });
    expect(preview).not.toBeDisabled();

    fireEvent.change(marginInput, { target: { value: "20" } });
    // Still inside the 400ms debounce window — no PATCH has fired yet, but a reprice is queued.
    expect(preview).toBeDisabled();

    await waitFor(() => expect(preview).not.toBeDisabled(), { timeout: 2000 });
    expect(await screen.findByTestId("grand-total")).toHaveTextContent("$360.00");
  });

  it('"Preview quotation" disables while an override PATCH is in flight, and re-enables once it resolves — the dialog it opens afterward shows the repriced total, not the stale one', async () => {
    const afterEdit = baseQuotation({
      overrides: { "l1:ORIGIN:0": 45 },
      previewBody: "Dear Acme Ltd,\n\nTotal — all inclusive: USD 309.00\n\nRegards,\nYankalfa Logistics",
      pricing: {
        legs: [
          {
            legId: "l1",
            legCode: "LEG-1",
            forwarderName: "TCI Freight",
            variantLabel: "Dedicated",
            groups: [
              {
                group: "ORIGIN",
                label: "Origin charges",
                lines: [
                  { id: "ORIGIN:0", group: "ORIGIN", label: "Origin handling", costNative: 60, costUsd: 60, clientUsd: 45, overridden: true },
                  { id: "ORIGIN:1", group: "ORIGIN", label: "Origin documentation", costNative: 40, costUsd: 40, clientUsd: 44, overridden: false },
                ],
                costUsd: 100,
                clientUsd: 89,
              },
              {
                group: "FREIGHT",
                label: "Freight",
                lines: [
                  { id: "FREIGHT:0", group: "FREIGHT", label: "Ocean freight", costNative: 200, costUsd: 200, clientUsd: 220, overridden: false },
                ],
                costUsd: 200,
                clientUsd: 220,
              },
            ],
            costUsd: 300,
            clientUsd: 309,
          },
        ],
        costTotalUsd: 300,
        clientTotalUsd: 309,
        marginValueUsd: 9,
      },
    });

    let releasePatch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });

    renderPage({ patchGate: gate, patchResponses: [afterEdit] });

    await userEvent.click(await screen.findByRole("button", { name: /origin charges/i }));
    const input = within(screen.getByTestId("line-l1-ORIGIN:0")).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "45");
    await userEvent.tab(); // blur -> onCommitOverride -> patch.mutate; the request now hangs on `gate`.

    const preview = screen.getByRole("button", { name: /preview quotation/i });
    await waitFor(() => expect(preview).toBeDisabled());

    releasePatch();
    await waitFor(() => expect(preview).not.toBeDisabled());
    expect(await screen.findByTestId("grand-total")).toHaveTextContent("$309.00");

    // The reprice is now reflected in the query cache, so opening the dialog after the PATCH
    // settles shows the CURRENT total, not the one from before the edit.
    await userEvent.click(preview);
    const letter = await screen.findByTestId("quotation-letter");
    expect((letter as HTMLTextAreaElement).value).toContain("USD 309.00");
  });

  it("editing a line pins it, badges it, and holds it across a margin change", async () => {
    const patchBodies: unknown[] = [];
    const afterEdit = baseQuotation({
      overrides: { "l1:ORIGIN:0": 45 },
      pricing: {
        legs: [
          {
            legId: "l1",
            legCode: "LEG-1",
            forwarderName: "TCI Freight",
            variantLabel: "Dedicated",
            groups: [
              {
                group: "ORIGIN",
                label: "Origin charges",
                lines: [
                  {
                    id: "ORIGIN:0",
                    group: "ORIGIN",
                    label: "Origin handling",
                    costNative: 60,
                    costUsd: 60,
                    clientUsd: 45,
                    overridden: true,
                  },
                  {
                    id: "ORIGIN:1",
                    group: "ORIGIN",
                    label: "Origin documentation",
                    costNative: 40,
                    costUsd: 40,
                    clientUsd: 44,
                    overridden: false,
                  },
                ],
                costUsd: 100,
                clientUsd: 89,
              },
              {
                group: "FREIGHT",
                label: "Freight",
                lines: [
                  {
                    id: "FREIGHT:0",
                    group: "FREIGHT",
                    label: "Ocean freight",
                    costNative: 200,
                    costUsd: 200,
                    clientUsd: 220,
                    overridden: false,
                  },
                ],
                costUsd: 200,
                clientUsd: 220,
              },
            ],
            costUsd: 300,
            clientUsd: 309,
          },
        ],
        costTotalUsd: 300,
        clientTotalUsd: 309,
        marginValueUsd: 9,
      },
    });
    // 🔴 Margin-only PATCH omits `overrides` — the server's contract preserves the stored map when
    // the field isn't sent, so ORIGIN:0 stays pinned at 45.00 while ORIGIN:1/FREIGHT:0 recompute
    // at the new 25% margin.
    const afterMarginChange = baseQuotation({
      marginPct: 25,
      overrides: { "l1:ORIGIN:0": 45 },
      pricing: {
        legs: [
          {
            legId: "l1",
            legCode: "LEG-1",
            forwarderName: "TCI Freight",
            variantLabel: "Dedicated",
            groups: [
              {
                group: "ORIGIN",
                label: "Origin charges",
                lines: [
                  {
                    id: "ORIGIN:0",
                    group: "ORIGIN",
                    label: "Origin handling",
                    costNative: 60,
                    costUsd: 60,
                    clientUsd: 45,
                    overridden: true,
                  },
                  {
                    id: "ORIGIN:1",
                    group: "ORIGIN",
                    label: "Origin documentation",
                    costNative: 40,
                    costUsd: 40,
                    clientUsd: 50,
                    overridden: false,
                  },
                ],
                costUsd: 100,
                clientUsd: 95,
              },
              {
                group: "FREIGHT",
                label: "Freight",
                lines: [
                  {
                    id: "FREIGHT:0",
                    group: "FREIGHT",
                    label: "Ocean freight",
                    costNative: 200,
                    costUsd: 200,
                    clientUsd: 250,
                    overridden: false,
                  },
                ],
                costUsd: 200,
                clientUsd: 250,
              },
            ],
            costUsd: 300,
            clientUsd: 345,
          },
        ],
        costTotalUsd: 300,
        clientTotalUsd: 345,
        marginValueUsd: 45,
      },
    });

    renderPage({
      onPatch: (b) => patchBodies.push(b),
      patchResponses: [afterEdit, afterMarginChange],
    });

    await userEvent.click(await screen.findByRole("button", { name: /origin charges/i }));
    const input = within(screen.getByTestId("line-l1-ORIGIN:0")).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "45");
    await userEvent.tab();

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ overrides: { "l1:ORIGIN:0": 45 } });
    expect(
      within(await screen.findByTestId("line-l1-ORIGIN:0")).getByText(/pinned/i),
    ).toBeInTheDocument();
    // The sibling line is untouched — proves the badge is per-line, not page-wide.
    expect(
      within(screen.getByTestId("line-l1-ORIGIN:1")).queryByText(/pinned/i),
    ).not.toBeInTheDocument();

    const marginInput = screen.getByLabelText(/margin/i);
    fireEvent.change(marginInput, { target: { value: "25" } });

    await waitFor(() => expect(patchBodies).toHaveLength(2), { timeout: 2000 });
    expect(patchBodies[1]).toEqual({ marginPct: 25 });

    expect(
      within(await screen.findByTestId("line-l1-ORIGIN:0")).getByText(/pinned/i),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("line-l1-ORIGIN:0")).getByDisplayValue("45"),
    ).toBeInTheDocument();
  });

  it("reset overrides releases every pinned line back to the formula", async () => {
    const patchBodies: unknown[] = [];
    const pinned = baseQuotation({
      overrides: { "l1:ORIGIN:0": 45 },
      pricing: {
        legs: [
          {
            legId: "l1",
            legCode: "LEG-1",
            forwarderName: "TCI Freight",
            variantLabel: "Dedicated",
            groups: [
              {
                group: "ORIGIN",
                label: "Origin charges",
                lines: [
                  {
                    id: "ORIGIN:0",
                    group: "ORIGIN",
                    label: "Origin handling",
                    costNative: 60,
                    costUsd: 60,
                    clientUsd: 45,
                    overridden: true,
                  },
                  {
                    id: "ORIGIN:1",
                    group: "ORIGIN",
                    label: "Origin documentation",
                    costNative: 40,
                    costUsd: 40,
                    clientUsd: 44,
                    overridden: false,
                  },
                ],
                costUsd: 100,
                clientUsd: 89,
              },
              {
                group: "FREIGHT",
                label: "Freight",
                lines: [
                  {
                    id: "FREIGHT:0",
                    group: "FREIGHT",
                    label: "Ocean freight",
                    costNative: 200,
                    costUsd: 200,
                    clientUsd: 220,
                    overridden: false,
                  },
                ],
                costUsd: 200,
                clientUsd: 220,
              },
            ],
            costUsd: 300,
            clientUsd: 309,
          },
        ],
        costTotalUsd: 300,
        clientTotalUsd: 309,
        marginValueUsd: 9,
      },
    });
    const reset = baseQuotation(); // overrides: {}, everything back to the plain 10%-margin formula

    renderPage({ quotation: pinned, onPatch: (b) => patchBodies.push(b), patchResponses: [reset] });

    await userEvent.click(await screen.findByRole("button", { name: /origin charges/i }));
    expect(
      within(screen.getByTestId("line-l1-ORIGIN:0")).getByText(/pinned/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /reset overrides/i }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ overrides: {} });

    await waitFor(() =>
      expect(
        within(screen.getByTestId("line-l1-ORIGIN:0")).queryByText(/pinned/i),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId("line-l1-ORIGIN:0")).getByDisplayValue("66"),
    ).toBeInTheDocument();
  });

  // S5.9.3 P6 — the product owner had to ask what "Reset overrides" did; the label alone wasn't
  // enough. A one-line description now sits beside the button and is wired to it via
  // `aria-describedby` so an assistive-tech user gets it too, not just a sighted one reading the
  // paragraph next to the button.
  it("describes what Reset overrides does, next to the button", async () => {
    renderPage({ quotation: baseQuotation({ overrides: { "l1:ORIGIN:0": 45 } }) });

    const resetButton = await screen.findByRole("button", { name: /reset overrides/i });
    const description = screen.getByText(
      /clears every hand-typed line price.*margin formula/i,
    );
    expect(description).toBeInTheDocument();
    expect(resetButton).toHaveAttribute("aria-describedby", description.id);
  });

  // 🔴 The contract that bites: `overrides` REPLACES the stored map wholesale. Editing one line
  // must PATCH the complete map — every previously pinned line plus the newly changed one — never
  // just the one key that changed, or every other pin is silently released server-side.
  it("PATCHes the complete override map, including a previously pinned line, not just the one being edited", async () => {
    const patchBodies: unknown[] = [];
    const withExistingPin = baseQuotation({
      overrides: { "l1:ORIGIN:1": 50 },
      pricing: {
        legs: [
          {
            legId: "l1",
            legCode: "LEG-1",
            forwarderName: "TCI Freight",
            variantLabel: "Dedicated",
            groups: [
              {
                group: "ORIGIN",
                label: "Origin charges",
                lines: [
                  {
                    id: "ORIGIN:0",
                    group: "ORIGIN",
                    label: "Origin handling",
                    costNative: 60,
                    costUsd: 60,
                    clientUsd: 66,
                    overridden: false,
                  },
                  {
                    id: "ORIGIN:1",
                    group: "ORIGIN",
                    label: "Origin documentation",
                    costNative: 40,
                    costUsd: 40,
                    clientUsd: 50,
                    overridden: true,
                  },
                ],
                costUsd: 100,
                clientUsd: 116,
              },
              {
                group: "FREIGHT",
                label: "Freight",
                lines: [
                  {
                    id: "FREIGHT:0",
                    group: "FREIGHT",
                    label: "Ocean freight",
                    costNative: 200,
                    costUsd: 200,
                    clientUsd: 220,
                    overridden: false,
                  },
                ],
                costUsd: 200,
                clientUsd: 220,
              },
            ],
            costUsd: 300,
            clientUsd: 336,
          },
        ],
        costTotalUsd: 300,
        clientTotalUsd: 336,
        marginValueUsd: 36,
      },
    });

    renderPage({ quotation: withExistingPin, onPatch: (b) => patchBodies.push(b) });

    await userEvent.click(await screen.findByRole("button", { name: /origin charges/i }));
    const input = within(screen.getByTestId("line-l1-ORIGIN:0")).getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "45");
    await userEvent.tab();

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // Both keys — the pre-existing pin AND the just-edited line — must be present.
    expect(patchBodies[0]).toEqual({
      overrides: { "l1:ORIGIN:1": 50, "l1:ORIGIN:0": 45 },
    });
  });

  // 🔴 Final review IMPORTANT #6 — a lost update on a money field. `onCommitOverride` seeded the
  // wholesale override map from `quotation.data.overrides`, which is only refreshed by the PREVIOUS
  // PATCH's `onSuccess`. Blur line A, then blur line B before A's response lands, and B's PATCH was
  // composed from pre-A state — so the server replaced the map with one that never contained A, and
  // the manager's hand-set price on A vanished with no error and no visual tell until the next
  // refetch snapped it back. The fix seeds from the LAST MAP SENT (a ref), falling back to the
  // server's copy only before the first send.
  it("a second line edit made before the first PATCH responds still carries the first line's override", async () => {
    const patchBodies: unknown[] = [];
    // A property on an object, not a `let` — TS's control-flow analysis narrows a `let` that is
    // only ever assigned inside a callback down to `null`, which makes the call below a type error
    // (esbuild transpiles the test fine, so `tsc` is the only thing that catches it).
    const firstPatch: { release?: () => void } = {};
    const res = (body: unknown) =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      }) as Response;

    const quotation = baseQuotation();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/api/queries/q1/quotation") && init?.method === "PATCH") {
          patchBodies.push(JSON.parse(init.body as string));
          // Hold the FIRST PATCH's response open — that in-flight window IS the bug.
          if (patchBodies.length === 1) {
            return new Promise<Response>((resolve) => {
              firstPatch.release = () => resolve(res(quotation));
            });
          }
          return Promise.resolve(res(quotation));
        }
        if (url.endsWith("/api/queries/q1/quotation")) return Promise.resolve(res(quotation));
        if (url.endsWith("/api/queries/q1")) return Promise.resolve(res(QUERY_DETAIL));
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve("") } as Response);
      }),
    );
    renderWithProviders(
      <>
        <AuthProbe />
        <Routes>
          <Route path="/queries/:id/quotation" element={<QuotationPage />} />
        </Routes>
      </>,
      { route: "/queries/q1/quotation", user: { id: "u1", name: "Viewer", email: "v@x.com", role: "MANAGER" } },
    );

    await screen.findByText("MANAGER");
    await userEvent.click(await screen.findByRole("button", { name: /origin charges/i }));

    const first = within(screen.getByTestId("line-l1-ORIGIN:0")).getByRole("spinbutton");
    await userEvent.clear(first);
    await userEvent.type(first, "45");
    await userEvent.tab();
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ overrides: { "l1:ORIGIN:0": 45 } });

    // Second edit while the first request is STILL in flight — nothing has refreshed
    // `quotation.data.overrides`, which is still `{}`.
    const second = within(screen.getByTestId("line-l1-ORIGIN:1")).getByRole("spinbutton");
    await userEvent.clear(second);
    await userEvent.type(second, "33");
    await userEvent.tab();
    await waitFor(() => expect(patchBodies).toHaveLength(2));

    expect(patchBodies[1]).toEqual({ overrides: { "l1:ORIGIN:0": 45, "l1:ORIGIN:1": 33 } });

    firstPatch.release?.();
  });

  // S5.8 Task 6 end-to-end: preview → issue → the page itself flips to the read-only ISSUED view
  // with "Revise" in place of "Preview quotation" — the whole point of ambiguity resolution #3/#4.
  it("previews, issues, then renders read-only with Revise in place of Preview", async () => {
    const issueBodies: unknown[] = [];
    const issued = baseQuotation({
      status: "ISSUED",
      recipientEmail: "buyer@client.test",
      subject: "Quotation YAL26-0001-Q1 · Ref YAL26-0001",
      bodyText: "Dear Acme Ltd,\n\nTotal — all inclusive: USD 330.00\n\nRegards,\nYankalfa Logistics",
      issuedAt: "2026-08-19T00:00:00.000Z",
      issuedByUserId: "u1",
    });

    renderPage({
      queryDetail: { ...QUERY_DETAIL, contactEmail: "buyer@client.test" },
      onIssuePost: (b) => issueBodies.push(b),
      issueResponse: { status: 200, body: issued },
    });

    await screen.findByText("MANAGER");
    await userEvent.click(await screen.findByRole("button", { name: /preview quotation/i }));
    await screen.findByTestId("quotation-letter");
    expect(screen.getByLabelText("Recipient")).toHaveValue("buyer@client.test");

    await userEvent.click(screen.getByRole("button", { name: /issue quotation/i }));

    await waitFor(() => expect(issueBodies).toHaveLength(1));
    // S5.9.3 Task 1: the (unedited, prefilled) body is posted too now. S5.9.3 final review
    // IMPORTANT #1: so is `expectedUpdatedAt`, the server's freshness token, threaded end-to-end
    // from the quotation this page actually loaded.
    expect(issueBodies[0]).toEqual({
      recipientEmail: "buyer@client.test",
      subject: "Quotation YAL26-0001-Q1 · Ref YAL26-0001",
      bodyText: "Dear Acme Ltd,\n\nTotal — all inclusive: USD 330.00\n\nRegards,\nYankalfa Logistics",
      expectedUpdatedAt: "2026-08-14T00:00:00.000Z",
    });

    // The dialog closes and the page itself flips to the read-only ISSUED view.
    await waitFor(() => expect(screen.queryByTestId("quotation-letter")).not.toBeInTheDocument());
    expect(await screen.findByTestId("quotation-status-note")).toHaveTextContent(/issued/i);
    expect(screen.queryByRole("button", { name: /preview quotation/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^revise$/i })).toBeInTheDocument();

    // No margin input, no editable prices (ambiguity resolution #3) — plain text throughout.
    expect(screen.queryByLabelText(/margin %/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /origin charges/i }));
    expect(within(screen.getByTestId("line-l1-ORIGIN:0")).getByText("$66.00")).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("Revise on an ISSUED quotation starts a fresh, editable DRAFT", async () => {
    const revisePosts: number[] = [];
    const issued = baseQuotation({ status: "ISSUED", recipientEmail: "buyer@client.test" });
    const revised = baseQuotation({ status: "DRAFT", version: 2 });

    renderPage({
      quotation: issued,
      onRevisePost: () => revisePosts.push(1),
      reviseResponse: { status: 200, body: revised },
    });

    await screen.findByText("MANAGER");
    expect(await screen.findByTestId("quotation-status-note")).toHaveTextContent(/issued/i);
    expect(screen.queryByRole("button", { name: /preview quotation/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^revise$/i }));

    await waitFor(() => expect(revisePosts).toHaveLength(1));
    expect(await screen.findByRole("button", { name: /preview quotation/i })).toBeInTheDocument();
    expect(screen.queryByTestId("quotation-status-note")).not.toBeInTheDocument();
  });

  // 🔴 S5.9.3 final review, IMPORTANT #2. P5 merged Compare Quotes and this screen into one rail
  // step whose link prefers `/quotation` as soon as `quotationEnabled` is true — and
  // `/queries/:id/compare` is linked from nowhere else in the app, so from QUOTING_CLIENT onward
  // Compare Quotes became reachable only by typing its URL. That matters because
  // `QuotingClientPanel`'s "Reopen comparison" — the only control that undoes a frozen award —
  // lives on that screen and renders precisely at QUOTING_CLIENT+.
  //
  // Mutation proof: delete the `back-to-compare-link` block from `QuotationPage` and this reddens
  // on the second assertion. The FIRST assertion is what makes that meaningful rather than
  // vacuous — it proves the rail step really does resolve to this screen (so the rail genuinely
  // is not the way back), and it is unaffected by removing the link, so the two cannot both be
  // satisfied by one accidental cause.
  it("S5.9.3 final review (IMPORTANT #2) — links back to Compare Quotes, the only route there once the merged rail step resolves here", async () => {
    renderPage();
    await screen.findByText("MANAGER");
    await screen.findByTestId("quotation-page");

    const rail = screen.getByRole("navigation", { name: /query stages/i });
    expect(within(rail).getByRole("link", { name: /quotation/i })).toHaveAttribute(
      "href",
      "/queries/q1/quotation",
    );
    expect(within(rail).queryByRole("link", { name: /compare/i })).not.toBeInTheDocument();

    const back = screen.getByTestId("back-to-compare-link");
    expect(back).toHaveAttribute("href", "/queries/q1/compare");
    expect(back).toHaveAccessibleName(/compare quotes/i);
    // Discoverable, not merely present: it says what is on the other side, including the reopen.
    expect(back).toHaveAccessibleDescription(/reopen the comparison/i);
  });

  // 🔴 S5.9.3 final review, IMPORTANT #1 — the web half. The server refuses an issue whose
  // freshness token is stale; this asserts the client (a) sends the token the letter on screen
  // actually agrees with, and (b) treats the refusal as recoverable — `useIssueQuotation`
  // refetches on 409, which flows through the dialog's own re-seed logic and replaces the stale
  // letter with the current one, rather than leaving the manager re-posting the same doomed body.
  //
  // Mutation proof: drop the `if (... status === 409) invalidateQueries` arm from
  // `useIssueQuotation` and the "USD 375.00" assertion reddens (the box keeps showing 330.00).
  // Drop `expectedUpdatedAt` from `handleIssue` instead and the token assertion reddens. The two
  // cannot collapse into each other: the first is about the response path, the second the request.
  it("S5.9.3 final review (IMPORTANT #1) — a stale-pricing 409 explains itself and reloads the letter, instead of dead-ending on the stale one", async () => {
    const repriced = baseQuotation({
      marginPct: 25,
      previewBody:
        "Dear Acme Ltd,\n\nTotal — all inclusive: USD 375.00\n\nRegards,\nYankalfa Logistics",
      updatedAt: "2026-08-14T09:00:00.000Z",
    });
    const issueBodies: unknown[] = [];

    renderPage({
      queryDetail: { ...QUERY_DETAIL, contactEmail: "buyer@client.test" },
      onIssuePost: (b) => issueBodies.push(b),
      issueResponse: {
        status: 409,
        body: {
          message:
            "this quotation was repriced after you opened this preview — the letter has been " +
            "reloaded with the current total; check it before issuing",
        },
      },
      repricedByAnotherClientTo: repriced,
    });

    await screen.findByText("MANAGER");
    await userEvent.click(await screen.findByRole("button", { name: /preview quotation/i }));
    const letter = (await screen.findByTestId("quotation-letter")) as HTMLTextAreaElement;
    expect(letter.value).toContain("USD 330.00");

    await userEvent.click(screen.getByRole("button", { name: /issue quotation/i }));

    // The token sent is the one the letter on screen agreed with — which is exactly what lets the
    // server recognise it as stale.
    await waitFor(() => expect(issueBodies).toHaveLength(1));
    expect(issueBodies[0]).toMatchObject({ expectedUpdatedAt: "2026-08-14T00:00:00.000Z" });

    // The refusal is explained in the manager's own terms …
    expect(
      await screen.findByText(/repriced after you opened this preview/i),
    ).toBeInTheDocument();
    // … and recovered from: the 409's refetch puts the CURRENT letter in the box.
    await waitFor(() =>
      expect(
        (screen.getByTestId("quotation-letter") as HTMLTextAreaElement).value,
      ).toContain("USD 375.00"),
    );
    // Still open and still issuable — a conflict to resolve, not a wall.
    expect(screen.getByRole("button", { name: /issue quotation/i })).not.toBeDisabled();
  });
});
