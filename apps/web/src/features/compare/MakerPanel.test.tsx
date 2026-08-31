import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import type { LegComparisonDto } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
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
  return <MakerPanel leg={leg} />;
}

function renderMaker(leg: LegComparisonDto) {
  vi.stubGlobal(
    "fetch",
    mockFetch(() => ({ status: 404 })),
  );
  return renderWithProviders(<Harness leg={leg} />, {
    user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" },
  });
}

// `AuthProvider`'s `/api/auth/me` round trip is async, so `user`/`loading` from `useAuth()` are
// still settling for one or more microtask hops after `render()` returns (see
// `ComparisonGrid.test.tsx`'s "Checker action bar" block for the fuller rationale). MakerPanel
// itself doesn't read
// auth state — its output is fully determined by the `leg` prop — but an absence assertion taken
// synchronously right after `render()` would still prove nothing about whether the tree has
// actually settled. `AuthProbe` renders a value that only exists once `AuthProvider` has resolved,
// so `await screen.findByText(...)` on it forces the maker-panel-absence assertion to run
// post-settle rather than merely before anything has had a chance to mount.
function AuthProbe() {
  const { user, loading } = useAuth();
  return <span data-testid="auth-probe">{loading ? "loading" : (user?.role ?? "anonymous")}</span>;
}

function renderMakerAfterAuthSettles(leg: LegComparisonDto) {
  vi.stubGlobal(
    "fetch",
    mockFetch(() => ({ status: 404 })),
  );
  renderWithProviders(
    <>
      <AuthProbe />
      <Harness leg={leg} />
    </>,
    { user: { id: "u1", name: "Exec", email: "e@x.com", role: "EXECUTIVE" } },
  );
  return screen.findByText("EXECUTIVE");
}

describe("MakerPanel", () => {
  // S5.7 T4 moved the shortlist RadioGroup and the Send-for-approval box into `ShortlistDialog`,
  // opened from a per-offer `Select` button in the grid; S5.9 T9 retired both in favour of
  // `SendForApprovalDialog`, opened from a plain button below the whole grid. Their tests moved
  // (twice, now):
  //   - offer list / override-required / body-shape / A9 / inline-error → `SendForApprovalDialog.test.tsx`;
  //   - the S5.6 Critical's regression coverage → `SendForApprovalDialog.test.tsx`'s "submits the
  //     offer that is selected in the dialog, not one merely read elsewhere" (the grid no longer has
  //     a `Select` seam at all, so there is no separate grid-side test left to carry);
  //   - Select/Shortlist affordance presence — now "never rendered, full stop" rather than
  //     status-conditional — → `ComparisonGrid.test.tsx`'s "no longer renders a Shortlist affordance".
  // What is asserted here is only what MakerPanel still renders.

  it("renders no shortlist, send-for-approval or negotiate controls of its own any more", () => {
    // A DRAFT decision (SAVED_LEG) is the one state that gives every OTHER "no controls here"
    // assertion something real to fail against — see the `Negotiate` one below: it isn't passing
    // because the panel rendered nothing at all, `rejection-notice` is a genuine positive control
    // in the SAME render.
    renderMaker({
      ...SAVED_LEG,
      decision: { ...SAVED_LEG.decision!, rejectionReason: "Transit too slow for this client." },
    });

    expect(screen.getByTestId("maker-panel")).toBeInTheDocument();
    expect(screen.getByTestId("rejection-notice")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send for approval/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/override reason/i)).not.toBeInTheDocument();
    // S5.7 T5 — negotiation moved to one leg-level button in `CompareLegPanel`, so MakerPanel must
    // no longer render any Negotiate affordance of its own.
    expect(screen.queryByRole("button", { name: /negotiate/i })).not.toBeInTheDocument();
  });

  // ── S5.9 T10 (product item 7) — both locked-state paragraphs moved off this panel and onto
  // the leg header's decision chip as a hover tooltip (`CompareLegPanel`'s `DecisionChip`).
  // S5.9.1 (product item 4) then deleted that chip entirely — the two hints have no home to move
  // to any more and are simply gone (`ComparisonGrid.test.tsx` no longer carries their tooltip
  // tests). What is asserted here is only that MakerPanel no longer renders either paragraph AS A
  // BLOCK — not merely that this one regex is absent, but that the whole panel mounts nothing for
  // these statuses (final review I1's dead-end wording is gone from this component entirely).
  it("no longer renders the approved-state paragraph as a block", () => {
    renderMaker({
      ...SAVED_LEG,
      decision: { ...SAVED_LEG.decision!, status: "APPROVED" },
    });

    expect(screen.queryByText(/its shortlist is final here/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("maker-panel")).not.toBeInTheDocument();
  });

  it("no longer renders the pending-approval paragraph as a block either", () => {
    renderMaker(PENDING_LEG);

    expect(screen.queryByText(/a checker has to reject it/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("maker-panel")).not.toBeInTheDocument();
  });

  // Visual-acceptance fix (S5.7) — a plain DRAFT leg (not locked, no rejection reason) is the
  // default state of every leg, and nothing above is meant to render for it any more. Before this
  // fix the container div rendered unconditionally, leaving a 34px empty bordered card between the
  // comparison grid and the decision timeline.
  it("renders nothing at all for a plain DRAFT leg that is neither locked nor carrying a rejection reason", async () => {
    await renderMakerAfterAuthSettles(SAVED_LEG);

    expect(screen.queryByTestId("maker-panel")).not.toBeInTheDocument();
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

  // Negotiate's own behaviour (dialog contents, POST body, mid-flight Cancel/Escape gating) now
  // lives in `NegotiateDialog.test.tsx`; the leg-level button that opens it is covered in
  // `ComparisonGrid.test.tsx` (rendered through `CompareLegPanel`, which owns it).
});
