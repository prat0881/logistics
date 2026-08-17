import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthProvider";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { CompareQuotesPage } from "./CompareQuotesPage";

afterEach(() => vi.unstubAllGlobals());

/** `AuthProvider`'s `/api/auth/me` round trip is async, so `useAuth()`'s `user` is `null` for one
 *  or more microtask hops after `render()`. Any absence assertion taken before it settles proves
 *  nothing about a role-aware gate — `CheckerPanel` self-hides and `GenerateGate` is parent-gated
 *  on `canCheck`, both of which are false for an anonymous viewer regardless of `locked`. Awaiting
 *  this probe's resolved role forces the assertions to run post-settle (same mechanism as
 *  `CheckerPanel.test.tsx`; final review M3). */
function AuthProbe() {
  const { user, loading } = useAuth();
  return <span data-testid="auth-probe">{loading ? "loading" : (user?.role ?? "anonymous")}</span>;
}

const QUERY_DETAIL = {
  id: "q1",
  queryCode: "YAL26-0001",
  status: "QUOTED",
  incoterms: "FOB",
  freightMode: [],
  origin: [],
  destination: [],
  cargos: [],
  points: [],
  legs: [],
};

const COMPARISON = {
  queryId: "q1",
  priority: "MEDIUM",
  fxAsOf: "2026-08-14T00:00:00.000Z",
  awardSnapshot: null,
  forwarderNames: { ff1: "TCI Freight", ff2: "CMA CGM", ff3: "Maersk" },
  legs: [
    {
      legId: "l1",
      legCode: "LEG-1",
      mode: "ROAD",
      origin: "Chennai",
      destination: "Mumbai",
      offers: [
        {
          quoteId: "quote-1",
          freightForwarderId: "ff1",
          freightForwarderName: "TCI Freight",
          variant: "DEDICATED",
          variantLabel: "Dedicated",
          priced: true,
          nativeTotal: 45000,
          currency: "INR",
          unitsPerUsd: 83.1,
          usdTotal: 541.52,
          transitDays: 3,
          chargeableWeightKg: 500,
          validUntil: "2026-08-20T00:00:00.000Z",
          quoteStatus: "QUOTED",
          charges: [],
        },
      ],
      pendingForwarders: [],
      awaitingReQuote: false,
      recommendation: null,
      decision: null,
      timeline: [],
    },
    {
      legId: "l2",
      legCode: "LEG-2",
      mode: "SEA",
      origin: "Mumbai",
      destination: "Rotterdam",
      offers: [
        {
          quoteId: "quote-2",
          freightForwarderId: "ff2",
          freightForwarderName: "CMA CGM",
          variant: "FCL",
          variantLabel: "FCL",
          priced: true,
          nativeTotal: 2200,
          currency: "USD",
          unitsPerUsd: 1,
          usdTotal: 2200,
          transitDays: 21,
          chargeableWeightKg: 8000,
          validUntil: "2026-08-20T00:00:00.000Z",
          quoteStatus: "QUOTED",
          charges: [],
        },
        {
          quoteId: "quote-3",
          freightForwarderId: "ff3",
          freightForwarderName: "Maersk",
          variant: "FCL",
          variantLabel: "FCL",
          priced: true,
          nativeTotal: 2100,
          currency: "USD",
          unitsPerUsd: 1,
          usdTotal: 2100,
          transitDays: 24,
          chargeableWeightKg: 8000,
          validUntil: "2026-08-20T00:00:00.000Z",
          quoteStatus: "QUOTED",
          charges: [],
        },
      ],
      pendingForwarders: [],
      awaitingReQuote: false,
      recommendation: { quoteId: "quote-3", variant: "FCL", reason: "Lowest price." },
      decision: {
        legId: "l2",
        status: "PENDING_APPROVAL",
        shortlistedQuoteId: "quote-3",
        shortlistedVariant: "FCL",
        recommendedQuoteId: "quote-3",
        recommendedVariant: "FCL",
        overrideReason: null,
        rejectionReason: null,
        sentByUserId: "u1",
        sentForApprovalAt: "2026-08-14T09:00:00.000Z",
        decidedByUserId: null,
        decidedAt: null,
      },
      timeline: [
        {
          id: "ev1",
          legId: "l2",
          type: "SHORTLIST",
          quoteId: "quote-3",
          variant: "FCL",
          reason: null,
          actorId: "u1",
          at: "2026-08-14T08:00:00.000Z",
        },
      ],
    },
  ],
};

function renderPage() {
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/queries/q1")) return { status: 200, body: QUERY_DETAIL };
      if (url.endsWith("/api/queries/q1/comparison")) return { status: 200, body: COMPARISON };
      return { status: 404 };
    }),
  );
  return renderWithProviders(
    <Routes>
      <Route path="/queries/:id/compare" element={<CompareQuotesPage />} />
    </Routes>,
    {
      route: "/queries/q1/compare",
      user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" },
    },
  );
}

describe("CompareQuotesPage", () => {
  it("renders the query header, a collapsed panel per comparison leg, and the Quotes stage as active", async () => {
    renderPage();

    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();

    // One collapsed leg card per comparison leg — bodies not rendered until opened.
    expect(await screen.findByRole("button", { name: /LEG-1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /LEG-2/i })).toBeInTheDocument();
    expect(screen.queryByTestId("leg-body")).not.toBeInTheDocument();

    // StageRail highlights "Quotes" as the current, navigable step (status QUOTED enables it).
    const quotesLink = screen.getByRole("link", { name: /quotes/i });
    expect(quotesLink).toHaveAttribute("aria-current", "step");
    expect(quotesLink).toHaveAttribute("href", "/queries/q1/compare");
  });

  it("opens a leg's body on header click, and keeps the accordion single-open", async () => {
    renderPage();
    const leg1 = await screen.findByRole("button", { name: /LEG-1/i });

    await userEvent.click(leg1);
    expect(await screen.findByTestId("leg-body")).toHaveTextContent("1 offer");

    // Opening LEG-2 closes LEG-1's body — only one body renders at a time.
    await userEvent.click(screen.getByRole("button", { name: /LEG-2/i }));
    await waitFor(() => expect(screen.getByTestId("leg-body")).toHaveTextContent("2 offers"));
    expect(screen.getAllByTestId("leg-body")).toHaveLength(1);
  });

  it("locks maker/checker/generate controls and shows QuotingClientPanel once the award snapshot is present (S5.6 Task 6)", async () => {
    // LEG-2's decision is already PENDING_APPROVAL (see COMPARISON above) — for a MANAGER viewer
    // that would normally mount CheckerPanel's Approve/Reject (CheckerPanel.test.tsx pins exactly
    // this). Proving it's absent here — under an award snapshot — is therefore exercising the
    // `locked` gate itself, not just "nothing to check" or "wrong role".
    const comparisonLocked = {
      ...COMPARISON,
      awardSnapshot: {
        generatedByUserId: "u2",
        legs: [
          {
            legId: "l1",
            winningQuoteId: "quote-1",
            freightForwarderId: "ff1",
            variant: "DEDICATED",
            currency: "INR",
            unitsPerUsd: 83.1,
            usdTotal: 541.52,
            nativeTotal: 45000,
            transitDays: 3,
          },
          {
            legId: "l2",
            winningQuoteId: "quote-3",
            freightForwarderId: "ff3",
            variant: "FCL",
            currency: "USD",
            unitsPerUsd: 1,
            usdTotal: 2100,
            nativeTotal: 2100,
            transitDays: 24,
          },
        ],
        combinedUsd: 2641.52,
      },
    };
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/queries/q1")) return { status: 200, body: { ...QUERY_DETAIL, status: "QUOTING_CLIENT" } };
        if (url.endsWith("/api/queries/q1/comparison")) return { status: 200, body: comparisonLocked };
        return { status: 404 };
      }),
    );
    renderWithProviders(
      <>
        <AuthProbe />
        <Routes>
          <Route path="/queries/:id/compare" element={<CompareQuotesPage />} />
        </Routes>
      </>,
      {
        route: "/queries/q1/compare",
        user: { id: "u1", name: "Mgr", email: "m@x.com", role: "MANAGER" },
      },
    );

    const leg2 = await screen.findByRole("button", { name: /LEG-2/i });
    await userEvent.click(leg2);
    await screen.findByTestId("leg-body");
    // Without this, `checker-panel`/`generate-gate` would be absent for the WRONG reason (no
    // viewer yet ⇒ `canCheck` false) and the assertions below would pass even with `locked`
    // inverted — final review M3.
    await screen.findByText("MANAGER");

    expect(screen.queryByTestId("maker-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("checker-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("generate-gate")).not.toBeInTheDocument();
    expect(await screen.findByTestId("quoting-client-panel")).toBeInTheDocument();
  });
});
