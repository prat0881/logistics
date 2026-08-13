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
        packageId: "pk1",
        packageNo: "PK-1",
        packageType: "BOX",
        packageCount: 1,
        dimL: "100",
        dimW: "100",
        dimH: "100",
        netWt: null,
        grossWt: "1000",
        volumeCbm: "1",
        tags: [],
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
  draft: null,
} as unknown as FfPortalLegDto;

const quotedLeg = {
  ...leg,
  status: "QUOTED",
} as unknown as FfPortalLegDto;

// Same leg, but with a warehouse endpoint + the frozen warehouseIncluded decision (design §9) —
// seedQuoteDraftWarehouse (draftFromDto's fresh-draft path) only produces a non-empty
// draft.warehouse for this fixture, not the base `leg` above (LegSection §6C finding #7).
const legWithWarehouse = {
  ...leg,
  warehouseIncluded: true,
  endpoints: [
    {
      pointId: "p1",
      type: "WAREHOUSE",
      name: "OAP Warehouse",
      country: "IN",
      code: "OAP",
      warehousePosition: "ORIGIN",
    },
  ],
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
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
  });
});

describe("LegSection legacy (pre-v2) manifest guard", () => {
  it("shows the re-issue notice instead of crashing when the manifest predates the v2 model", () => {
    const legacyLeg = {
      ...leg,
      // Pre-v2 frozen snapshot: cargo is not the per-package array the v2 UI expects.
      manifest: { cargo: { legacy: true } },
    } as unknown as FfPortalLegDto;
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legacyLeg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
        />,
      ),
    );
    // Degrades to the friendly notice for just this leg — no throw, no quote form.
    expect(screen.getByText(/created before a system update/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeDisabled();
  });
});

describe("LegSection sections & layout (design §6 finding #7)", () => {
  it("groups the quote form into labelled sections", () => {
    render(
      wrap(
        // Warehouse-inclusive fixture: this test asserts every section heading renders, which for
        // Warehousing is only true when the leg actually has a warehouse (see the dedicated
        // "warehouse section" describe block below for the conditional itself).
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithWarehouse}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
        />,
      ),
    );
    expect(screen.getByRole("heading", { name: /cargo & weight/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^charges$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /warehousing/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /transit plan/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^notes$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^terms$/i })).toBeInTheDocument();
  });
});

describe("LegSection warehouse section (design §6C finding #7)", () => {
  it("renders no Warehousing heading/section when the leg has no warehouse", () => {
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
    expect(screen.queryByRole("heading", { name: /warehousing/i })).not.toBeInTheDocument();
  });

  it("renders the Warehousing heading/section when the leg has a warehouse", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithWarehouse}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
        />,
      ),
    );
    expect(screen.getByRole("heading", { name: /warehousing/i })).toBeInTheDocument();
  });
});

describe("LegSection notes (design §6 finding #5)", () => {
  it("renders a Notes textarea, positioned immediately before the Accept-terms control", async () => {
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
    const notes = screen.getByLabelText(/^notes$/i);
    // showDgNote is false for this fixture (no DG-tagged cargo), so the Accept-terms checkbox is
    // the only checkbox on the page.
    const acceptTerms = screen.getByRole("checkbox");

    // DOM order: Notes precedes the Accept-terms control.
    expect(
      notes.compareDocumentPosition(acceptTerms) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await userEvent.type(notes, "Handle with care");
    expect(notes).toHaveValue("Handle with care");
  });

  it("includes the typed Notes value in the saved draft payload", async () => {
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
    await userEvent.type(screen.getByLabelText(/^notes$/i), "Fragile");
    await userEvent.click(screen.getByRole("button", { name: /save draft/i }));

    expect(fx).toHaveBeenCalledTimes(1);
    const [, init] = fx.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.notes).toBe("Fragile");
  });
});
