import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LegComparisonDto } from "@svyft/shared";
import { CompareLegPanel } from "./CompareLegPanel";
import { OfferDetail } from "./OfferDetail";

// FF1 ("Acme Forwarding") prices BOTH Road variants off one submitted quote (`quote-1`) — the
// same `quoteId` fans out into two `OfferDto` rows (DEDICATED/GROUPAGE) exactly as
// comparison.service.ts's `buildLeg` does, so the grid's column identity must be
// (quoteId, variant), not quoteId alone.
const FF1_DEDICATED_CHARGES = [
  { label: "Freight", group: "freight", nativeAmount: 40000, usdAmount: 481.93 },
  { label: "Additional Charges", group: "additional", nativeAmount: 4000, usdAmount: 48.19 },
  // Deliberately 1 cent off usdTotal (542.17) when summed — 481.93 + 48.19 + 12.06 = 542.18 —
  // mirrors the T1-flagged per-line rounding drift on foreign-currency legs (Σ usdAmount can
  // differ from usdTotal by a cent). OfferDetail must show usdTotal, never a client-side sum.
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
      unitsPerUsd: 83,
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
      // would otherwise render a fake-looking $0.00 total in OfferDetail if not guarded against.
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

function renderPanel(leg: LegComparisonDto = LEG) {
  return render(<CompareLegPanel leg={leg} open onToggle={() => {}} />);
}

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

  it("flags the recommended offer's column and renders the recommendation banner", () => {
    renderPanel();

    const header = screen.getByTestId("offer-header-quote-1::DEDICATED");
    expect(within(header).getByText("Recommended")).toBeInTheDocument();

    const banner = screen.getByTestId("recommendation-banner");
    expect(within(banner).getByText(/Acme Forwarding/)).toBeInTheDocument();
    expect(within(banner).getByText(/Dedicated/)).toBeInTheDocument();
    expect(
      within(banner).getByText(/High priority.*fastest transit.*price broke the tie/),
    ).toBeInTheDocument();
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

    // Even so, clicking it must never surface OfferDetail's money — belt + suspenders. (Exact
    // string, not a substring regex: "0.00 INR" would also match the tail of a real total like
    // "45,000.00 INR", so this checks for the fake-zero text as its own standalone node.)
    await userEvent.click(header);
    expect(screen.queryByTestId("offer-detail-total-usd")).not.toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("0.00 INR")).not.toBeInTheDocument();
  });

  it("OfferDetail itself refuses to render a money total for an un-priced offer (defense in depth)", () => {
    const unpriced = LEG.offers.find((o) => o.quoteId === "quote-2" && o.variant === "GROUPAGE")!;
    render(<OfferDetail offer={unpriced} />);

    expect(screen.getByText(/not priced by this forwarder/i)).toBeInTheDocument();
    expect(screen.queryByTestId("offer-detail-total-usd")).not.toBeInTheDocument();
    // The two real zero-amount "Additional Charges"/"Warehousing" lines buildCharges emits for an
    // un-priced offer must not leak through as a charges table either.
    expect(screen.queryByText("Additional Charges")).not.toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
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

  it("expands an offer's itemised charges on header click, using usdTotal as the authoritative total", async () => {
    renderPanel();

    expect(screen.queryByText("Warehousing")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("offer-header-quote-1::DEDICATED"));

    expect(screen.getByText("Freight")).toBeInTheDocument();
    expect(screen.getByText("Warehousing")).toBeInTheDocument();

    // charges' own usdAmount sum is 542.18 (481.93 + 48.19 + 12.06) — 1 cent off the offer's
    // authoritative usdTotal (542.17). The rendered total must be the latter, never the former.
    const total = screen.getByTestId("offer-detail-total-usd");
    expect(total).toHaveTextContent("$542.17");
    expect(total).not.toHaveTextContent("$542.18");

    // Clicking the same header again collapses the detail.
    await userEvent.click(screen.getByTestId("offer-header-quote-1::DEDICATED"));
    expect(screen.queryByText("Warehousing")).not.toBeInTheDocument();
  });

  it("keeps the leg-body offer-count summary the page test relies on", () => {
    renderPanel();
    expect(screen.getByTestId("leg-body")).toHaveTextContent("5 offers received");
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

  it("renders no banner and flags no column when the leg has no recommendation", () => {
    renderPanel({ ...LEG, recommendation: null });

    expect(screen.queryByTestId("recommendation-banner")).not.toBeInTheDocument();
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
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

    // Neither the banner (RecommendationBanner's own `.find()` returns undefined) nor any column
    // flag renders — no crash, nothing shown, rather than a banner naming a nonexistent offer.
    expect(screen.queryByTestId("recommendation-banner")).not.toBeInTheDocument();
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
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
});
