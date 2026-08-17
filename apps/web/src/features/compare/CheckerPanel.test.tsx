import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { CheckerPanel } from "./CheckerPanel";
import { GenerateGate } from "./GenerateGate";

afterEach(() => vi.unstubAllGlobals());

// A leg sent for approval by "sender-1", shortlisted on the recommendation.
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

function renderChecker(
  leg: LegComparisonDto,
  viewer: { id: string; role: string },
  opts: {
    onApprovePost?: (body: unknown) => void;
    onRejectPost?: (body: unknown) => void;
    approveResponse?: { status: number; body?: unknown };
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith(`/api/queries/q1/legs/${leg.legId}/approve`) && init?.method === "POST") {
        opts.onApprovePost?.(init.body ? JSON.parse(init.body as string) : undefined);
        return opts.approveResponse ?? { status: 200, body: { legId: leg.legId, status: "APPROVED" } };
      }
      if (url.endsWith(`/api/queries/q1/legs/${leg.legId}/reject`) && init?.method === "POST") {
        const body = JSON.parse((init.body as string) ?? "{}") as unknown;
        opts.onRejectPost?.(body);
        return { status: 200, body: { legId: leg.legId, status: "REJECTED" } };
      }
      return { status: 404 };
    }),
  );
  return renderWithProviders(<CheckerPanel queryId="q1" leg={leg} />, {
    user: { id: viewer.id, name: "Viewer", email: "v@x.com", role: viewer.role },
  });
}

// `AuthProvider`'s `/api/auth/me` round trip is async — `useAuth()`'s `user` is `null` (so
// `CheckerPanel` renders nothing, its `canCheck` false regardless of the actual role) for one or
// more microtask hops after `render()` returns. An absence assertion taken synchronously, or via
// a `waitFor`/`queryBy*` callback that's ALREADY true on its first (synchronous) check, proves
// nothing: it would pass identically whether `CheckerPanel`'s role gate is correct OR completely
// inverted, since both states are "absent" before auth settles. `AuthProbe` renders a value that
// only exists once `AuthProvider` has actually resolved, so `await screen.findByText(...)` on it
// forces every assertion after it to run post-settle (review round 1, IMPORTANT #1).
function AuthProbe() {
  const { user, loading } = useAuth();
  return <span data-testid="auth-probe">{loading ? "loading" : (user?.role ?? "anonymous")}</span>;
}

function renderCheckerAfterAuthSettles(leg: LegComparisonDto, viewer: { id: string; role: string }) {
  vi.stubGlobal("fetch", mockFetch(() => ({ status: 404 })));
  renderWithProviders(
    <>
      <AuthProbe />
      <CheckerPanel queryId="q1" leg={leg} />
    </>,
    { user: { id: viewer.id, name: "Viewer", email: "v@x.com", role: viewer.role } },
  );
  return screen.findByText(viewer.role);
}

describe("CheckerPanel", () => {
  it("hides checker controls for an EXECUTIVE viewer", async () => {
    await renderCheckerAfterAuthSettles(PENDING_LEG, { id: "manager-1", role: "EXECUTIVE" });
    expect(screen.queryByTestId("checker-panel")).not.toBeInTheDocument();
  });

  it("shows Approve and Reject for a MANAGER viewer who isn't the sender", async () => {
    renderChecker(PENDING_LEG, { id: "manager-1", role: "MANAGER" });
    expect(await screen.findByRole("button", { name: /^approve$/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^reject$/i })).not.toBeDisabled();
  });

  it("shows Approve and Reject for an ADMINISTRATOR viewer too", async () => {
    renderChecker(PENDING_LEG, { id: "admin-1", role: "ADMINISTRATOR" });
    expect(await screen.findByRole("button", { name: /^approve$/i })).toBeInTheDocument();
  });

  it("renders nothing when the leg has no pending decision to check", async () => {
    // Same shape as the EXECUTIVE test above: with `decision: null` AND `user` still `null`
    // pre-settle, `checker-panel` is absent for the WRONG reason (no viewer yet) just as much as
    // the right one (no decision to check) — waiting for the MANAGER probe forces `canCheck` to
    // actually be `true` before this asserts absence, so it's really exercising
    // `hasPendingDecision`, not just re-proving the auth gate.
    await renderCheckerAfterAuthSettles({ ...PENDING_LEG, decision: null }, { id: "manager-1", role: "MANAGER" });
    expect(screen.queryByTestId("checker-panel")).not.toBeInTheDocument();
  });

  it("disables Approve and Reject with a four-eyes hint when the viewer sent this leg for approval", async () => {
    renderChecker(PENDING_LEG, { id: "sender-1", role: "MANAGER" });
    expect(await screen.findByRole("button", { name: /^approve$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeDisabled();
    expect(screen.getByText(/another manager must decide/i)).toBeInTheDocument();
  });

  it("Approve POSTs with no body", async () => {
    const calls: unknown[] = [];
    renderChecker(PENDING_LEG, { id: "manager-1", role: "MANAGER" }, { onApprovePost: (b) => calls.push(b) });

    await userEvent.click(await screen.findByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toBeUndefined();
  });

  it("surfaces a 403 SELF_APPROVAL from Approve inline", async () => {
    renderChecker(PENDING_LEG, { id: "manager-1", role: "MANAGER" }, {
      approveResponse: { status: 403, body: { message: "SELF_APPROVAL" } },
    });

    await userEvent.click(await screen.findByRole("button", { name: /^approve$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/SELF_APPROVAL/i);
  });

  it("blocks Reject and shows a visible error when the reason is left empty", async () => {
    const calls: unknown[] = [];
    renderChecker(PENDING_LEG, { id: "manager-1", role: "MANAGER" }, { onRejectPost: (b) => calls.push(b) });

    await userEvent.click(await screen.findByRole("button", { name: /^reject$/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("POSTs the reason on Reject", async () => {
    const calls: unknown[] = [];
    renderChecker(PENDING_LEG, { id: "manager-1", role: "MANAGER" }, { onRejectPost: (b) => calls.push(b) });

    await userEvent.type(await screen.findByLabelText(/rejection reason/i), "Price too high.");
    await userEvent.click(screen.getByRole("button", { name: /^reject$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ reason: "Price too high." });
  });
});

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
