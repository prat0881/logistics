import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto } from "@svyft/shared";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { MakerPanel } from "./MakerPanel";

afterEach(() => vi.unstubAllGlobals());

// A fresh leg (no decision yet) — two priced offers, TCI Freight is the recommendation.
const LEG: LegComparisonDto = {
  legId: "leg-1",
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
      unitsPerUsd: 83,
      usdTotal: 542.17,
      transitDays: 3,
      chargeableWeightKg: 500,
      validUntil: "2026-08-25T12:00:00.000Z",
      quoteStatus: "QUOTED",
      charges: [],
    },
    {
      quoteId: "quote-2",
      freightForwarderId: "ff2",
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
      validUntil: "2026-08-22T12:00:00.000Z",
      quoteStatus: "QUOTED",
      charges: [],
    },
  ],
  pendingForwarders: [],
  awaitingReQuote: false,
  recommendation: { quoteId: "quote-1", variant: "DEDICATED", reason: "Fastest transit." },
  decision: null,
  timeline: [],
};

// A leg already sent for approval, shortlisted on the recommendation.
const PENDING_LEG: LegComparisonDto = {
  ...LEG,
  legId: "leg-2",
  legCode: "LEG-2",
  decision: {
    legId: "leg-2",
    status: "PENDING_APPROVAL",
    shortlistedQuoteId: "quote-1",
    shortlistedVariant: "DEDICATED",
    recommendedQuoteId: "quote-1",
    recommendedVariant: "DEDICATED",
    overrideReason: null,
    rejectionReason: null,
    sentByUserId: "u1",
    sentForApprovalAt: "2026-08-14T09:00:00.000Z",
    decidedByUserId: null,
    decidedAt: null,
  },
};

/**
 * The same leg with its CURRENT pick already persisted as a DRAFT shortlist. Send for approval is
 * only legitimate in this state: the endpoint carries no offer identity, so the server sends
 * whatever `legAwardDecision.shortlistedQuoteId` holds — sending while the UI shows anything else
 * awards the wrong forwarder silently (final review C1).
 */
function withSavedShortlist(
  leg: LegComparisonDto,
  quoteId: string,
  variant: LegComparisonDto["offers"][number]["variant"],
): LegComparisonDto {
  return {
    ...leg,
    decision: {
      legId: leg.legId,
      status: "DRAFT",
      shortlistedQuoteId: quoteId,
      shortlistedVariant: variant,
      recommendedQuoteId: leg.recommendation?.quoteId ?? null,
      recommendedVariant: leg.recommendation?.variant ?? null,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: null,
      sentForApprovalAt: null,
      decidedByUserId: null,
      decidedAt: null,
    },
  };
}

// LEG, shortlisted on the recommendation (quote-1/DEDICATED) — the consistent, sendable state.
const SAVED_LEG = withSavedShortlist(LEG, "quote-1", "DEDICATED");

// A leg with an in-flight re-quote (A9 "proceed without waiting" path). Shortlisted on the
// still-QUOTED offer so the A9 confirm is the ONLY thing gating Send.
const AWAITING_LEG: LegComparisonDto = withSavedShortlist(
  {
    ...LEG,
    legId: "leg-3",
    legCode: "LEG-3",
    awaitingReQuote: true,
    offers: [LEG.offers[0], { ...LEG.offers[1], quoteStatus: "REQUOTED" }],
  },
  "quote-1",
  "DEDICATED",
);

/** Mirrors how `CompareLegPanel` will own the lifted shortlist-selection channel — MakerPanel
 *  itself never owns this piece of state (single source of truth lives in the parent). */
function Harness({ leg }: { leg: LegComparisonDto }) {
  const [shortlistKey, setShortlistKey] = useState<string | undefined>(undefined);
  return (
    <MakerPanel
      queryId="q1"
      leg={leg}
      shortlistKey={shortlistKey}
      onShortlistKeyChange={setShortlistKey}
    />
  );
}

function renderMaker(
  leg: LegComparisonDto,
  opts: {
    onShortlistPut?: (body: unknown) => void;
    sendResponse?: { status: number; body?: unknown };
    onSendPost?: (body: unknown) => void;
    onRequotePost?: (quoteId: string, body: unknown) => void;
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith(`/api/queries/q1/legs/${leg.legId}/shortlist`) && init?.method === "PUT") {
        const body = JSON.parse((init.body as string) ?? "{}") as unknown;
        opts.onShortlistPut?.(body);
        return { status: 200, body: { legId: leg.legId, status: "DRAFT", ...(body as object) } };
      }
      if (
        url.endsWith(`/api/queries/q1/legs/${leg.legId}/send-for-approval`) &&
        init?.method === "POST"
      ) {
        const body = JSON.parse((init.body as string) ?? "{}") as unknown;
        opts.onSendPost?.(body);
        return opts.sendResponse ?? { status: 200, body: { legId: leg.legId, status: "PENDING_APPROVAL" } };
      }
      const requoteMatch = url.match(
        new RegExp(`/api/queries/q1/legs/${leg.legId}/quotes/([^/]+)/request-requote$`),
      );
      if (requoteMatch && init?.method === "POST") {
        const body = JSON.parse((init.body as string) ?? "{}") as unknown;
        opts.onRequotePost?.(requoteMatch[1], body);
        return { status: 200, body: { id: requoteMatch[1], status: "REQUOTED" } };
      }
      return { status: 404 };
    }),
  );
  return renderWithProviders(<Harness leg={leg} />, {
    user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" },
  });
}

describe("MakerPanel", () => {
  it("pre-selects the recommended offer and shows no override-reason field for it", () => {
    renderMaker(LEG);

    expect(screen.getByRole("radio", { name: /TCI Freight/i, checked: true })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Globex Logistics/i, checked: false }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/override reason/i)).not.toBeInTheDocument();
  });

  it("requires an override reason for a non-recommended pick and blocks Shortlist until one is entered", async () => {
    renderMaker(LEG);

    await userEvent.click(screen.getByRole("radio", { name: /Globex Logistics/i }));

    const overrideField = screen.getByLabelText(/override reason/i);
    expect(overrideField).toBeInTheDocument();

    const shortlistButton = screen.getByRole("button", { name: /^shortlist$/i });
    expect(shortlistButton).toBeDisabled();

    await userEvent.type(overrideField, "Cheaper and still within the transit window.");
    expect(shortlistButton).not.toBeDisabled();
  });

  it("PUTs the exact {quoteId, variant, overrideReason} body on Shortlist", async () => {
    const calls: unknown[] = [];
    renderMaker(LEG, { onShortlistPut: (body) => calls.push(body) });

    await userEvent.click(screen.getByRole("radio", { name: /Globex Logistics/i }));
    await userEvent.type(
      screen.getByLabelText(/override reason/i),
      "Cheaper and still within the transit window.",
    );
    await userEvent.click(screen.getByRole("button", { name: /^shortlist$/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      quoteId: "quote-2",
      variant: "DEDICATED",
      overrideReason: "Cheaper and still within the transit window.",
    });
  });

  it("PUTs {quoteId, variant} with no overrideReason when the pick equals the recommendation", async () => {
    const calls: unknown[] = [];
    renderMaker(LEG, { onShortlistPut: (body) => calls.push(body) });

    // TCI Freight (quote-1/DEDICATED) is both the default selection and the recommendation — no
    // override textarea should ever appear, and Shortlist should already be enabled.
    expect(screen.queryByLabelText(/override reason/i)).not.toBeInTheDocument();
    const shortlistButton = screen.getByRole("button", { name: /^shortlist$/i });
    expect(shortlistButton).not.toBeDisabled();

    await userEvent.click(shortlistButton);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ quoteId: "quote-1", variant: "DEDICATED" });
    expect(calls[0]).not.toHaveProperty("overrideReason");
  });

  it("posts an empty body on Send for approval when nothing is awaiting a re-quote", async () => {
    const calls: unknown[] = [];
    renderMaker(SAVED_LEG, { onSendPost: (body) => calls.push(body) });

    const sendButton = screen.getByRole("button", { name: /send for approval/i });
    expect(sendButton).not.toBeDisabled();
    await userEvent.click(sendButton);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({});
  });

  it("disables Send for approval once the decision is already pending approval", () => {
    renderMaker(PENDING_LEG);

    const sendButton = screen.getByRole("button", { name: /sent for approval/i });
    expect(sendButton).toBeDisabled();
  });

  // ── final review C1 — the send endpoint carries no offer identity ──────────────────────────
  it("blocks Send for approval when nothing has been shortlisted yet (would be a guaranteed 400)", async () => {
    const calls: unknown[] = [];
    renderMaker(LEG, { onSendPost: (body) => calls.push(body) });

    // LEG has no decision — the radio still PRE-SELECTS the recommendation, which is exactly what
    // used to make Send look actionable.
    expect(screen.getByRole("radio", { name: /TCI Freight/i, checked: true })).toBeInTheDocument();

    const sendButton = screen.getByRole("button", { name: /send for approval/i });
    expect(sendButton).toBeDisabled();
    expect(screen.getByTestId("unsaved-pick-note")).toHaveTextContent(/press shortlist above/i);

    await userEvent.click(sendButton);
    expect(calls).toHaveLength(0);
  });

  it("blocks Send for approval while the pick has moved off the saved shortlist without being re-saved", async () => {
    const calls: unknown[] = [];
    renderMaker(SAVED_LEG, { onSendPost: (body) => calls.push(body) });

    // Consistent to start with: saved shortlist === current pick.
    const sendButton = screen.getByRole("button", { name: /send for approval/i });
    expect(sendButton).not.toBeDisabled();

    // Moving the pick (the same lifted channel a ComparisonGrid header click writes to — see
    // CompareLegPanel.handleSelectOffer) without pressing Shortlist would otherwise send the
    // PERSISTED offer while the screen shows this one.
    await userEvent.click(screen.getByRole("radio", { name: /Globex Logistics/i }));
    expect(sendButton).toBeDisabled();
    expect(screen.getByTestId("unsaved-pick-note")).toHaveTextContent(/not the one saved/i);

    await userEvent.click(sendButton);
    expect(calls).toHaveLength(0);

    // Back on the saved offer it re-enables — the guard tracks the pick, it isn't a one-way latch.
    await userEvent.click(screen.getByRole("radio", { name: /TCI Freight/i }));
    expect(sendButton).not.toBeDisabled();
  });

  // ── final review I1 — post-reopen guidance ────────────────────────────────────────────────
  it("tells an APPROVED leg its shortlist is final instead of pointing at reject/reopen", () => {
    renderMaker({
      ...SAVED_LEG,
      decision: { ...SAVED_LEG.decision!, status: "APPROVED" },
    });

    expect(screen.getByText(/its shortlist is final here/i)).toBeInTheDocument();
    // Neither route exists for an APPROVED decision: reject 409s (requireDecidable) and reopen
    // only clears the query's snapshot, leaving every leg APPROVED.
    expect(screen.queryByText(/reject or reopen/i)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /TCI Freight/i })).toBeDisabled();
  });

  it("keeps the recoverable wording for a leg that is only pending approval", () => {
    renderMaker(PENDING_LEG);

    expect(screen.getByText(/a checker has to reject it/i)).toBeInTheDocument();
    expect(screen.queryByText(/its shortlist is final here/i)).not.toBeInTheDocument();
  });

  // ── final review I2 — the rejection reason had no home in the UI ──────────────────────────
  it("surfaces the checker's rejection reason on the DRAFT decision it comes back as", () => {
    renderMaker({
      ...SAVED_LEG,
      decision: { ...SAVED_LEG.decision!, rejectionReason: "Transit too slow for this client." },
    });

    expect(screen.getByTestId("rejection-notice")).toHaveTextContent(
      "Transit too slow for this client.",
    );
    // Still editable — reject() writes DRAFT, so the maker can re-pick and re-send.
    expect(screen.getByRole("radio", { name: /TCI Freight/i })).not.toBeDisabled();
  });

  // ── final review M2 — a stale offer is shortlistable, so say so ───────────────────────────
  it("marks a REQUOTED offer as stale in the shortlist radio", () => {
    renderMaker(AWAITING_LEG);

    expect(
      screen.getByRole("radio", { name: /Globex Logistics.*Re-quote requested/i }),
    ).toBeInTheDocument();
    // The still-QUOTED offer is not marked.
    expect(
      screen.queryByRole("radio", { name: /TCI Freight.*Re-quote requested/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a 409 from Send for approval inline", async () => {
    renderMaker(SAVED_LEG, {
      sendResponse: { status: 409, body: { message: "This leg is not pending approval" } },
    });

    await userEvent.click(screen.getByRole("button", { name: /send for approval/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not pending approval/i);
  });

  it("Negotiate opens the dialog and POSTs {comment} to the FF's quote", async () => {
    const calls: { quoteId: string; body: unknown }[] = [];
    renderMaker(LEG, {
      onRequotePost: (quoteId, body) => calls.push({ quoteId, body }),
    });

    await userEvent.click(screen.getByRole("button", { name: /negotiate.*tci freight/i }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText(/comment/i),
      "Can you sharpen the price by 5%?",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /request re-quote/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      quoteId: "quote-1",
      body: { comment: "Can you sharpen the price by 5%?" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps Negotiate's Cancel disabled and refuses to close while the request is pending", async () => {
    // A deferred (manually-resolved) response, so we can assert mid-flight state — the plain
    // `mockFetch` helper always resolves on the next microtask, too fast to observe `isPending`.
    let resolveRequote: ((value: { status: number; body?: unknown }) => void) | undefined;
    const pending = new Promise<{ status: number; body?: unknown }>((resolve) => {
      resolveRequote = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/api/queries/q1/legs/leg-1/quotes/quote-1/request-requote")) {
          return pending.then(({ status, body }) => ({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(body ?? {}),
            text: () => Promise.resolve(JSON.stringify(body ?? {})),
          }));
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
        });
      }),
    );
    renderWithProviders(<Harness leg={LEG} />, {
      user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" },
    });

    await userEvent.click(screen.getByRole("button", { name: /negotiate.*tci freight/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/comment/i), "Please revise.");
    await userEvent.click(within(dialog).getByRole("button", { name: /request re-quote/i }));

    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: /cancel/i })).toBeDisabled(),
    );

    // Neither a (disabled, no-op) Cancel click nor Escape may close the dialog mid-request.
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /cancel/i }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Resolving lets it close normally — proves this isn't just permanently stuck.
    resolveRequote?.({ status: 200, body: { id: "quote-1", status: "REQUOTED" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("A9: requires an explicit proceed-without-waiting confirm + reason when the leg is awaiting a re-quote", async () => {
    const calls: unknown[] = [];
    renderMaker(AWAITING_LEG, { onSendPost: (body) => calls.push(body) });

    const sendButton = screen.getByRole("button", { name: /send for approval/i });
    expect(sendButton).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox", { name: /proceed without waiting/i }));
    expect(sendButton).toBeDisabled(); // still needs a reason

    await userEvent.type(screen.getByLabelText(/reason/i), "Deadline is today; cannot wait.");
    expect(sendButton).not.toBeDisabled();

    await userEvent.click(sendButton);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      proceedWithoutWaiting: true,
      proceedReason: "Deadline is today; cannot wait.",
    });
  });
});
