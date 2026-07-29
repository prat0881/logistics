import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { LegSection } from "./LegSection";
import type { FfPortalLegDto, FfPortalRfqDto } from "@svyft/shared";

afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
};

const rfq = {
  rfqNumber: "R-1",
  incoterms: "FOB",
  submissionDeadline: "2999-01-01T00:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2999-02-01T00:00:00.000Z",
  freightForwarder: { companyName: "Acme" },
  legs: [],
} as FfPortalRfqDto;

// AIR leg with one unpriced preset charge (amount: null) — will fail Q3/charges validation
const leg = {
  legId: "L1",
  quoteId: "Q1",
  status: "RFQ_SENT",
  mode: "AIR",
  manifest: {
    cargo: [
      {
        cargoItemId: "c1",
        poReference: "PO-1",
        productName: "P",
        packageType: "Box",
        isDangerous: false,
        qty: 1,
        dimL: "1",
        dimW: "1",
        dimH: "1",
        grossWt: "1000",
        volumeCbm: "1",
        hsCode: null,
        netWt: null,
      },
    ],
  },
  endpoints: [],
  seededCharges: [
    {
      zone: "MAIN_FREIGHT",
      presetKey: "AIR_MAIN_FREIGHT",
      label: "Air Freight",
      isPreset: true,
      amount: null,
    },
  ],
  seededDensity: [{ cargoItemId: "c1", freightDensity: 167 }],
  draft: null,
} as unknown as FfPortalLegDto;

const quotedLeg = {
  ...leg,
  status: "QUOTED",
} as unknown as FfPortalLegDto;

describe("LegSection submit gate", () => {
  it("blocks submit on client findings and does not POST", async () => {
    const fx = mockFetch(() => ({ status: 200, body: {} }));
    vi.stubGlobal("fetch", fx);
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument(); // findings shown (charges unpriced etc.)
    expect(fx).not.toHaveBeenCalled(); // client gate: zero network calls on invalid submit
  });
});

describe("LegSection QUOTED branch", () => {
  it("renders AlreadySubmittedSummary for QUOTED leg and hides Submit button", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={quotedLeg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
        />,
      ),
    );
    expect(screen.getByText(/quote submitted/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /submit quote/i }),
    ).not.toBeInTheDocument();
  });
});

describe("LegSection readOnly", () => {
  it("disables the Submit button when readOnly=true", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={true}
        />,
      ),
    );
    expect(
      screen.getByRole("button", { name: /submit quote/i }),
    ).toBeDisabled();
  });
});
