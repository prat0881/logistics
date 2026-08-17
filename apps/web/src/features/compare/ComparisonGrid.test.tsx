import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LegComparisonDto, OfferDto } from "@svyft/shared";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { mockFetch } from "@/test/mock-fetch";
import { CompareLegPanel } from "./CompareLegPanel";
import { ComparisonGrid, STALE_OFFER_LABEL } from "./ComparisonGrid";
import type { OfferCell } from "./comparisonRowModel";
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
  recommendation: { quoteId: "q1", variant: "DEDICATED", reason: "fastest transit" },
  decision: null,
  timeline: [],
};

function renderGrid({
  viewMode,
  locked = false,
  selectedOfferKey,
  onSelectOffer,
  onShortlistOffer = () => {},
}: {
  viewMode: ViewMode;
  locked?: boolean;
  selectedOfferKey?: string;
  onSelectOffer?: (quoteId: string, variant: string | null) => void;
  onShortlistOffer?: (cell: OfferCell) => void;
}) {
  return render(
    <ComparisonGrid
      leg={PARITY_LEG}
      viewMode={viewMode}
      locked={locked}
      selectedOfferKey={selectedOfferKey}
      onSelectOffer={onSelectOffer}
      onShortlistOffer={onShortlistOffer}
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

  it("flags the recommended offer and never prints $0 for an unpriced one", async () => {
    renderGrid({ viewMode: mode });
    expect(await screen.findByText(/recommended/i)).toBeInTheDocument();
    expect(screen.getByTestId("comparison-grid")).not.toHaveTextContent("$0.00");
  });

  it("suppresses the recommendation once locked, without hiding the grid's own figures", async () => {
    renderGrid({ viewMode: mode, locked: true });
    expect(await screen.findByText("$1,824.37")).toBeInTheDocument();
    expect(screen.queryByText(/★ Recommended/)).not.toBeInTheDocument();
  });

  // ── fix round 1 (T2 review) — reviewer-proved gaps, added to the PARITY block on purpose: a
  // rows-only test would leave the same hole open in the columns direction next time. ──────────
  it("carries the recommendation reason as the badge's title", async () => {
    renderGrid({ viewMode: mode });
    expect(await screen.findByText("★ Recommended")).toHaveAttribute("title", "fastest transit");
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

  // ── S5.7 T4 — the maker's Select affordance, in the parity block on purpose: it is the only
  // control in this grid that opens a MUTATING dialog, so a view that forgot it (or shipped it
  // where it must not appear) is exactly the drift this suite exists to catch. ─────────────────
  it("clicking a priced offer's Select reports that offer's cell", async () => {
    const onShortlistOffer = vi.fn();
    renderGrid({ viewMode: mode, onShortlistOffer });
    await userEvent.click(await screen.findByTestId("shortlist-select-q1::DEDICATED"));
    expect(onShortlistOffer).toHaveBeenCalledTimes(1);
    expect(onShortlistOffer.mock.calls[0][0]).toMatchObject({
      key: "q1::DEDICATED",
      offer: { quoteId: "q1", variant: "DEDICATED" },
    });
  });

  it("does not let the Select affordance move the charge-breakdown selection", async () => {
    // The S5.6 Critical in miniature: the two affordances must stay independent, so pressing
    // Select never silently re-points what the READ side is showing (or vice versa).
    const onSelectOffer = vi.fn();
    renderGrid({ viewMode: mode, onSelectOffer });
    await userEvent.click(await screen.findByTestId("shortlist-select-q1::DEDICATED"));
    expect(onSelectOffer).not.toHaveBeenCalled();
  });

  it("gives an un-priced offer no Select button (never interactive)", async () => {
    renderGrid({ viewMode: mode });
    const unpriced = await screen.findByTestId("shortlist-select-q2::DEDICATED");
    expect(unpriced.tagName).not.toBe("BUTTON");
    expect(unpriced).toHaveTextContent("—");
    // Positive control: the priced offer in the SAME render does get a button.
    expect(screen.getByTestId("shortlist-select-q1::DEDICATED").tagName).toBe("BUTTON");
  });

  it("unmounts the Select affordance entirely once the award is locked", async () => {
    // Positive control first — the same fixture DOES render it when unlocked, so the absence
    // assertion below can't pass for the wrong reason.
    const { unmount } = renderGrid({ viewMode: mode });
    expect(await screen.findByTestId("shortlist-select-q1::DEDICATED")).toBeInTheDocument();
    unmount();

    renderGrid({ viewMode: mode, locked: true });
    expect(await screen.findByText("$1,824.37")).toBeInTheDocument(); // grid still rendered
    expect(screen.queryByTestId("shortlist-select-q1::DEDICATED")).not.toBeInTheDocument();
    expect(screen.queryByText("Shortlist")).not.toBeInTheDocument(); // no orphan row/column header
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

  it("tints every cell of the recommended column and stars its Status badge with the reason, without touching sibling columns", () => {
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

    const status = screen.getByTestId("offer-status-quote-1::DEDICATED");
    const badge = within(status).getByText("★ Recommended");
    expect(badge).toHaveAttribute(
      "title",
      "High priority → fastest transit (3 days); price broke the tie.",
    );
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
    expect(screen.queryByText("★ Recommended")).not.toBeInTheDocument();
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
    // badge — no crash, nothing flagged, rather than naming a nonexistent offer.
    expect(screen.queryByText("★ Recommended")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".bg-emerald-500\\/10")).toHaveLength(0);
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
  it("suppresses the recommendation tint and the Recommended badge once the award is locked", () => {
    // Post-generate, the WINNING quote is APPROVED — a status COMPARABLE_STATUSES excludes from
    // `offers` — so whatever `recommendation` still points at is ranked among the losers only.
    renderPanel(LEG, { locked: true });

    expect(screen.getByTestId("offer-header-quote-1::DEDICATED").closest("th")).not.toHaveClass(
      "bg-emerald-500/10",
    );
    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).not.toHaveClass("bg-emerald-500/10");
    expect(screen.queryByText("★ Recommended")).not.toBeInTheDocument();

    // …while the grid itself stays fully readable.
    expect(screen.getByTestId("offer-usd-quote-1::DEDICATED")).toHaveTextContent("$542.17");
    expect(screen.getByText("Acme Forwarding")).toBeInTheDocument();
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

  // ── S5.7 T4: the third ported `unsavedPick` regression test ───────────────────────────────
  // The S5.6 Critical (final review C1) lived at THIS seam and nowhere else: a click on a rival
  // offer's charge-breakdown header — a pure read gesture — moved the maker's pick, while
  // `POST /send-for-approval` carries no offer identity and re-reads the PERSISTED shortlist
  // server-side. The old test asserted the `unsavedPick` guard DISABLED Send in that state; with
  // the guard's root cause removed, the equivalent assertion is that the read gesture cannot
  // influence what a submit acts on at all. This is the only file that mounts the real
  // grid → dialog wiring, so the replacement stays here rather than moving to
  // `ShortlistDialog.test.tsx` with the other two.
  it("opening a rival offer's charge breakdown does not change which offer Select submits", async () => {
    const legWithSavedShortlist: LegComparisonDto = {
      ...LEG,
      awaitingReQuote: false,
      decision: {
        legId: "leg-1",
        status: "DRAFT",
        // Persisted on Acme's DEDICATED offer — the offer the old bug would have submitted.
        shortlistedQuoteId: "quote-1",
        shortlistedVariant: "DEDICATED",
        recommendedQuoteId: "quote-1",
        recommendedVariant: "DEDICATED",
        overrideReason: null,
        rejectionReason: null,
        sentByUserId: null,
        sentForApprovalAt: null,
        decidedByUserId: null,
        decidedAt: null,
      },
    };
    const shortlistBodies: unknown[] = [];
    renderPanel(legWithSavedShortlist, {
      fetch: (url, init) => {
        if (url.endsWith("/api/queries/q1/legs/leg-1/shortlist") && init?.method === "PUT") {
          shortlistBodies.push(JSON.parse((init.body as string) ?? "{}"));
          return { status: 200, body: { legId: "leg-1", status: "DRAFT" } };
        }
        return { status: 401, body: { message: "Unauthorized" } };
      },
    });

    // Read a THIRD offer's breakdown (quote-3), then close it — the gesture that used to re-point
    // the maker's pick behind the scenes.
    await userEvent.click(screen.getByTestId("offer-header-quote-3::DEDICATED"));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");

    // Now shortlist Globex's DEDICATED offer (quote-2) — neither the offer just inspected nor the
    // one already persisted.
    await userEvent.click(screen.getByTestId("shortlist-select-quote-2::DEDICATED"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/override reason/i), "cheaper");
    await userEvent.click(within(dialog).getByRole("button", { name: /^save shortlist$/i }));

    await waitFor(() => expect(shortlistBodies).toHaveLength(1));
    expect(shortlistBodies[0]).toMatchObject({ quoteId: "quote-2", variant: "DEDICATED" });
  });

  // ── S5.7 T4 — replaces MakerPanel.test.tsx's "the shortlist radio is disabled once the decision
  // is past DRAFT". `locked` (and a decision past DRAFT) must UNMOUNT the maker affordance, not
  // merely disable it. ─────────────────────────────────────────────────────────────────────────
  it("withholds the Select affordance once the leg's decision has left DRAFT", () => {
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

    // Positive control — an editable DRAFT (including a rejected leg, which comes back as DRAFT)
    // keeps its Select buttons.
    const draftRender = renderPanel({ ...LEG, decision: draft });
    expect(screen.getByTestId("shortlist-select-quote-1::DEDICATED")).toBeInTheDocument();
    draftRender.unmount();

    const pendingRender = renderPanel({ ...LEG, decision: { ...draft, status: "PENDING_APPROVAL" } });
    expect(screen.queryByTestId("shortlist-select-quote-1::DEDICATED")).not.toBeInTheDocument();
    pendingRender.unmount();

    renderPanel({ ...LEG, decision: { ...draft, status: "APPROVED" } });
    expect(screen.queryByTestId("shortlist-select-quote-1::DEDICATED")).not.toBeInTheDocument();
  });
});

// ── final review IMPORTANT #2 — the gate has to cover the OPEN dialog, not just the button ─────
// `ShortlistDialog` was the one maker control rendered outside `CompareLegPanel`'s `!locked` /
// `canShortlist` gates: its `shortlistCell` is resolved from `buildComparisonRowModel`, which knows
// nothing about `locked` or the decision status. So a background refetch that ended the maker's
// window — another user generating the client quote, or a second maker sending this leg for
// approval — dropped the Select row out of the grid while the ALREADY-OPEN dialog stayed live and
// submittable. The server 409s that submit, so the consequence was a dead end rather than a bad
// award, but the screen's contract is that the affordance is withheld, never offered-and-rejected.
//
// Both tests are driven by re-rendering the panel with a new `leg` — exactly what TanStack Query
// does when `["comparison", queryId]` refetches underneath it.
//
// The fix is a `canShortlist &&` guard on the JSX PLUS an effect that clears `shortlistKey`.
// Mutation-wise only the effect is separately provable: deleting it reddens the second test;
// deleting the guard leaves both green, because clearing the key empties `shortlistCell` and so
// unmounts the dialog anyway. The guard's remaining job is the one paint between the render that
// closes the window and the passive effect that clears the key — and RTL flushes effects before
// returning from `rerender`, so no assertion can sit in that gap. Both tests below therefore pin
// user-visible behaviour ("it goes away", "it does not come back"), not one mechanism each.
describe("ShortlistDialog is gated by the same rule as the Select button that opens it", () => {
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

  it("unmounts an already-open ShortlistDialog once the leg stops being shortlistable", async () => {
    const draftLeg = { ...LEG, decision: DRAFT_DECISION };
    const { refetchAs } = renderRefetchablePanel(draftLeg);

    await userEvent.click(screen.getByTestId("shortlist-select-quote-1::DEDICATED"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // A second maker sends this leg for approval; the refetch brings back PENDING_APPROVAL.
    refetchAs({ ...LEG, decision: { ...DRAFT_DECISION, status: "PENDING_APPROVAL" } });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // ...and the Select button is gone too, i.e. the grid and the dialog agree.
    expect(screen.queryByTestId("shortlist-select-quote-1::DEDICATED")).not.toBeInTheDocument();
  });

  it("does not silently re-open the dialog when the leg becomes shortlistable again", async () => {
    const draftLeg = { ...LEG, decision: DRAFT_DECISION };
    const { refetchAs } = renderRefetchablePanel(draftLeg);

    await userEvent.click(screen.getByTestId("shortlist-select-quote-1::DEDICATED"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    refetchAs({ ...LEG, decision: { ...DRAFT_DECISION, status: "PENDING_APPROVAL" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // A checker rejects the leg — `reject()` writes DRAFT + a reason, so shortlisting reopens. The
    // maker's stale pick must NOT come back as an open modal on its own (deferred minor T4 F3:
    // hiding the dialog without clearing `shortlistKey` left it primed to reappear).
    refetchAs({ ...LEG, decision: { ...DRAFT_DECISION, rejectionReason: "Too expensive" } });

    // Positive control — shortlisting really is available again, so "no dialog" isn't vacuous.
    expect(
      await screen.findByTestId("shortlist-select-quote-1::DEDICATED"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
