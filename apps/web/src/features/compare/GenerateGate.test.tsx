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
// below is untouched by this task and stays here. Review round (Minor) — renamed from
// `CheckerPanel.test.tsx` (via `git mv`, history preserved) once nothing `CheckerPanel`-shaped was
// left in it; this file's own name now matches what it actually tests.
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

  // ── S5.9.2 T4 (#5, PO ruling) — "Remove the box … just keep the button after all legs on the
  // right hand side." The bordered card + heading is gone; the readiness note must still be
  // reachable, but as text next to a right-aligned button, not inside a box with its own heading.
  it("renders no heading and no bordered card — just the button and its readiness note", () => {
    renderGate([APPROVED_LEG, PENDING_LEG]);
    // The card used to carry an uppercase h3 heading with this exact copy; the button now carries
    // the only occurrence of this text, as its own accessible name.
    expect(screen.queryByRole("heading", { name: /generate quotation/i })).not.toBeInTheDocument();
    const gate = screen.getByTestId("generate-gate");
    expect(gate.className).not.toMatch(/\bborder\b/);
    expect(gate.className).not.toMatch(/\brounded-lg\b/);
  });

  it("right-aligns the button after the legs", () => {
    renderGate([APPROVED_LEG, PENDING_LEG]);
    const gate = screen.getByTestId("generate-gate");
    // Justified to the end (right, in LTR) rather than left-aligned inside a full-width card.
    expect(gate.className).toMatch(/items-end|justify-end/);
  });

  it("keeps the readiness reason reachable as the disabled button's accessible description", () => {
    renderGate([APPROVED_LEG, PENDING_LEG]);
    // RTL's accessible-description matching resolves aria-describedby for us — this fails if the
    // reason text is removed OR if it stops being wired to the button via aria-describedby.
    const btn = screen.getByRole("button", { name: /generate quotation/i, description: /1 of 2/i });
    expect(btn).toBeDisabled();
  });

  it("surfaces the inline error when the generate call fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/queries/q1/generate-client-quote") && init?.method === "POST") {
          return { status: 409, body: { message: "Not every leg is approved yet." } };
        }
        return { status: 404 };
      }),
    );
    renderWithProviders(<GenerateGate queryId="q1" legs={[APPROVED_LEG, OTHER_APPROVED_LEG]} />);

    await userEvent.click(screen.getByRole("button", { name: /generate quotation/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Not every leg is approved yet.");
  });
});
