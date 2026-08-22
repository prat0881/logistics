import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto } from "@svyft/shared";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { GenerateGate } from "./GenerateGate";

afterEach(() => vi.unstubAllGlobals());

// `CheckerPanel` itself is deleted (S5.9.1 Task 2) — the standalone Approve/Reject panel it used to
// render is absorbed into `CompareLegPanel`'s own action bar (`ApproveDialog`/`RejectDialog`), so
// there is nothing left here for a dedicated component to own; see `CompareLegPanel.tsx`'s doc
// comment for the judgement call and why. Its four-eyes and role-gating coverage is NOT deleted —
// it is ported, one test for one test, into `ComparisonGrid.test.tsx`'s "Checker action bar" describe
// block, which renders the same `CompareLegPanel` shell every other action-bar test in that file
// already goes through (Negotiate, Send for approval), rather than a bespoke render helper here.
// `GenerateGate` is a genuinely separate, query-level component (S5.6 Task 5, design §16 O4) that
// happened to share this file with `CheckerPanel` since it was first written — its own coverage
// below is untouched by this task and stays here.
const PENDING_LEG: LegComparisonDto = {
  legId: "leg-1",
  legCode: "LEG-1",
  mode: "ROAD",
  origin: "Chennai",
  destination: "Mumbai",
  offers: [],
  pendingForwarders: [],
  awaitingReQuote: false,
  recommendation: { quoteId: "quote-1", variant: "DEDICATED", reason: "Fastest transit." },
  decision: {
    legId: "leg-1",
    status: "PENDING_APPROVAL",
    shortlistedQuoteId: "quote-1",
    shortlistedVariant: "DEDICATED",
    recommendedQuoteId: "quote-1",
    recommendedVariant: "DEDICATED",
    overrideReason: null,
    rejectionReason: null,
    sentByUserId: "sender-1",
    sentForApprovalAt: "2026-08-14T09:00:00.000Z",
    decidedByUserId: null,
    decidedAt: null,
  },
  timeline: [],
};

describe("GenerateGate", () => {
  const APPROVED_LEG: LegComparisonDto = {
    ...PENDING_LEG,
    legId: "leg-1",
    decision: { ...PENDING_LEG.decision!, status: "APPROVED" },
  };
  const OTHER_APPROVED_LEG: LegComparisonDto = {
    ...PENDING_LEG,
    legId: "leg-2",
    legCode: "LEG-2",
    decision: { ...PENDING_LEG.decision!, legId: "leg-2", status: "APPROVED" },
  };

  function renderGate(legs: LegComparisonDto[], opts: { onGeneratePost?: () => void } = {}) {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/queries/q1/generate-client-quote") && init?.method === "POST") {
          opts.onGeneratePost?.();
          return { status: 200, body: {} };
        }
        return { status: 404 };
      }),
    );
    return renderWithProviders(<GenerateGate queryId="q1" legs={legs} />);
  }

  it("disables Generate until every leg is APPROVED", () => {
    renderGate([APPROVED_LEG, PENDING_LEG]);
    expect(screen.getByRole("button", { name: /generate quotation/i })).toBeDisabled();
    expect(screen.getByText(/1 of 2/i)).toBeInTheDocument();
  });

  it("enables Generate once every leg is APPROVED, and POSTs on click", async () => {
    const calls: unknown[] = [];
    renderGate([APPROVED_LEG, OTHER_APPROVED_LEG], { onGeneratePost: () => calls.push(true) });

    const btn = screen.getByRole("button", { name: /generate quotation/i });
    expect(btn).not.toBeDisabled();

    await userEvent.click(btn);
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("stays disabled when there are no legs at all", () => {
    renderGate([]);
    expect(screen.getByRole("button", { name: /generate quotation/i })).toBeDisabled();
  });
});
