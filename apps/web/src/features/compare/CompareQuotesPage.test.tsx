import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthProvider";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { CompareQuotesPage } from "./CompareQuotesPage";

afterEach(() => {
  vi.unstubAllGlobals();
  // The view-mode test below persists the orientation (that is the point of the preference), so it
  // must not leak into the other tests in this file, which all assume the `"columns"` default.
  localStorage.clear();
});

/** `AuthProvider`'s `/api/auth/me` round trip is async, so `useAuth()`'s `user` is `null` for one
 *  or more microtask hops after `render()`. Any absence assertion taken before it settles proves
 *  nothing about a role-aware gate — the action bar's checker controls (Approve/Reject, S5.9.1
 *  Task 2, absorbing what used to be a standalone `CheckerPanel`) self-hide and `GenerateGate` is
 *  parent-gated on `canCheck`, both of which are false for an anonymous viewer regardless of
 *  `locked`. Awaiting this probe's resolved role forces the assertions to run post-settle (same
 *  mechanism as `ComparisonGrid.test.tsx`'s "Checker action bar" block; final review M3). */
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

// S5.6 Task 6, ambiguity resolution #1 — snapshot presence IS the QUOTING_CLIENT signal
// (see `CompareQuotesPage.tsx`'s own comment). Reused verbatim across the locked-state tests
// below so there's exactly one shape to keep in sync with `AwardSnapshotDto`.
const SNAPSHOT = {
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
};

/** S5.7 T6 — extended to accept `{ role, awardSnapshot }` so both-roles and locked-state tests
 *  share one helper instead of hand-rolling `renderWithProviders` calls (brief Step 1's illustrative
 *  `renderPage({ role })` signature). Always renders `AuthProbe` alongside the page — every test in
 *  this file that asserts an absence must await it first (see the module doc comment above). */
function renderPage(opts: { role?: string; awardSnapshot?: typeof SNAPSHOT | null } = {}) {
  const role = opts.role ?? "EXECUTIVE";
  const comparison =
    opts.awardSnapshot !== undefined
      ? { ...COMPARISON, awardSnapshot: opts.awardSnapshot }
      : COMPARISON;
  const detail = opts.awardSnapshot ? { ...QUERY_DETAIL, status: "QUOTING_CLIENT" } : QUERY_DETAIL;
  vi.stubGlobal(
    "fetch",
    mockFetch((url) => {
      if (url.endsWith("/api/queries/q1")) return { status: 200, body: detail };
      if (url.endsWith("/api/queries/q1/comparison")) return { status: 200, body: comparison };
      return { status: 404 };
    }),
  );
  return renderWithProviders(
    <>
      <AuthProbe />
      <Routes>
        <Route path="/queries/:id/compare" element={<CompareQuotesPage />} />
      </Routes>
    </>,
    {
      route: "/queries/q1/compare",
      // Review round (Minor) — was "u1", which collides with LEG-2's decision.sentByUserId ("u1",
      // see COMPARISON above): every MANAGER-role test rendered through this helper was, by fixture
      // accident, the sender of LEG-2's pending decision (four-eyes `isSelf`). Nothing currently in
      // this file exercises an unlocked MANAGER+LEG-2 case where that would matter, but "u2" removes
      // the latent trap rather than leaving it for whoever adds that test next.
      user: { id: "u2", name: "Viewer", email: "v@x.com", role },
    },
  );
}

describe("CompareQuotesPage", () => {
  it("renders the query header, a collapsed panel per comparison leg, and the Quotation stage as active", async () => {
    renderPage();

    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();

    // One collapsed leg card per comparison leg — bodies not rendered until opened.
    expect(await screen.findByRole("button", { name: /LEG-1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /LEG-2/i })).toBeInTheDocument();
    expect(screen.queryByTestId("leg-body")).not.toBeInTheDocument();

    // S5.9.3 P5 — the former standalone "Quotes" rail step is now "Quotation" (it absorbed both
    // this screen and the client-quotation builder). It highlights as the current, navigable step
    // here (status QUOTED opens the earlier gate) and links to THIS screen until the award is
    // frozen — see the two tests below for the switch-over once it is.
    const quotationLink = screen.getByRole("link", { name: /quotation/i });
    expect(quotationLink).toHaveAttribute("aria-current", "step");
    expect(quotationLink).toHaveAttribute("href", "/queries/q1/compare");
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

  // ── final review IMPORTANT #1 — the orientation is ONE preference for the whole screen ────────
  // This is the only place TWO view-mode consumers are concurrently mounted, which is the only
  // shape that can catch the bug: every `CompareLegPanel` used to call `useViewMode()` itself, and
  // `useState`'s lazy initialiser runs once per mount, so LEG-2's panel seeded `"columns"` at page
  // load and never heard about a toggle made on LEG-1. `useViewMode.test.ts`'s "a fresh mount picks
  // up the persisted preference" test cannot see this — it unmounts the first hook BEFORE mounting
  // the second, which is the page-reload shape, not the production one.
  it("carries the view-mode preference from one leg to another (one global orientation, not one per leg)", async () => {
    renderPage();
    await screen.findByText("EXECUTIVE");

    await userEvent.click(await screen.findByRole("button", { name: /LEG-1/i }));
    await screen.findByTestId("leg-body");
    // Positive control: the default orientation really is columns, whose first header cell is
    // "Offer" (the rows view's is "Variant" — S5.9 T8 dropped the rows view's own "Forwarder /
    // variant" header column in favour of a full-width band row per forwarder group), so the
    // switch below is observable.
    expect(screen.getByRole("columnheader", { name: /^offer$/i })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("view-mode-rows"));
    expect(await screen.findByRole("columnheader", { name: /^variant$/i })).toBeInTheDocument();

    // LEG-2's panel has been mounted since the page loaded — i.e. since BEFORE the toggle.
    await userEvent.click(screen.getByRole("button", { name: /LEG-2/i }));
    await waitFor(() => expect(screen.getByTestId("leg-body")).toHaveTextContent("2 offers"));
    expect(screen.getByRole("columnheader", { name: /^variant$/i })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /^offer$/i })).not.toBeInTheDocument();
  });

  it("locks maker/checker/generate controls and shows QuotingClientPanel once the award snapshot is present (S5.6 Task 6)", async () => {
    // LEG-2's decision is already PENDING_APPROVAL (see COMPARISON above) — for a MANAGER viewer
    // that would normally mount the action bar's Approve/Reject (S5.9.1 Task 2 — the standalone
    // `CheckerPanel` this used to name is deleted; `ComparisonGrid.test.tsx`'s "Checker action bar"
    // block pins exactly this). Proving the whole bar is absent here — under an award snapshot — is
    // therefore exercising the `locked` gate itself, not just "nothing to check" or "wrong role".
    renderPage({ role: "MANAGER", awardSnapshot: SNAPSHOT });

    const leg2 = await screen.findByRole("button", { name: /LEG-2/i });
    await userEvent.click(leg2);
    await screen.findByTestId("leg-body");
    // Without this, `leg-action-bar`/`generate-gate`/the S5.7 assertions below would be absent for
    // the WRONG reason (no viewer yet ⇒ `canCheck` false) and would pass even with `locked`
    // inverted — final review M3.
    await screen.findByText("MANAGER");

    expect(screen.queryByTestId("maker-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("leg-action-bar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("generate-gate")).not.toBeInTheDocument();
    expect(await screen.findByTestId("quoting-client-panel")).toBeInTheDocument();

    // S5.7 T6, re-pinning S5.6 final-review M1. LEG-2 carries a `recommendation` (see COMPARISON
    // above), so — like the checker-panel assertion above — "no recommendation" here (the `★`
    // mark and its footnote both go quiet, S5.9 T8) is exercising `locked`, not "nothing to
    // recommend". Negotiate is unconfounded by `decision.status` (it only
    // gets DISABLED-with-reason at PENDING_APPROVAL, never removed for that reason alone — see
    // `CompareLegPanel`'s `negotiateDisabledReason`), so its absence here is genuine too.
    expect(screen.queryByRole("button", { name: /negotiate/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/recommended/i)).not.toBeInTheDocument();

    // DELETED (final whole-branch review, MINOR 2) — the Send half of this test, which used to
    // switch to LEG-1 here and assert "Send for approval" absent. Its own comment justified the
    // switch by saying LEG-1's `decision: null` means "nothing else would hide Send on it", so the
    // assertion isolated `locked`. **Q6 falsified that premise in this very sub-build**: for a
    // MANAGER on a decision-less leg, `canSend`'s new `(!isChecker || leg.decision != null)` term
    // is false whatever `locked` says, so the assertion could not fail and the comment claiming it
    // proved something was the second instance of the pattern this round already fixed once
    // ("three tests that could not fail"). Confirmed by mutation: deleting `!locked &&` from
    // `canSend` left the whole 859-test suite green.
    //
    // It is not repaired in place because NO page-level absence assertion can isolate that term:
    // the action bar carries its own `!locked` gate (`{!locked && hasActionBarControls && …}`), so
    // the button is gone under a lock either way. The one surface where `canSend`'s own `!locked`
    // is observable is the dialog mounted OUTSIDE that bar (`{canSend && <SendForApprovalDialog>}`)
    // — an already-open dialog when the lock engages mid-session. That is where the replacement
    // test lives, in `ComparisonGrid.test.tsx`'s "SendForApprovalDialog is gated by the same rule
    // as the button that opens it" block, which has a re-renderable panel harness for exactly this
    // shape. The whole-bar assertion above still covers the locked BEHAVIOUR at this level, but
    // not either term that produces it: `canCheck`'s own `!locked` (`CompareLegPanel.tsx:193`) and
    // the action bar's own `!locked` (`:331`) mask each other for this leg (LEG-2 is
    // PENDING_APPROVAL, MANAGER is the checker) — deleting just one still leaves the other blocking
    // the bar, so this assertion stays green either way; only deleting both turns it red.
  });

  describe.each(["EXECUTIVE", "MANAGER"] as const)("compare screen as %s", (role) => {
    it("shows the grid", async () => {
      renderPage({ role });
      await screen.findByText(role);

      const leg1 = await screen.findByRole("button", { name: /LEG-1/i });
      await userEvent.click(leg1);
      await screen.findByTestId("leg-body");

      expect(screen.getByTestId("comparison-grid")).toBeInTheDocument();
    });
  });

  // ── S5.9.2 Q6 (PO ruling) — split out of the `describe.each` above, which used to assert Send
  // for BOTH roles unconditionally: a Manager/Admin now sees "Send for approval" only once a
  // `LegAwardDecision` row exists on the leg (`leg.decision != null`). LEG-1 carries no decision
  // at all (see COMPARISON above), so an EXECUTIVE still gets Send on it (unaffected by Q6, the
  // four-eyes flow this used to justify staying on for both roles only ever applied once a decision
  // row already existed) while a MANAGER does not. ───────────────────────────────────────────────
  it("offers Send for approval to an EXECUTIVE on a decision-less leg", async () => {
    renderPage({ role: "EXECUTIVE" });
    await screen.findByText("EXECUTIVE");

    const leg1 = await screen.findByRole("button", { name: /LEG-1/i });
    await userEvent.click(leg1);
    await screen.findByTestId("leg-body");

    expect(screen.getByRole("button", { name: /send for approval/i })).toBeInTheDocument();
  });

  it("does not offer Send for approval to a MANAGER on a leg with no decision row yet (Q6)", async () => {
    renderPage({ role: "MANAGER" });
    await screen.findByText("MANAGER");

    // Positive control — LEG-2's PENDING_APPROVAL decision offers this MANAGER a real Approve
    // button, proving the role gate has genuinely resolved as MANAGER (not a still-null viewer)
    // before the absence assertion below on the DIFFERENT, decision-less LEG-1 (Send is exactly
    // what's under test here, so it can't be its own positive control the way it was for the
    // Negotiate split above — a sibling leg's real checker control stands in for it instead).
    const leg2 = await screen.findByRole("button", { name: /LEG-2/i });
    await userEvent.click(leg2);
    await screen.findByRole("button", { name: /^approve$/i });

    // Single-open accordion — switching to LEG-1 closes LEG-2's body.
    await userEvent.click(screen.getByRole("button", { name: /LEG-1/i }));
    await screen.findByTestId("leg-body");

    expect(screen.queryByRole("button", { name: /send for approval/i })).not.toBeInTheDocument();
    // No decision row and no checker role match either, so the whole bar has zero controls left
    // and withholds itself (`hasActionBarControls`) rather than rendering empty.
    expect(screen.queryByTestId("leg-action-bar")).not.toBeInTheDocument();
  });

  // ── S5.9.1 Task 2 (product item 1) — split out of the describe.each above, which used to assert
  // Negotiate for BOTH roles: Manager/Admin no longer get it ("if they want to negotiate then they
  // should reject and put the reason in the notes"). LEG-1 carries no decision (see COMPARISON
  // above), so this is a plain role check, unconfounded by `decision.status` or four-eyes. ────────
  it("offers Negotiate to an EXECUTIVE", async () => {
    renderPage({ role: "EXECUTIVE" });
    await screen.findByText("EXECUTIVE");

    const leg1 = await screen.findByRole("button", { name: /LEG-1/i });
    await userEvent.click(leg1);
    await screen.findByTestId("leg-body");

    expect(screen.getByRole("button", { name: /negotiate/i })).toBeInTheDocument();
  });

  // ── Review round (Important) — this used to target LEG-1, which carries no decision at all.
  // S5.9.2 Q6 makes `hasActionBarControls` false on ALL THREE terms for a MANAGER on that leg
  // (no Negotiate — checker; no Approve/Reject — nothing pending; no Send — no decision row yet),
  // so the whole bar is withheld and Negotiate's absence there was trivially true regardless of
  // its own `!isChecker` gate — a test that cannot fail. LEG-2 carries a PENDING_APPROVAL decision
  // (see COMPARISON above), so the bar DOES render for this MANAGER via `canCheck`; asserting the
  // bar (and a real Approve button on it) is present BEFORE asserting Negotiate's absence proves
  // this is exercising `!isChecker` specifically, not the bar collapsing to empty. Mutation-proved:
  // dropping the `!isChecker` guard on the Negotiate button (`{!isChecker && (<Button>Negotiate…`
  // → `{true && (…`) turns this red; restoring it turns it green (task-3-report.md). ─────────────
  it("does not offer Negotiate to a MANAGER", async () => {
    renderPage({ role: "MANAGER" });
    await screen.findByText("MANAGER");

    const leg2 = await screen.findByRole("button", { name: /LEG-2/i });
    await userEvent.click(leg2);
    // Positive controls, in order: the action bar itself rendered (proves the body isn't just
    // empty), and a real checker control on it (proves this MANAGER's role gate has genuinely
    // resolved, not a still-null viewer that would also show no Negotiate for the wrong reason).
    await screen.findByTestId("leg-action-bar");
    await screen.findByRole("button", { name: /^approve$/i });

    expect(screen.queryByRole("button", { name: /negotiate/i })).not.toBeInTheDocument();
  });

  // 🔴 Final review CRITICAL #2 — the S5.8 Client Quotation builder had NO entry point anywhere in
  // the app. `isQuotationStageEnabled` was passed only by `QuotationPage` (the destination itself),
  // so this screen — where the award is frozen, and the builder's natural predecessor — rendered
  // its Quotation step with `to: undefined`. `/queries/:id/quotation` was reachable only by typing
  // the URL. S5.9.3 P5 merged that step with this screen's own "Quotes" step into one "Quotation"
  // step, but the switch-over this test guards is unchanged: once the award is frozen, the SAME
  // rail step's link moves from Compare Quotes to the client quotation builder.
  it("links the Quotation step to the client quotation builder once the award is frozen", async () => {
    renderPage({ awardSnapshot: SNAPSHOT });
    await screen.findByText("EXECUTIVE");

    const rail = await screen.findByRole("navigation", { name: /query stages/i });
    expect(within(rail).getByRole("link", { name: /quotation/i })).toHaveAttribute(
      "href",
      "/queries/q1/quotation",
    );
  });

  // S5.9.3 P5 — before the merge, this scenario (award not frozen) exercised a SECOND, further-out
  // "Quotation" step that had no link yet. That step no longer exists: the current step IS
  // "Quotation" now, so it stays linked — to Compare Quotes, i.e. this same screen — rather than
  // going non-navigable. The "renders the query header…" test above already covers this exact
  // combination (aria-current + href=/compare); this test adds the `awardSnapshot` field's absence
  // as an explicit, named negative case for the switch-over above.
  it("keeps the Quotation step pointed at Compare Quotes while no award has been frozen", async () => {
    renderPage(); // QUERY_DETAIL.status === "QUOTED", awardSnapshot null
    await screen.findByText("EXECUTIVE");

    const rail = await screen.findByRole("navigation", { name: /query stages/i });
    const quotationLink = within(rail).getByRole("link", { name: /quotation/i });
    expect(quotationLink).toHaveAttribute("href", "/queries/q1/compare");
    expect(quotationLink).not.toHaveAttribute("href", "/queries/q1/quotation");
  });

  it("shows checker controls only to a MANAGER", async () => {
    renderPage({ role: "EXECUTIVE" });
    await screen.findByText("EXECUTIVE");

    // Approve/Reject only mount inside an OPEN leg body (`CompareLegPanel`'s `open && (...)`), so
    // without opening a leg their absence would be vacuous — true for any role simply because no
    // leg is expanded. LEG-2 carries a PENDING_APPROVAL decision (see COMPARISON above), the exact
    // shape `ComparisonGrid.test.tsx`'s "Checker action bar" block proves DOES offer Approve/Reject
    // for a MANAGER — opening it here means this assertion is exercising the role gate, not
    // "nothing to check". The action bar itself still renders for this EXECUTIVE (Negotiate/Send
    // are on), so this checks the two checker buttons specifically rather than the whole bar's
    // absence (which would also — wrongly — pass for an unrelated reason like `locked`).
    const leg2 = await screen.findByRole("button", { name: /LEG-2/i });
    await userEvent.click(leg2);
    await screen.findByTestId("leg-body");

    expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("generate-gate")).not.toBeInTheDocument();
  });
});
