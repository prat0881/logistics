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

/** The same leg with a shortlist already persisted as a DRAFT decision — still fully editable
 *  (`reject()` writes DRAFT + a reason, so this is also the shape a returned leg comes back as). */
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

function Harness({ leg }: { leg: LegComparisonDto }) {
  return <MakerPanel queryId="q1" leg={leg} />;
}

function renderMaker(
  leg: LegComparisonDto,
  opts: {
    onRequotePost?: (quoteId: string, body: unknown) => void;
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
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
  // S5.7 T4 — the shortlist RadioGroup and the Send-for-approval box moved into `ShortlistDialog`,
  // opened from a per-offer `Select` button in the grid. Their tests moved with them:
  //   - override-required / body-shape / A9 / inline-409 → `ShortlistDialog.test.tsx`;
  //   - the three `unsavedPick` regression tests that guarded the S5.6 Critical → two into
  //     `ShortlistDialog.test.tsx`'s "the offer submitted is the offer whose Select was clicked"
  //     block, the grid-seam one into `ComparisonGrid.test.tsx` ("opening a rival offer's charge
  //     breakdown does not change which offer Select submits");
  //   - "the shortlist radio is disabled once the decision is past DRAFT" → `ComparisonGrid.test.tsx`
  //     ("withholds the Select affordance once the leg's decision has left DRAFT"), which asserts the
  //     affordance is UNMOUNTED rather than merely disabled.
  // What is asserted here is only what MakerPanel still renders.

  it("renders no shortlist or send-for-approval controls of its own any more", () => {
    renderMaker(LEG);

    expect(screen.getByTestId("maker-panel")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send for approval/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/override reason/i)).not.toBeInTheDocument();
    // …while the negotiate half it still owns is present — so this isn't passing because the panel
    // rendered nothing at all.
    expect(screen.getByRole("button", { name: /negotiate.*tci freight/i })).toBeInTheDocument();
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
  });

  it("keeps the recoverable wording for a leg that is only pending approval", () => {
    renderMaker(PENDING_LEG);

    expect(screen.getByText(/a checker has to reject it/i)).toBeInTheDocument();
    expect(screen.queryByText(/its shortlist is final here/i)).not.toBeInTheDocument();
  });

  it("shows neither locked message while the decision is still an editable DRAFT", () => {
    renderMaker(SAVED_LEG);

    expect(screen.queryByText(/a checker has to reject it/i)).not.toBeInTheDocument();
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
    // …and only on a DRAFT: a PENDING_APPROVAL decision carrying a stale reason must not re-show it.
    expect(screen.getByTestId("rejection-notice")).toBeInTheDocument();
  });

  it("does not show the rejection notice once the leg has been re-sent for approval", () => {
    renderMaker({
      ...PENDING_LEG,
      decision: { ...PENDING_LEG.decision!, rejectionReason: "Transit too slow for this client." },
    });

    expect(screen.queryByTestId("rejection-notice")).not.toBeInTheDocument();
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

});
