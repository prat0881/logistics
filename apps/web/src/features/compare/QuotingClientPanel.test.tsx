import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import type { LegComparisonDto, QueryAwardSnapshot } from "@svyft/shared";
import { fetchJson } from "@/lib/api";
import { fmtUsd } from "./money";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { QuotingClientPanel } from "./QuotingClientPanel";

afterEach(() => vi.unstubAllGlobals());

// leg-1: the frozen winner (ff-1) was APPROVED by the time the snapshot exists, so
// comparison.service.ts's COMPARABLE_STATUSES excludes it from leg-1's OWN offers/
// pendingForwarders (see award.service.ts's generateClientQuote doc comment) — its name is only
// recoverable because ff-1 also appears (as a still-pending forwarder) on leg-2 below. leg-2's
// winner (ff-3) never appears anywhere in the live comparison at all, proving the graceful-degrade
// fallback.
const LEGS: LegComparisonDto[] = [
  {
    legId: "leg-1",
    legCode: "LEG-1",
    mode: "ROAD",
    origin: "Chennai",
    destination: "Mumbai",
    offers: [
      {
        quoteId: "quote-losing",
        freightForwarderId: "ff-2",
        freightForwarderName: "Globex Logistics",
        variant: "DEDICATED",
        variantLabel: "Dedicated",
        priced: true,
        nativeTotal: 42000,
        currency: "INR",
        unitsPerUsd: 83,
        usdTotal: 506.02,
        transitDays: 4,
        chargeableWeightKg: 500,
        validUntil: null,
        quoteStatus: "QUOTED",
        charges: [],
      },
    ],
    pendingForwarders: [],
    awaitingReQuote: false,
    recommendation: null,
    decision: {
      legId: "leg-1",
      status: "APPROVED",
      shortlistedQuoteId: "quote-1",
      shortlistedVariant: "DEDICATED",
      recommendedQuoteId: "quote-1",
      recommendedVariant: "DEDICATED",
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: "u1",
      sentForApprovalAt: "2026-08-14T09:00:00.000Z",
      decidedByUserId: "u2",
      decidedAt: "2026-08-14T10:00:00.000Z",
    },
    timeline: [],
  },
  {
    legId: "leg-2",
    legCode: "LEG-2",
    mode: "SEA",
    origin: "Mumbai",
    destination: "Rotterdam",
    offers: [],
    pendingForwarders: [{ freightForwarderId: "ff-1", freightForwarderName: "TCI Freight", quoteStatus: "RFQ_SENT" }],
    awaitingReQuote: false,
    recommendation: null,
    decision: null,
    timeline: [],
  },
];

const SNAPSHOT: QueryAwardSnapshot = {
  generatedByUserId: "u2",
  legs: [
    {
      legId: "leg-1",
      winningQuoteId: "quote-1",
      freightForwarderId: "ff-1",
      variant: "DEDICATED",
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 542.17,
      nativeTotal: 45000,
      transitDays: 3,
    },
    {
      legId: "leg-2",
      winningQuoteId: "quote-9",
      freightForwarderId: "ff-3",
      variant: "FCL",
      currency: "USD",
      unitsPerUsd: 1,
      usdTotal: 2100,
      nativeTotal: 2100,
      transitDays: 21,
    },
  ],
  combinedUsd: 2642.17,
};

// Mounted alongside the panel so the ["comparison", queryId]/["query", queryId] keys have an
// active observer — invalidateQueries only refetches ACTIVE queries by default, so without a
// live subscriber here, a bare call to qc.invalidateQueries would be a silent no-op and this test
// would prove nothing about the hook's onSuccess behaviour.
function Probes({ queryId }: { queryId: string }) {
  useQuery({
    queryKey: ["comparison", queryId],
    queryFn: () => fetchJson(`/api/queries/${queryId}/comparison`),
  });
  useQuery({ queryKey: ["query", queryId], queryFn: () => fetchJson(`/api/queries/${queryId}`) });
  return null;
}

function renderPanel(opts: { reopenResponse?: { status: number; body?: unknown } } = {}) {
  const calls = { comparison: 0, query: 0, reopen: 0 };
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/reopen-comparison") && init?.method === "POST") {
        calls.reopen++;
        return opts.reopenResponse ?? { status: 200, body: {} };
      }
      if (url.endsWith("/api/queries/q1/comparison")) {
        calls.comparison++;
        return { status: 200, body: { queryId: "q1", priority: "MEDIUM", fxAsOf: null, legs: [], awardSnapshot: null } };
      }
      if (url.endsWith("/api/queries/q1")) {
        calls.query++;
        return { status: 200, body: { id: "q1" } };
      }
      return { status: 404 };
    }),
  );
  const result = renderWithProviders(
    <>
      <Probes queryId="q1" />
      <QuotingClientPanel queryId="q1" snapshot={SNAPSHOT} legs={LEGS} fxAsOf="2026-08-14T00:00:00.000Z" />
    </>,
    { user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } },
  );
  return { ...result, calls };
}

describe("QuotingClientPanel", () => {
  it("renders each leg's frozen winner (FF + variant + USD) and the combined USD total", async () => {
    renderPanel();

    // leg-1's winner (ff-1) is resolved via leg-2's pendingForwarders entry, cross-leg.
    expect(await screen.findByText(/TCI Freight — Dedicated/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(fmtUsd(542.17).replace("$", "\\$")))).toBeInTheDocument();
    expect(screen.getByText(/3 days/)).toBeInTheDocument();

    // leg-2's winner (ff-3) is nowhere in the live comparison — degrades, doesn't crash.
    expect(screen.getByText(/Unknown forwarder — FCL/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(fmtUsd(2100).replace("$", "\\$")))).toBeInTheDocument();

    expect(screen.getByText(fmtUsd(SNAPSHOT.combinedUsd))).toBeInTheDocument();
    expect(screen.getByText(/LEG-1/)).toBeInTheDocument();
    expect(screen.getByText(/LEG-2/)).toBeInTheDocument();
  });

  it("posts reopen-comparison with no body and refreshes the comparison + query reads", async () => {
    const { calls } = renderPanel();

    await waitFor(() => expect(calls.comparison).toBeGreaterThan(0));
    await waitFor(() => expect(calls.query).toBeGreaterThan(0));
    const before = { comparison: calls.comparison, query: calls.query };

    await userEvent.click(screen.getByRole("button", { name: /reopen comparison/i }));

    await waitFor(() => expect(calls.reopen).toBe(1));
    await waitFor(() => expect(calls.comparison).toBeGreaterThan(before.comparison));
    await waitFor(() => expect(calls.query).toBeGreaterThan(before.query));
  });

  it("shows an inline error when reopen fails, without crashing", async () => {
    renderPanel({ reopenResponse: { status: 500, body: { message: "boom" } } });

    await userEvent.click(screen.getByRole("button", { name: /reopen comparison/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);
  });
});
