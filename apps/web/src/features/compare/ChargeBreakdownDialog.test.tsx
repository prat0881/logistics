import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OfferDto } from "@svyft/shared";
import { ChargeBreakdownDialog, ChargeTreeTable } from "./ChargeBreakdownDialog";
import type { ChargeNode } from "./chargeTree";

// Mirrors the shared default fixture used across comparisonRowModel.test.ts /
// ComparisonGrid.test.tsx's PARITY_PRICED_OFFER (nativeTotal 6700 AED / 3.6725 / usdTotal
// 1824.37 / 3 days) so this dialog's numbers aren't a one-off invention. The three charge lines
// deliberately sum to 1_824.36 (1143.63 + 571.82 + 108.91) — ONE CENT off the offer's own
// authoritative `usdTotal` of 1_824.37 — to mirror the same per-line-rounding drift the previous
// inline breakdown block used to guard against (S5.6 T1 review Minor #1). The dialog must render `offer.usdTotal`, never
// a client-side sum of the lines.
const OFFER: OfferDto = {
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
  charges: [
    { label: "Freight", group: "freight", nativeAmount: 4200, usdAmount: 1143.63 },
    { label: "Additional Charges", group: "additional", nativeAmount: 2100, usdAmount: 571.82 },
    { label: "Warehousing", group: "warehouse", nativeAmount: 400, usdAmount: 108.91 },
  ],
};

describe("ChargeBreakdownDialog", () => {
  it("shows the offer's authoritative usdTotal, not the sum of its lines", async () => {
    // fixture lines deliberately sum to 1_824.36 while usdTotal is 1_824.37
    render(
      <ChargeBreakdownDialog
        open
        offer={OFFER}
        legLabel="L1 · A → B"
        fxAsOf="2026-08-17T09:00:00.000Z"
        onOpenChange={() => {}}
      />,
    );
    expect(await screen.findByTestId("charge-total")).toHaveTextContent("$1,824.37");
    expect(screen.getByTestId("charge-total")).not.toHaveTextContent("$1,824.36");
  });

  it("states the conversion rate used", async () => {
    render(
      <ChargeBreakdownDialog
        open
        offer={OFFER}
        legLabel="L1 · A → B"
        fxAsOf="2026-08-17T09:00:00.000Z"
        onOpenChange={() => {}}
      />,
    );
    expect(await screen.findByText(/3\.67250 AED per USD/)).toBeInTheDocument();
  });

  it("renders a not-priced state instead of any money figure", async () => {
    render(
      <ChargeBreakdownDialog
        open
        offer={{ ...OFFER, priced: false, usdTotal: null }}
        legLabel="L1 · A → B"
        fxAsOf={null}
        onOpenChange={() => {}}
      />,
    );
    expect(await screen.findByText(/not priced/i)).toBeInTheDocument();
    expect(screen.queryByTestId("charge-total")).not.toBeInTheDocument();
  });

  // Mutation guard for the carried-over regression (S5.6): without the `!offer.priced`
  // short-circuit running BEFORE any total is rendered, an unpriced offer's two real (not fake)
  // zero-valued charge lines would still sum/format into a "$0.00" total — the exact anti-pattern
  // the grid's own greying guards against. Killing the short-circuit in the component turns this
  // test (and the one above) red.
  it("never renders a charge line or $0.00 for an unpriced offer", async () => {
    render(
      <ChargeBreakdownDialog
        open
        offer={{
          ...OFFER,
          priced: false,
          usdTotal: null,
          nativeTotal: 0,
          charges: [
            { label: "Additional Charges", group: "additional", nativeAmount: 0, usdAmount: 0 },
            { label: "Warehousing", group: "warehouse", nativeAmount: 0, usdAmount: 0 },
          ],
        }}
        legLabel="L1 · A → B"
        fxAsOf={null}
        onOpenChange={() => {}}
      />,
    );
    await screen.findByText(/not priced/i);
    expect(screen.queryByText("Additional Charges")).not.toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });
});

// ── ChargeTreeTable — the tree-shaped rendering unit (S5.7 T3) ───────────────────────────────────
// `buildChargeTree` can only ever emit `children: []` today (the API has no itemised lines to
// nest — see chargeTree.ts / the design's C2). So the caret-toggle / nested-row branch below has
// nothing in production that reaches it. It is deliberately kept anyway (tree-shaped from the
// start, per the coordinator's ambiguity resolution #2) so a later, richer read model only needs a
// new mapping function — not a rewrite of this component. Proving it here, against a HAND-BUILT
// `ChargeNode` with a child, is what keeps it from being untested dead code a reviewer would
// (rightly) flag.
const CHILD_NODE: ChargeNode = {
  id: "additional-0-fuel",
  label: "Fuel surcharge",
  nativeAmount: 500,
  usdAmount: 136.15,
  children: [],
};

const PARENT_WITH_CHILD: ChargeNode = {
  id: "additional-0",
  label: "Additional Charges",
  nativeAmount: 2100,
  usdAmount: 571.82,
  children: [CHILD_NODE],
};

const LEAF_NODE: ChargeNode = {
  id: "warehouse-0",
  label: "Warehousing",
  nativeAmount: 400,
  usdAmount: 108.91,
  children: [],
};

describe("ChargeTreeTable", () => {
  it("renders a caret only for a node that actually has children", () => {
    render(<ChargeTreeTable nodes={[PARENT_WITH_CHILD, LEAF_NODE]} currency="AED" />);

    expect(screen.getByTestId(`charge-toggle-${PARENT_WITH_CHILD.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`charge-toggle-${LEAF_NODE.id}`)).not.toBeInTheDocument();
  });

  it("keeps a child row hidden until its parent's caret is toggled open", async () => {
    const user = userEvent.setup();
    render(<ChargeTreeTable nodes={[PARENT_WITH_CHILD]} currency="AED" />);

    expect(screen.queryByText("Fuel surcharge")).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`charge-toggle-${PARENT_WITH_CHILD.id}`));
    expect(screen.getByText("Fuel surcharge")).toBeInTheDocument();

    await user.click(screen.getByTestId(`charge-toggle-${PARENT_WITH_CHILD.id}`));
    expect(screen.queryByText("Fuel surcharge")).not.toBeInTheDocument();
  });
});
