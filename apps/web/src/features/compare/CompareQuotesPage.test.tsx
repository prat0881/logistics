import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { CompareQuotesPage } from "./CompareQuotesPage";

afterEach(() => vi.unstubAllGlobals());

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
});
