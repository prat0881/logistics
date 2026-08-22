import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { mockFetch } from "@/test/mock-fetch";
import { CompareLegPanel } from "./CompareLegPanel";
import { ComparisonGrid, STALE_OFFER_LABEL } from "./ComparisonGrid";
import { METRICS, RECOMMENDATION_FOOTNOTE } from "./comparisonRowModel";
import type { ViewMode } from "./useViewMode";

afterEach(() => vi.unstubAllGlobals());

// FF1 ("Acme Forwarding") prices BOTH Road variants off one submitted quote (`quote-1`) — the
// same `quoteId` fans out into two `OfferDto` rows (DEDICATED/GROUPAGE) exactly as
// comparison.service.ts's `buildLeg` does, so the grid's column identity must be
// (quoteId, variant), not quoteId alone.
const FF1_DEDICATED_CHARGES = [
  { label: "Freight", group: "freight", nativeAmount: 40000, usdAmount: 481.93 },
  { label: "Additional Charges", group: "additional", nativeAmount: 4000, usdAmount: 48.19 },
  // Deliberately 1 cent off usdTotal (542.17) when summed — 481.93 + 48.19 + 12.06 = 542.18 —
  // mirrors the T1-flagged per-line rounding drift on foreign-currency legs (Σ usdAmount can
  // differ from usdTotal by a cent). ChargeBreakdownDialog must show usdTotal, never a
  // client-side sum (S5.7 T3 — carried over from the previous inline block; its own
  // mutation-proven test lives in ChargeBreakdownDialog.test.tsx now).
  { label: "Warehousing", group: "warehouse", nativeAmount: 1000, usdAmount: 12.06 },
];

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
      freightForwarderName: "Acme Forwarding",
      variant: "DEDICATED",
      variantLabel: "Dedicated",
      priced: true,
      nativeTotal: 45000,
      currency: "INR",
      unitsPerUsd: 3.6725,
      usdTotal: 542.17,
      transitDays: 3,
      chargeableWeightKg: 500,
      validUntil: "2026-08-25T12:00:00.000Z",
      quoteStatus: "QUOTED",
      charges: FF1_DEDICATED_CHARGES,
    },
    {
      quoteId: "quote-1",
      freightForwarderId: "ff1",
      freightForwarderName: "Acme Forwarding",
      variant: "GROUPAGE",
      variantLabel: "Groupage",
      priced: true,
      nativeTotal: 30000,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 361.45,
      transitDays: 5,
      chargeableWeightKg: 500,
      validUntil: "2026-08-25T12:00:00.000Z",
      quoteStatus: "QUOTED",
      charges: [
        { label: "Freight", group: "freight", nativeAmount: 28000, usdAmount: 337.35 },
        { label: "Additional Charges", group: "additional", nativeAmount: 2000, usdAmount: 24.1 },
        { label: "Warehousing", group: "warehouse", nativeAmount: 0, usdAmount: 0 },
      ],
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
      charges: [
        { label: "Freight", group: "freight", nativeAmount: 40000, usdAmount: 481.93 },
        { label: "Additional Charges", group: "additional", nativeAmount: 2000, usdAmount: 24.1 },
        { label: "Warehousing", group: "warehouse", nativeAmount: 0, usdAmount: 0 },
      ],
    },
    {
      // Same FF/quote as above, Groupage left un-priced — must render as a greyed "—", never $0.
      // `charges` is deliberately NOT [] here: comparison.service.ts's `buildCharges` unconditionally
      // emits "Additional Charges" + "Warehousing" lines (only "Freight" is conditional), so a real
      // unpriced offer always carries these two real, zero-amount lines — the exact shape that
      // would otherwise render a fake-looking $0.00 total in ChargeBreakdownDialog if not guarded
      // against.
      quoteId: "quote-2",
      freightForwarderId: "ff2",
      freightForwarderName: "Globex Logistics",
      variant: "GROUPAGE",
      variantLabel: "Groupage",
      priced: false,
      nativeTotal: 0,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 0,
      transitDays: null,
      chargeableWeightKg: 500,
      validUntil: null,
      quoteStatus: "QUOTED",
      charges: [
        { label: "Additional Charges", group: "additional", nativeAmount: 0, usdAmount: 0 },
        { label: "Warehousing", group: "warehouse", nativeAmount: 0, usdAmount: 0 },
      ],
    },
    {
      // A third FF whose quote is REQUOTED — its earlier price stays visible but stale-badged.
      quoteId: "quote-3",
      freightForwarderId: "ff3",
      freightForwarderName: "Third Forwarder",
      variant: "DEDICATED",
      variantLabel: "Dedicated",
      priced: true,
      nativeTotal: 47000,
      currency: "INR",
      unitsPerUsd: 83,
      usdTotal: 566.27,
      transitDays: 3,
      chargeableWeightKg: 500,
      validUntil: "2026-08-25T12:00:00.000Z",
      quoteStatus: "REQUOTED",
      charges: [{ label: "Freight", group: "freight", nativeAmount: 47000, usdAmount: 566.27 }],
    },
  ],
  pendingForwarders: [
    { freightForwarderId: "ff4", freightForwarderName: "Pending Forwarder", quoteStatus: "RFQ_SENT" },
  ],
  awaitingReQuote: true,
  recommendation: {
    quoteId: "quote-1",
    variant: "DEDICATED",
    reason: "High priority → fastest transit (3 days); price broke the tie.",
  },
  decision: null,
  timeline: [],
};

// CompareLegPanel now also renders Task 4's MakerPanel and Task 5's CheckerPanel in its open body
// (below the grid), which need a QueryClientProvider ancestor for their useMutation hooks and an
// AuthProvider ancestor for CheckerPanel's `useAuth()` role check — this file's own tests never
// touch either panel's mutations or role-gating (a 401 fetch stub keeps AuthProvider's own
// `/api/auth/me` probe from hitting the network; CheckerPanel then just self-hides as
// unauthenticated), they only exercise the grid/detail through the SAME shell it now happens to
// sit alongside.
function renderPanel(
  leg: LegComparisonDto = LEG,
  {
    locked = false,
    fetch,
    viewMode = "columns",
    onViewModeChange = () => {},
  }: {
    locked?: boolean;
    /** Optional handler for the few tests that drive a real maker mutation through the panel;
     *  everything else keeps the blanket 401 (AuthProvider then self-reports unauthenticated and
     *  `CheckerPanel` hides, exactly as before). */
    fetch?: (url: string, init?: RequestInit) => { status: number; body?: unknown };
    /** The orientation pair is owned by `CompareQuotesPage` now (final review IMPORTANT #1), so
     *  the panel takes it as required props. Defaulted here to the pre-lift behaviour — the hook's
     *  own default was `"columns"` — so every existing test in this file is unaffected. */
    viewMode?: ViewMode;
    onViewModeChange?: (mode: ViewMode) => void;
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    mockFetch(fetch ?? (() => ({ status: 401, body: { message: "Unauthorized" } }))),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <CompareLegPanel
          queryId="q1"
          leg={leg}
          open
          onToggle={() => {}}
          locked={locked}
          fxAsOf="2026-08-14T00:00:00.000Z"
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

// ── S5.7 T2 — orientation parity fixture ──────────────────────────────────────────────────────
// One priced, recommended offer ($1,824.37 / 3.67250 / 3 d — same numbers as
// `comparisonRowModel.test.ts`'s default fixture, so the two RED-confirmed literal assertions in
// the parity test below aren't coincidental) plus one un-priced offer from a second forwarder, so
// every parity assertion (recommendation flag, no fake $0) is exercised identically in both views.
const PARITY_PRICED_OFFER: OfferDto = {
  quoteId: "q1",
  freightForwarderId: "ff1",
  freightForwarderName: "Bridge",
  variant: "DEDICATED",
  variantLabel: "Dedicated",
  priced: true,
  nativeTotal: 6700,
  currency: "AED",
  unitsPerUsd: 3.6725,
  usdTotal: 1824.37,
  transitDays: 3,
  chargeableWeightKg: 100,
  validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "QUOTED",
  charges: [],
};

const PARITY_UNPRICED_OFFER: OfferDto = {
  quoteId: "q2",
  freightForwarderId: "ff2",
  freightForwarderName: "Second Forwarder",
  variant: "DEDICATED",
  variantLabel: "Dedicated",
  priced: false,
  nativeTotal: 0,
  currency: "AED",
  unitsPerUsd: 83, // deliberately NOT 3.6725 — collides with the priced offer's rate text otherwise
  usdTotal: 0,
  transitDays: null,
  chargeableWeightKg: 100,
  validUntil: null,
  quoteStatus: "QUOTED",
  charges: [
    { label: "Additional Charges", group: "additional", nativeAmount: 0, usdAmount: 0 },
    { label: "Warehousing", group: "warehouse", nativeAmount: 0, usdAmount: 0 },
  ],
};

// A third forwarder whose quote is REQUOTED — fix-round-1 addition (T2 review). Neither the
// original parity fixture nor the pre-existing `renderPanel()`-driven stale-badge test exercises
// the ROWS view's `cell.stale && <Badge>` block; the reviewer deleted that block from
// `ComparisonGridRows.tsx` entirely and the (then two-case) parity suite stayed 24/24 green.
const PARITY_STALE_OFFER: OfferDto = {
  quoteId: "q3",
  freightForwarderId: "ff3",
  freightForwarderName: "Third Forwarder",
  variant: "DEDICATED",
  variantLabel: "Dedicated",
  priced: true,
  nativeTotal: 9000,
  currency: "AED",
  unitsPerUsd: 3.7, // deliberately NOT 3.6725 — collides with the priced offer's rate text otherwise
  usdTotal: 2450.31,
  transitDays: 6,
  chargeableWeightKg: 100,
  validUntil: "2026-09-16T00:00:00.000Z",
  quoteStatus: "REQUOTED",
  charges: [],
};

const PARITY_LEG: LegComparisonDto = {
  legId: "leg-parity",
  legCode: "LEG-PARITY",
  mode: "ROAD",
  origin: "Origin",
  destination: "Destination",
  offers: [PARITY_PRICED_OFFER, PARITY_UNPRICED_OFFER, PARITY_STALE_OFFER],
  pendingForwarders: [],
  awaitingReQuote: false,
  recommendation: { quoteId: "q1", variant: "DEDICATED", reason: "cheapest landed cost" },
  decision: null,
  timeline: [],
};

// PARITY_LEG's recommended cell — `offerKey(quoteId, variant)` of its `recommendation` above.
// Used by the star-marker tests (S5.9 T8), which run through both orientations off this one fixture.
const PARITY_RECOMMENDED_KEY = "q1::DEDICATED";

function renderGrid({
  viewMode,
  locked = false,
  selectedOfferKey,
  onSelectOffer,
}: {
  viewMode: ViewMode;
  locked?: boolean;
  selectedOfferKey?: string;
  onSelectOffer?: (quoteId: string, variant: string | null) => void;
}) {
  return render(
    <ComparisonGrid
      leg={PARITY_LEG}
      viewMode={viewMode}
      locked={locked}
      selectedOfferKey={selectedOfferKey}
      onSelectOffer={onSelectOffer}
    />,
  );
}

// The whole point of T1's shared row model is that the two orientations cannot drift — every
// assertion here runs through BOTH `viewMode`s against the same fixture, so a feature present in
// one view and forgotten in the other fails this suite (mutation-proved: see task-2-report.md).
describe.each(["columns", "rows"] as const)("ComparisonGrid — %s view", (mode) => {
  it("shows every priced offer's USD total, rate and transit", async () => {
    renderGrid({ viewMode: mode });
    expect(await screen.findByText("$1,824.37")).toBeInTheDocument();
    expect(screen.getByText("3.67250")).toBeInTheDocument();
    expect(screen.getByText("3 d")).toBeInTheDocument();
  });

  it("never prints $0 for an unpriced offer", async () => {
    renderGrid({ viewMode: mode });
    expect(await screen.findByTestId("comparison-grid")).not.toHaveTextContent("$0.00");
  });

  // ── S5.9 T8, product item 2 — the `★` replaces the old status-cell "★ Recommended" badge: a
  // mark beside the variant costs no column width. The reason moves onto its accessible name (not
  // just a `title`, which the badge alone carried) so the information isn't lost, and the footnote
  // below the table explains the mark once per leg. Both orientations, off the same PARITY_LEG
  // fixture, so a view that forgot the mark (or the footnote) fails here — fix round 1 (T2 review)
  // established this "run it through both orientations off one fixture" convention on purpose. ──
  it("marks the recommendation with a star carrying its reason", async () => {
    renderGrid({ viewMode: mode });
    const mark = await screen.findByTestId(`offer-recommended-${PARITY_RECOMMENDED_KEY}`);
    expect(mark).toHaveTextContent("★");
    expect(mark).toHaveAccessibleName(/cheapest landed cost/i);
    expect(screen.getByText(RECOMMENDATION_FOOTNOTE)).toBeInTheDocument();
  });

  it("keeps the recommended offer visually tinted", async () => {
    renderGrid({ viewMode: mode });
    expect(await screen.findByTestId(`offer-usd-${PARITY_RECOMMENDED_KEY}`)).toHaveClass(
      "bg-emerald-500/10",
    );
  });

  it("suppresses the recommendation once locked, without hiding the grid's own figures", async () => {
    renderGrid({ viewMode: mode, locked: true });
    expect(await screen.findByText("$1,824.37")).toBeInTheDocument();
    expect(
      screen.queryByTestId(`offer-recommended-${PARITY_RECOMMENDED_KEY}`),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(RECOMMENDATION_FOOTNOTE)).not.toBeInTheDocument();
  });

  // ── S5.9 T9 — same suppression, one lifecycle stage earlier: once the leg's decision has left
  // DRAFT (sent for approval), `buildRecommendation` may already be ranking a different forwarder
  // than the one under review (Task 8's carried finding). Both orientations, off the same
  // PARITY_LEG fixture the star/footnote parity tests above use, so a view that forgot this
  // suppression fails here exactly as it would for `locked`.
  it("suppresses the recommendation once the decision leaves DRAFT, without hiding the grid's own figures", async () => {
    const pendingLeg: LegComparisonDto = {
      ...PARITY_LEG,
      decision: {
        legId: PARITY_LEG.legId,
        status: "PENDING_APPROVAL",
        shortlistedQuoteId: "q1",
        shortlistedVariant: "DEDICATED",
        recommendedQuoteId: "q1",
        recommendedVariant: "DEDICATED",
        overrideReason: null,
        rejectionReason: null,
        sentByUserId: "u1",
        sentForApprovalAt: "2026-08-14T09:00:00.000Z",
        decidedByUserId: null,
        decidedAt: null,
      },
    };
    render(<ComparisonGrid leg={pendingLeg} viewMode={mode} />);

    expect(await screen.findByText("$1,824.37")).toBeInTheDocument();
    expect(
      screen.queryByTestId(`offer-recommended-${PARITY_RECOMMENDED_KEY}`),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(RECOMMENDATION_FOOTNOTE)).not.toBeInTheDocument();
  });

  it("badges a REQUOTED offer as stale re-quote-requested", async () => {
    renderGrid({ viewMode: mode });
    expect(await screen.findByText(STALE_OFFER_LABEL)).toBeInTheDocument();
  });

  it("keeps an un-priced offer's header non-interactive (never a button)", async () => {
    renderGrid({ viewMode: mode });
    // The unpriced offer (q2) is "Second Forwarder"'s only column/row — its variant label is the
    // only "Dedicated" text belonging to a non-priced, non-recommended, non-stale offer, so this
    // resolves unambiguously against the 3-offer PARITY_LEG fixture without a testid.
    const header = await screen.findByTestId("offer-header-q2::DEDICATED");
    expect(header.tagName).not.toBe("BUTTON");
  });

  // ── the other manual-symmetry risk the coordinator flagged: click-to-expand wiring. Both views
  // build their header from the same `onOpenBreakdown`/`selectedOfferKey` props, but nothing
  // previously proved ROWS actually wires its onClick/aria-expanded rather than just LOOKING like
  // it does (`ComparisonGridColumns`'s own click test only runs through `renderPanel()`, whose
  // `CompareLegPanel` always mounts columns by default — S5.7 T2 fix round 1). ─────────────────
  it("clicking a priced offer's header reports that offer's identity via onSelectOffer", async () => {
    const onSelectOffer = vi.fn();
    renderGrid({ viewMode: mode, onSelectOffer });
    await userEvent.click(await screen.findByTestId("offer-header-q1::DEDICATED"));
    expect(onSelectOffer).toHaveBeenCalledWith("q1", "DEDICATED");
  });

  it("marks the header of the currently-selected offer aria-expanded", async () => {
    renderGrid({ viewMode: mode, selectedOfferKey: "q1::DEDICATED" });
    expect(await screen.findByTestId("offer-header-q1::DEDICATED")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("offer-header-q3::DEDICATED")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  // ── S5.9 T9 — the in-grid `Select` affordance (S5.7 T4) is retired: selection now happens
  // entirely in `SendForApprovalDialog`, opened from a button below the whole grid rather than a
  // per-offer click inside it. This is the brief's required replacement for the old S5.7 T4 Select
  // tests this block used to carry (clicking Select, the unpriced guard, unmounting once locked) —
  // all now vacuous by construction (there is no Select button in either state to click or hide),
  // so a stronger claim replaces them: the affordance never renders AT ALL, locked or not.
  it("no longer renders a Shortlist affordance", () => {
    renderGrid({ viewMode: mode });
    expect(screen.queryByRole("button", { name: /^Select/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Shortlist")).not.toBeInTheDocument();
  });
});

// ── final review MINOR #9 — design §39 says the rows view's forwarder rows are "grouped and
// banded". The columns view got `GROUP_SEPARATOR`; rows shipped with no equivalent, so grouping was
// conveyed only by printing the forwarder name once. Rows-only by construction, hence outside the
// parity `describe.each` above (the columns view has its own separator test further down).
describe("ComparisonGridRows — forwarder grouping is banded", () => {
  it("bands alternate forwarder groups and opens each later group with a rule", () => {
    render(<ComparisonGrid leg={PARITY_LEG} viewMode="rows" />);

    // PARITY_LEG is one offer each from three forwarders, so every row is also a group start.
    const first = screen.getByTestId("offer-row-q1::DEDICATED"); // group 0 — Bridge
    const second = screen.getByTestId("offer-row-q2::DEDICATED"); // group 1 — Second Forwarder
    const third = screen.getByTestId("offer-row-q3::DEDICATED"); // group 2 — Third Forwarder

    expect(second.className).toContain("bg-muted/30");
    // Alternating: neither neighbour is banded, so the band actually distinguishes groups rather
    // than tinting the whole table.
    expect(first.className).not.toContain("bg-muted/30");
    expect(third.className).not.toContain("bg-muted/30");

    // Every group after the first opens with the same 2px rule the columns view closes groups with.
    expect(first.className).not.toContain("border-t-2");
    expect(second.className).toContain("border-t-2");
    expect(third.className).toContain("border-t-2");
  });
});

// ── S5.9 T8, product item 3 — the Forwarder column is gone; its name moves to a full-width band
// row above that forwarder's variants, so two rows both reading "Dedicated" from different
// forwarders are never indistinguishable. Columns view needs no equivalent — its forwarder name
// already sits in its own `colSpan` header (S5.7 item 1), so it isn't touched by this task. ─────
describe("ComparisonGridRows — forwarder band row", () => {
  it("prints each forwarder's name once, on its own full-width band row", () => {
    render(<ComparisonGrid leg={PARITY_LEG} viewMode="rows" />);

    const band = screen.getByTestId("forwarder-band-ff1");
    expect(band).toHaveTextContent("Bridge");
    expect(band.querySelector("td")).toHaveAttribute("colspan");

    // The name is no longer repeated in a per-row column — no "Forwarder" column header exists.
    expect(screen.queryByRole("columnheader", { name: /forwarder/i })).not.toBeInTheDocument();
  });

  // Mutation-proof for the brief's "colSpan must be derived, never hard-coded" requirement: this
  // reads the ACTUAL value off `METRICS.length`, not just "some colspan attribute exists" — a
  // hard-coded `7` would keep the test above green but would go stale (and silently short the
  // band) the moment a metric is added or removed. This one only stays green if the two stay equal.
  it("derives the band's colSpan from METRICS.length + 2, not a hard-coded number", () => {
    render(<ComparisonGrid leg={PARITY_LEG} viewMode="rows" />);
    const band = screen.getByTestId("forwarder-band-ff1");
    expect(band.querySelector("td")).toHaveAttribute("colspan", String(METRICS.length + 2));
  });
});

// ── S5.9 T8, product item 2 — the status-cell "★ Recommended" badge is gone; the `★` beside the
// variant/header (plus the footnote) replace it. Only the Recommended badge is removed — the
// stale (REQUOTED) badge stays, pinned separately by the parity block's "badges a REQUOTED offer"
// test above. Both orientations: the badge used to be duplicated in both Status cells/rows. ─────
describe("ComparisonGrid — no Recommended badge in the status cell", () => {
  it.each(["columns", "rows"] as const)(
    "no longer renders a Recommended badge in the status cell (%s)",
    (mode) => {
      render(<ComparisonGrid leg={PARITY_LEG} viewMode={mode} />);
      const status = screen.getByTestId(`offer-status-${PARITY_RECOMMENDED_KEY}`);
      expect(within(status).queryByText(/^★ Recommended$/)).not.toBeInTheDocument();
      // The status cell still renders its ordinary status badge — proves the cell itself is
      // present and populated, so the absence above isn't vacuously true because nothing rendered.
      expect(within(status).getByText(/quoted/i)).toBeInTheDocument();
    },
  );
});

describe("ComparisonGrid (rendered through CompareLegPanel's body)", () => {
  it("renders one column per offer, grouped under its forwarder, with USD total + transit", () => {
    renderPanel();

    expect(screen.getByText("Acme Forwarding")).toBeInTheDocument();
    expect(screen.getByText("Globex Logistics")).toBeInTheDocument();

    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).toHaveTextContent("$542.17");
    expect(screen.getByTestId("offer-transit-quote-1::DEDICATED")).toHaveTextContent("3 d");
    expect(screen.getByTestId("offer-native-quote-1::DEDICATED")).toHaveTextContent("45,000.00 INR");

    expect(screen.getByTestId("offer-usd-quote-1::GROUPAGE")).toHaveTextContent("$361.45");
    expect(screen.getByTestId("offer-usd-quote-2::DEDICATED")).toHaveTextContent("$506.02");
  });

  it("renders the conversion-rate row", () => {
    renderPanel();
    expect(screen.getByTestId("offer-rate-quote-1::DEDICATED")).toHaveTextContent("3.67250");
  });

  it("tints every cell of the recommended column and stars its header with the reason, without touching sibling columns", () => {
    renderPanel();

    // Every row of the recommended (quote-1::DEDICATED) column carries the tint — not just its
    // header — per S5.7 item 2 ("recommendation by colour" replaces the old header-only ring).
    // The header's testid sits on the inner `<button>`; the tint lives on the wrapping `<th>`.
    expect(screen.getByTestId("offer-header-quote-1::DEDICATED").closest("th")).toHaveClass(
      "bg-emerald-500/10",
    );
    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).toHaveClass("bg-emerald-500/10");
    expect(screen.getByTestId("offer-status-quote-1::DEDICATED")).toHaveClass("bg-emerald-500/10");

    // Its own forwarder's OTHER variant column (quote-1::GROUPAGE) is untouched — the tint is keyed
    // by (quoteId, variant), not by forwarder.
    expect(screen.getByTestId("offer-usd-quote-1::GROUPAGE")).not.toHaveClass("bg-emerald-500/10");

    // S5.9 T8, product item 2 — the reason now rides the `★` mark beside the header's variant text
    // (both as its `title` and, more importantly, its accessible name), not a Status-cell badge.
    const mark = screen.getByTestId("offer-recommended-quote-1::DEDICATED");
    expect(mark).toHaveTextContent("★");
    const reason = "High priority → fastest transit (3 days); price broke the tie.";
    expect(mark).toHaveAttribute("title", reason);
    expect(mark).toHaveAccessibleName(`Recommended — ${reason}`);
    // ...and the Status cell itself no longer carries a "★ Recommended" badge.
    const status = screen.getByTestId("offer-status-quote-1::DEDICATED");
    expect(within(status).queryByText(/^★ Recommended$/)).not.toBeInTheDocument();
  });

  it("draws the forwarder separator on the last variant column of each group, not between a forwarder's own variants", () => {
    renderPanel();

    // FF1 (Acme) has two columns, quote-1::DEDICATED then quote-1::GROUPAGE — the separator belongs
    // on the LAST one (the boundary before FF2's first column), not the first.
    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).not.toHaveClass("border-r-2");
    expect(screen.getByTestId("offer-usd-quote-1::GROUPAGE")).toHaveClass("border-r-2");
    // FF2 (Globex) likewise: quote-2::GROUPAGE is its last column.
    expect(screen.getByTestId("offer-usd-quote-2::DEDICATED")).not.toHaveClass("border-r-2");
    expect(screen.getByTestId("offer-usd-quote-2::GROUPAGE")).toHaveClass("border-r-2");
    // FF3 (Third Forwarder) has exactly one column — it is trivially its own last column.
    expect(screen.getByTestId("offer-usd-quote-3::DEDICATED")).toHaveClass("border-r-2");
  });

  it("greys an un-priced offer's total instead of showing $0", () => {
    renderPanel();

    const cell = screen.getByTestId("offer-usd-quote-2::GROUPAGE");
    expect(cell).toHaveTextContent("—"); // em dash
    expect(cell).not.toHaveTextContent("$0");
  });

  it("does not let an un-priced offer's header expand into a fake $0 total", async () => {
    renderPanel();

    // The un-priced GROUPAGE column's header is not a button — no click affordance at all. (FF1's
    // OWN Groupage offer, quote-1::GROUPAGE, IS priced and IS a button — so this checks the
    // specific unpriced header element, not "no button anywhere is named Groupage".)
    const header = screen.getByTestId("offer-header-quote-2::GROUPAGE");
    expect(header.tagName).not.toBe("BUTTON");

    // Even so, clicking it must never open the breakdown dialog with fake money — belt +
    // suspenders. (Exact string, not a substring regex: "0.00 INR" would also match the tail of
    // a real total like "45,000.00 INR", so this checks for the fake-zero text as its own
    // standalone node.) `ChargeBreakdownDialog`'s own not-priced guard is unit-tested directly in
    // ChargeBreakdownDialog.test.tsx (defense in depth).
    await userEvent.click(header);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("charge-total")).not.toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("0.00 INR")).not.toBeInTheDocument();
  });

  it("badges a REQUOTED offer as stale re-quote-requested", () => {
    renderPanel();

    expect(screen.getByTestId("offer-status-quote-3::DEDICATED")).toHaveTextContent("Requoted");
    expect(screen.getByTestId("offer-stale-quote-3::DEDICATED")).toHaveTextContent(
      /re-quote requested/i,
    );
  });

  it("lists the pending forwarder and the awaiting-re-quote note", () => {
    renderPanel();

    const pending = screen.getByTestId("pending-forwarders");
    expect(within(pending).getByText("Pending Forwarder")).toBeInTheDocument();
    expect(within(pending).getByText("RFQ Sent")).toBeInTheDocument();

    expect(screen.getByText(/awaiting revised quote/i)).toBeInTheDocument();
  });

  it("opens the charge breakdown dialog on header click, using usdTotal as the authoritative total", async () => {
    renderPanel();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("offer-header-quote-1::DEDICATED"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Freight")).toBeInTheDocument();
    expect(within(dialog).getByText("Warehousing")).toBeInTheDocument();

    // charges' own usdAmount sum is 542.18 (481.93 + 48.19 + 12.06) — 1 cent off the offer's
    // authoritative usdTotal (542.17). The rendered total must be the latter, never the former.
    const total = within(dialog).getByTestId("charge-total");
    expect(total).toHaveTextContent("$542.17");
    expect(total).not.toHaveTextContent("$542.18");

    // Closing the dialog (Escape, same as its own close button/overlay-click) routes back through
    // `selectedOfferKey` (S5.7 T3's `handleBreakdownOpenChange`) — a real Radix modal blocks
    // pointer interaction with the now-inert background header while open (`pointer-events: none`
    // on its ancestor), so "click the same header again" is no longer how this closes; Escape is
    // the equivalent user gesture that exercises the same state transition the old inline
    // expand/collapse toggle used to.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Re-opening from the (now interactive again) header proves the toggle state actually reset
    // to "closed" rather than merely dropping the Escape keypress.
    await userEvent.click(screen.getByTestId("offer-header-quote-1::DEDICATED"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the leg-body offer-count summary the page test relies on", () => {
    renderPanel();
    expect(screen.getByTestId("leg-body")).toHaveTextContent("5 offers received");
  });

  // ── S5.7 T5 — the leg-level Negotiate button `CompareLegPanel` now owns ──────────────────────
  it("opens the multi-forwarder negotiate dialog from the leg header", async () => {
    renderPanel();

    const btn = await screen.findByRole("button", { name: /negotiate/i });
    expect(btn).not.toBeDisabled();

    await userEvent.click(btn);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("disables the leg's Negotiate button once sent for approval", async () => {
    const pendingLeg: LegComparisonDto = {
      ...LEG,
      decision: {
        legId: LEG.legId,
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
    renderPanel(pendingLeg);

    const btn = await screen.findByRole("button", { name: /negotiate/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/checker must reject/i)).toBeInTheDocument();
  });
});

describe("ComparisonGrid edge cases", () => {
  it("renders a single Air column (variant: null) without crashing", () => {
    const airLeg: LegComparisonDto = {
      legId: "leg-air",
      legCode: "LEG-AIR",
      mode: "AIR",
      origin: "Delhi",
      destination: "Frankfurt",
      offers: [
        {
          quoteId: "quote-air-1",
          freightForwarderId: "ffA",
          freightForwarderName: "Air Cargo Co",
          variant: null,
          variantLabel: "—",
          priced: true,
          nativeTotal: 5000,
          currency: "USD",
          unitsPerUsd: 1,
          usdTotal: 5000,
          transitDays: 2,
          chargeableWeightKg: 300,
          validUntil: "2026-08-25T12:00:00.000Z",
          quoteStatus: "QUOTED",
          charges: [
            { label: "Additional Charges", group: "additional", nativeAmount: 5000, usdAmount: 5000 },
          ],
        },
      ],
      pendingForwarders: [],
      awaitingReQuote: false,
      recommendation: null,
      decision: null,
      timeline: [],
    };

    renderPanel(airLeg);

    expect(screen.getByText("Air Cargo Co")).toBeInTheDocument();
    // offerKey's null-variant sentinel is "AIR" — one column, keyed off it.
    expect(screen.getByTestId("offer-header-quote-air-1::AIR")).toBeInTheDocument();
    expect(screen.getByTestId("offer-usd-quote-air-1::AIR")).toHaveTextContent("$5,000.00");
  });

  it("flags no column when the leg has no recommendation", () => {
    renderPanel({ ...LEG, recommendation: null });

    expect(screen.getByTestId("offer-header-quote-1::DEDICATED").closest("th")).not.toHaveClass(
      "bg-emerald-500/10",
    );
    expect(screen.queryByTestId("offer-recommended-quote-1::DEDICATED")).not.toBeInTheDocument();
    expect(screen.queryByText(RECOMMENDATION_FOOTNOTE)).not.toBeInTheDocument();
  });

  it("degrades gracefully when the recommendation references an offer absent from the leg", () => {
    renderPanel({
      ...LEG,
      recommendation: {
        quoteId: "quote-does-not-exist",
        variant: "DEDICATED",
        reason: "stale reference",
      },
    });

    // No column key in the model matches a nonexistent quoteId, so no cell picks up the tint or
    // mark — no crash, nothing flagged, rather than naming a nonexistent offer.
    expect(document.querySelector('[data-testid^="offer-recommended-"]')).toBeNull();
    expect(document.querySelectorAll(".bg-emerald-500\\/10")).toHaveLength(0);
    // Code-review fix (round 2) — `model.recommendedKey` is still a non-null string here (it's
    // derived straight from `leg.recommendation`, which exists), so gating the footnote on the raw
    // key alone would print "★ Recommended by the comparison engine." with zero `★` marks anywhere
    // on the page. It must go quiet along with the mark it explains.
    expect(screen.queryByText(RECOMMENDATION_FOOTNOTE)).not.toBeInTheDocument();
  });

  it("shows the empty-grid message and the pending list for a leg with zero offers", () => {
    const emptyLeg: LegComparisonDto = {
      legId: "leg-empty",
      legCode: "LEG-EMPTY",
      mode: "ROAD",
      origin: "Pune",
      destination: "Delhi",
      offers: [],
      pendingForwarders: [
        { freightForwarderId: "ffX", freightForwarderName: "Only Pending Forwarder", quoteStatus: "RFQ_SENT" },
      ],
      awaitingReQuote: false,
      recommendation: null,
      decision: null,
      timeline: [],
    };

    renderPanel(emptyLeg);

    expect(screen.getByText("No comparable quotes yet.")).toBeInTheDocument();
    expect(screen.getByText("Only Pending Forwarder")).toBeInTheDocument();
  });

  // ── final review M1 ───────────────────────────────────────────────────────────────────────
  it("suppresses the recommendation tint and the star mark once the award is locked", () => {
    // Post-generate, the WINNING quote is APPROVED — a status COMPARABLE_STATUSES excludes from
    // `offers` — so whatever `recommendation` still points at is ranked among the losers only.
    renderPanel(LEG, { locked: true });

    expect(screen.getByTestId("offer-header-quote-1::DEDICATED").closest("th")).not.toHaveClass(
      "bg-emerald-500/10",
    );
    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).not.toHaveClass("bg-emerald-500/10");
    expect(screen.queryByTestId("offer-recommended-quote-1::DEDICATED")).not.toBeInTheDocument();
    expect(screen.queryByText(RECOMMENDATION_FOOTNOTE)).not.toBeInTheDocument();

    // …while the grid itself stays fully readable.
    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).toHaveTextContent("$542.17");
    expect(screen.getByText("Acme Forwarding")).toBeInTheDocument();
  });

  // ── S5.9 T9 — carried forward from Task 8's own finding: `buildRecommendation`
  // (comparison.service.ts) ranks only `QUOTED` offers, so sending an offer for approval flips
  // ITS OWN quote to `PENDING_APPROVAL` and drops it out of that ranking on the very next fetch —
  // `leg.recommendation` can then name a DIFFERENT forwarder than the one actually under review,
  // exactly while a `CheckerPanel` (which only mounts for this same status) is looking at this
  // grid. Suppress the same way `locked` already does post-generate, one lifecycle stage earlier.
  // Both the `★`/tint AND the footnote must go quiet together — the footnote is gated (Task 8) on
  // `model.cells.some(c => c.recommended)`, so this is verifying that gate actually follows the
  // row-model fix below, not assuming it does.
  it("suppresses the recommendation tint, the star mark AND the footnote once sent for approval", () => {
    const pendingLeg: LegComparisonDto = {
      ...LEG,
      // Sending for approval flips the NAMED offer's own quote status too (S5.9 T3) — modelled
      // here so the fixture matches what the server actually does, not just the decision half.
      offers: LEG.offers.map((o) =>
        o.quoteId === "quote-1" && o.variant === "DEDICATED"
          ? { ...o, quoteStatus: "PENDING_APPROVAL" as const }
          : o,
      ),
      decision: {
        legId: LEG.legId,
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
    renderPanel(pendingLeg);

    expect(screen.getByTestId("offer-header-quote-1::DEDICATED").closest("th")).not.toHaveClass(
      "bg-emerald-500/10",
    );
    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).not.toHaveClass("bg-emerald-500/10");
    expect(screen.queryByTestId("offer-recommended-quote-1::DEDICATED")).not.toBeInTheDocument();
    expect(screen.queryByText(RECOMMENDATION_FOOTNOTE)).not.toBeInTheDocument();

    // …while the grid itself stays fully readable, and the Status cell says what's actually
    // happening instead (D2 already mitigated this — this asserts it, doesn't just assume it).
    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).toHaveTextContent("$542.17");
    expect(screen.getByTestId("offer-status-quote-1::DEDICATED")).toHaveTextContent(/pending/i);
  });

  // ── final review I2 — a rejected leg comes back as DRAFT + a reason ───────────────────────
  it("labels a returned (rejected) leg's chip 'Rejected — revise' rather than 'Shortlisted'", () => {
    const draft = {
      legId: "leg-1",
      status: "DRAFT" as const,
      shortlistedQuoteId: "quote-1",
      shortlistedVariant: "DEDICATED" as const,
      recommendedQuoteId: "quote-1",
      recommendedVariant: "DEDICATED" as const,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: null,
      sentForApprovalAt: null,
      decidedByUserId: null,
      decidedAt: null,
    };

    const { unmount } = renderPanel({ ...LEG, decision: draft });
    expect(screen.getByText("Shortlisted")).toBeInTheDocument();
    unmount();

    renderPanel({
      ...LEG,
      decision: { ...draft, rejectionReason: "Transit too slow for this client." },
    });
    expect(screen.getByText("Rejected — revise")).toBeInTheDocument();
    expect(screen.queryByText("Shortlisted")).not.toBeInTheDocument();
  });

  // ── S5.9 T10 (product item 7) — the two locked-state paragraphs `MakerPanel` used to render as
  // standing boxes ("This leg is approved — its shortlist is final here…" / "Locked while this leg
  // is pending approval…") moved onto the decision chip itself, as hover-only copy — see
  // `MakerPanel.test.tsx`'s "no longer renders the [...] paragraph as a block" for the other half
  // of this proof (that the panel itself stays silent now). This is the chip side: hovering must
  // still surface the same wording, just via a tooltip instead of a permanent box.
  it("explains an approved leg on hover of its decision chip instead of a standing panel paragraph", async () => {
    const approved = {
      legId: "leg-1",
      status: "APPROVED" as const,
      shortlistedQuoteId: "quote-1",
      shortlistedVariant: "DEDICATED" as const,
      recommendedQuoteId: "quote-1",
      recommendedVariant: "DEDICATED" as const,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: "u1",
      sentForApprovalAt: "2026-08-14T09:00:00.000Z",
      decidedByUserId: "checker-1",
      decidedAt: "2026-08-15T09:00:00.000Z",
    };

    renderPanel({ ...LEG, decision: approved });

    await userEvent.hover(screen.getByTestId("decision-chip"));
    // Radix's default `delayDuration` (700ms) eats most of `findBy`'s default 1000ms budget on its
    // own — a generous explicit timeout keeps this from flaking under a loaded CI runner rather
    // than genuinely proving the tooltip never opens.
    expect(await screen.findByRole("tooltip", {}, { timeout: 3000 })).toHaveTextContent(
      /shortlist is final/i,
    );
  });

  it("explains a pending-approval leg on hover of its decision chip too", async () => {
    const pending = {
      legId: "leg-1",
      status: "PENDING_APPROVAL" as const,
      shortlistedQuoteId: "quote-1",
      shortlistedVariant: "DEDICATED" as const,
      recommendedQuoteId: "quote-1",
      recommendedVariant: "DEDICATED" as const,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: "u1",
      sentForApprovalAt: "2026-08-14T09:00:00.000Z",
      decidedByUserId: null,
      decidedAt: null,
    };

    renderPanel({ ...LEG, decision: pending });

    await userEvent.hover(screen.getByTestId("decision-chip"));
    expect(await screen.findByRole("tooltip", {}, { timeout: 3000 })).toHaveTextContent(
      /checker has to reject it/i,
    );
  });

  // A DRAFT decision (the recommendation-preserving default) has no locked-state hint at all —
  // the chip renders bare, no `TooltipProvider`/`TooltipTrigger` wrapper reachable through it.
  it("has no hover explanation for a plain shortlisted (DRAFT) chip", async () => {
    const draft = {
      legId: "leg-1",
      status: "DRAFT" as const,
      shortlistedQuoteId: "quote-1",
      shortlistedVariant: "DEDICATED" as const,
      recommendedQuoteId: "quote-1",
      recommendedVariant: "DEDICATED" as const,
      overrideReason: null,
      rejectionReason: null,
      sentByUserId: null,
      sentForApprovalAt: null,
      decidedByUserId: null,
      decidedAt: null,
    };

    renderPanel({ ...LEG, decision: draft });

    await userEvent.hover(screen.getByTestId("decision-chip"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  // ── S5.9 T9 — this in-grid `Select` seam is gone entirely: `SendForApprovalDialog` is opened
  // by a plain button below the whole grid (`CompareLegPanel`'s action bar), not by a per-offer
  // grid click, so there is no gesture left inside the grid that could re-point what a submit
  // acts on. The S5.6 Critical's regression coverage for this class of bug now lives in
  // `SendForApprovalDialog.test.tsx`'s "submits the offer that is selected in the dialog, not one
  // merely read elsewhere" (ported from this file's old `unsavedPick` block) — that dialog builds
  // its own offer list off `leg` directly and owns its own selection, so there is no equivalent
  // "grid → dialog wiring" left for THIS file to test.
  //
  // The Select affordance's own presence/absence (both orientations, locked or not) is proven by
  // "no longer renders a Shortlist affordance" in the `describe.each` block above; the old
  // "withholds the Select affordance once the decision has left DRAFT" test is superseded by that
  // stronger claim (never rendered, full stop) plus `CompareLegPanel.tsx`'s `canSend` gating the
  // new action-bar button, exercised end-to-end in `CompareQuotesPage.test.tsx`.
});

// ── Review round IMPORTANT 3 — restored. This is the SAME guarantee final review IMPORTANT #2 /
// deferred minor T4 F3 fixed for `ShortlistDialog` (a background refetch that ends the maker's
// sendable window must not leave an already-open dialog live, and must not let it silently come
// back once the window reopens) — its regression test was deleted along with `ShortlistDialog`
// itself and the reviewer reproduced the exact same class of bug against `SendForApprovalDialog`:
// `CompareLegPanel`'s `{canSend && (...)}` guard unmounts the dialog correctly, but the `sendOpen`
// boolean that drives its `open` prop lives in the PARENT and survived the round trip, so a leg
// that goes DRAFT → PENDING_APPROVAL → DRAFT (rejected) remounted the dialog already open. Fixed
// with a `useEffect` in `CompareLegPanel.tsx` that clears `sendOpen` when `canSend` goes false —
// restoring this test alongside it, not just the fix, per the review.
//
// Both tests re-render the panel with a new `leg` — exactly what TanStack Query does when
// `["comparison", queryId]` refetches underneath it.
describe("SendForApprovalDialog is gated by the same rule as the button that opens it", () => {
  const DRAFT_DECISION = {
    legId: "leg-1",
    status: "DRAFT" as const,
    shortlistedQuoteId: null,
    shortlistedVariant: null,
    recommendedQuoteId: "quote-1",
    recommendedVariant: "DEDICATED" as const,
    overrideReason: null,
    rejectionReason: null,
    sentByUserId: null,
    sentForApprovalAt: null,
    decidedByUserId: null,
    decidedAt: null,
  };

  /** Renders the panel in a form that can be re-rendered with a different `leg`, so a test can
   *  simulate the read model changing under an open dialog. */
  function renderRefetchablePanel(leg: LegComparisonDto) {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 401, body: { message: "Unauthorized" } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (l: LegComparisonDto) => (
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <CompareLegPanel
            queryId="q1"
            leg={l}
            open
            onToggle={() => {}}
            locked={false}
            fxAsOf="2026-08-14T00:00:00.000Z"
            viewMode="columns"
            onViewModeChange={() => {}}
          />
        </AuthProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(leg));
    return { refetchAs: (l: LegComparisonDto) => rerender(tree(l)) };
  }

  it("unmounts an already-open SendForApprovalDialog once the leg stops being sendable", async () => {
    const draftLeg = { ...LEG, decision: DRAFT_DECISION };
    const { refetchAs } = renderRefetchablePanel(draftLeg);

    await userEvent.click(await screen.findByRole("button", { name: /send for approval/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // A second maker sends this leg for approval; the refetch brings back PENDING_APPROVAL.
    refetchAs({ ...LEG, decision: { ...DRAFT_DECISION, status: "PENDING_APPROVAL" } });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // ...and the button is gone too, i.e. the action bar and the dialog agree.
    expect(screen.queryByRole("button", { name: /send for approval/i })).not.toBeInTheDocument();
  });

  it("does not silently re-open the dialog when the leg becomes sendable again", async () => {
    const draftLeg = { ...LEG, decision: DRAFT_DECISION };
    const { refetchAs } = renderRefetchablePanel(draftLeg);

    await userEvent.click(await screen.findByRole("button", { name: /send for approval/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    refetchAs({ ...LEG, decision: { ...DRAFT_DECISION, status: "PENDING_APPROVAL" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // A checker rejects the leg — `reject()` writes DRAFT + a reason, so sending reopens. The
    // maker's dismissed dialog must NOT come back as an open modal on its own.
    refetchAs({ ...LEG, decision: { ...DRAFT_DECISION, rejectionReason: "Too expensive" } });

    // Positive control — sending really is available again, so "no dialog" isn't vacuous.
    expect(
      await screen.findByRole("button", { name: /send for approval/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
