import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

const requotedLeg = {
  ...leg,
  status: "REQUOTED",
} as unknown as FfPortalLegDto;

// A retained draft (ff-portal.service.ts's requote path keeps the FF's prior submission, so the
// portal must show it back rather than a blank form — QuoteDraft-shaped, chargedWeightKg is the
// simplest unconditionally-rendered numeric field (CargoWeightTable) to assert on).
const draftWithPrices = {
  legId: "L1",
  mode: "AIR",
  currency: null,
  quoteValidityUntil: null,
  chargedWeightKg: 1250,
  notes: null,
  cargo: [{ packageId: "pk1", grossWtKg: 1000, cbm: 1 }],
  charges: [],
  trucking: [],
  seaRates: [],
  warehouse: [],
  transit: null,
  dgSurchargeNote: null,
  termsConditions: null,
} as unknown as FfPortalLegDto["draft"];

const requotedLegWithDraft = {
  ...leg,
  status: "REQUOTED",
  draft: draftWithPrices,
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
          open={true}
          onOpen={() => {}}
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
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByText(/quote submitted/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
  });
});

describe("LegSection REQUOTED branch (the negotiate feature's dead end, S5.9 §1)", () => {
  it("lets the forwarder revise a price on a REQUOTED leg", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={requotedLeg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.queryByText(/not open for quoting/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeEnabled();
  });

  it("shows the forwarder their retained draft rather than a blank form", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={requotedLegWithDraft}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByDisplayValue("1250")).toBeInTheDocument();
  });
});

describe("LegSection outcome-status neutrality (design D9)", () => {
  it("never tells the forwarder a commercial outcome", () => {
    for (const status of ["PENDING_APPROVAL", "APPROVED"] as const) {
      const statusLeg = { ...leg, status } as unknown as FfPortalLegDto;
      const { unmount } = render(
        wrap(
          <LegSection
            token="tok"
            rfq={rfq}
            leg={statusLeg}
            currency="USD"
            quoteValidityUntil={rfq.quoteValidityUntil}
            readOnly={false}
            open={true}
            onOpen={() => {}}
          />,
        ),
      );
      expect(screen.getByText("Under review")).toBeInTheDocument();
      expect(screen.queryByText(/approved/i)).not.toBeInTheDocument();
      unmount();
    }
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
          open={true}
          onOpen={() => {}}
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
          open={true}
          onOpen={() => {}}
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
          open={true}
          onOpen={() => {}}
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
          open={true}
          onOpen={() => {}}
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
          open={true}
          onOpen={() => {}}
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
          open={true}
          onOpen={() => {}}
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
          open={true}
          onOpen={() => {}}
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

// ── Round 4, #1/#2: accordion header + open-gating (design §4.8) ────────────────────────────
describe("LegSection accordion header (design §4.8 finding #1)", () => {
  // The base `leg` fixture above only populates manifest.cargo (irrelevant to the header) — build
  // a fuller one here so the header's leg-code/route/status text is actually checkable.
  const legWithHeader = {
    ...leg,
    manifest: {
      ...leg.manifest,
      legCode: "AIR-1",
      origin: { country: "IN", name: "Mumbai WH", city: "Mumbai" },
      destination: { country: "AE", name: "Dubai Airport", city: "Dubai" },
    },
  } as unknown as FfPortalLegDto;

  it("shows the header (leg code, route, status) even when collapsed (open=false)", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithHeader}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={() => {}}
        />,
      ),
    );
    const header = screen.getByRole("button", { name: /AIR-1/, expanded: false });
    expect(header).toHaveTextContent("AIR-1");
    expect(header).toHaveTextContent(/Mumbai WH.*Dubai Airport/);
    expect(header).toHaveTextContent(/open for quoting/i);
  });

  it("hides the leg body when collapsed (open=false) — no Submit button, no form sections", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithHeader}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: /submit quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /cargo & weight/i })).not.toBeInTheDocument();
  });

  it("shows the leg body when open=true (the header stays too)", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithHeader}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={() => {}}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: /submit quote/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AIR-1/, expanded: true })).toBeInTheDocument();
  });

  it("calls onOpen when the collapsed header is clicked", async () => {
    const onOpen = vi.fn();
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={legWithHeader}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={onOpen}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /AIR-1/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("a QUOTED (terminal) leg is also collapsible — header shows even when closed, summary hidden", () => {
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={quotedLeg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={false}
          onOpen={() => {}}
        />,
      ),
    );
    // Header renders (an aria-expanded=false toggle exists) even though the leg is QUOTED...
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    // ...but AlreadySubmittedSummary's own body is hidden until opened.
    expect(screen.queryByText(/quote submitted/i)).not.toBeInTheDocument();
  });
});

// ── Round 4, #1: findingNav force-opens a leg before scrolling ──────────────────────────────
describe("LegSection findingNav force-open (design §4.8 finding #1)", () => {
  it("calls onOpen when a validation finding is clicked (force-open before scroll)", async () => {
    const onOpen = vi.fn();
    render(
      wrap(
        <LegSection
          token="tok"
          rfq={rfq}
          leg={leg}
          currency="USD"
          quoteValidityUntil={rfq.quoteValidityUntil}
          readOnly={false}
          open={true}
          onOpen={onOpen}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /submit quote/i }));
    const alert = await screen.findByRole("alert");
    const findingButton = within(alert).getAllByRole("button")[0];

    await userEvent.click(findingButton);

    expect(onOpen).toHaveBeenCalled();
  });
});
