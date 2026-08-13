import { describe, it, expect, afterEach, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import type { FfPortalEndpoint, FfPortalLegDto, FfPortalRfqDto } from "@svyft/shared";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";
import { FfPortalPage } from "./FfPortalPage";
import { sectionAnchorId } from "./findingNav";

afterEach(() => vi.unstubAllGlobals());

const renderAt = (token: string) =>
  renderWithProviders(
    <Routes>
      <Route path="/ff/rfq/:token" element={<FfPortalPage />} />
    </Routes>,
    { route: `/ff/rfq/${token}` },
  );

const okRfq = {
  rfqNumber: "R-1",
  incoterms: "FOB",
  submissionDeadline: "2999-01-01T00:00:00.000Z",
  currency: "USD",
  quoteValidityUntil: "2999-02-01T00:00:00.000Z",
  freightForwarder: { companyName: "Acme" },
  legs: [],
};

describe("FfPortalPage terminal states", () => {
  it("shows the invalid-token card on 401", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/") ? { status: 401, body: {} } : { status: 401 },
      ),
    );
    renderAt("bad");
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it("renders the shell when loaded", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/tok") ? { status: 200, body: okRfq } : { status: 401 },
      ),
    );
    renderAt("tok");
    expect(await screen.findByText(/Acme/)).toBeInTheDocument();
  });

  it("shows the expired banner when the deadline is past", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/tok")
          ? {
              status: 200,
              body: { ...okRfq, submissionDeadline: "2000-01-01T00:00:00.000Z" },
            }
          : { status: 401 },
      ),
    );
    renderAt("tok");
    expect(await screen.findByText(/deadline has passed/i)).toBeInTheDocument();
  });
});

describe("FfPortalPage loading state", () => {
  it("shows a loading indicator while the rfq is being fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (typeof url === "string" && url.includes("/api/ff/rfq/")) return new Promise(() => {}); // never resolves → stays loading
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
        } as Response); // auth/me etc.
      }),
    );
    await act(async () => {
      renderAt("tok");
    });
    // The loading spinner/status should be visible before fetch resolves
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("usePortalHead integration", () => {
  it("sets the document title to the portal title", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/tok") ? { status: 200, body: okRfq } : { status: 401 },
      ),
    );
    renderAt("tok");
    await waitFor(() => {
      expect(document.title).toBe("Request for quote · Svyft Logistics");
    });
  });
});

// ── Round 4, #1/#2: leg accordion in route order (design §4.8) ──────────────────────────────
describe("FfPortalPage leg accordion + route order", () => {
  const p1: FfPortalEndpoint = {
    pointId: "p1",
    type: "PICKUP",
    name: "Origin",
    country: "IN",
    code: null,
    warehousePosition: null,
  };
  const p2: FfPortalEndpoint = {
    pointId: "p2",
    type: "AIRPORT",
    name: "Hub",
    country: "AE",
    code: "DXB",
    warehousePosition: null,
  };
  const p3: FfPortalEndpoint = {
    pointId: "p3",
    type: "DELIVERY",
    name: "Destination",
    country: "US",
    code: null,
    warehousePosition: null,
  };

  function leg(over: {
    legId: string;
    legCode: string;
    endpoints: FfPortalEndpoint[];
  }): FfPortalLegDto {
    return {
      legId: over.legId,
      quoteId: `Q-${over.legId}`,
      status: "RFQ_SENT",
      mode: "AIR",
      manifest: {
        legId: over.legId,
        legCode: over.legCode,
        legName: null,
        mode: "AIR",
        incoterms: null,
        origin: null,
        destination: null,
        readyDate: null,
        targetDelivery: null,
        cargo: [],
        frozenAt: "2026-08-01T00:00:00.000Z",
      },
      endpoints: over.endpoints,
      seededCharges: [],
      warehouseIncluded: false,
      draft: null,
    } as unknown as FfPortalLegDto;
  }

  // LEG-2 is listed FIRST in assignment order (rfq.legs), but LEG-1 comes first topologically
  // (p1->p2 precedes p2->p3) — proves rendering follows route order, not assignment order.
  const legL2 = leg({ legId: "L2", legCode: "LEG-2", endpoints: [p2, p3] });
  const legL1 = leg({ legId: "L1", legCode: "LEG-1", endpoints: [p1, p2] });

  const twoLegRfq: FfPortalRfqDto = {
    rfqNumber: "R-1",
    incoterms: "FOB",
    submissionDeadline: "2999-01-01T00:00:00.000Z",
    currency: "USD",
    quoteValidityUntil: "2999-02-01T00:00:00.000Z",
    freightForwarder: { companyName: "Acme" },
    legs: [legL2, legL1],
  };

  function stubTwoLegRfq() {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) =>
        url.includes("/api/ff/rfq/tok") ? { status: 200, body: twoLegRfq } : { status: 401 },
      ),
    );
  }

  it("(a) renders leg headers in route-topology order, not rfq.legs assignment order", async () => {
    stubTwoLegRfq();
    renderAt("tok");
    await screen.findByText(/Acme/i);

    const headers = screen.getAllByRole("button", { name: /^LEG-\d/ });
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent("LEG-1");
    expect(headers[1]).toHaveTextContent("LEG-2");
  });

  it("(c) opens the first leg (route order) by default; the second leg's header still shows its code + status while collapsed", async () => {
    stubTwoLegRfq();
    renderAt("tok");
    await screen.findByText(/Acme/i);

    // L1 (route-first) is open → its density section is mounted; L2's is not.
    expect(document.getElementById(sectionAnchorId("L1", "density"))).not.toBeNull();
    expect(document.getElementById(sectionAnchorId("L2", "density"))).toBeNull();

    // L2's header (leg code + status) still renders even though its body is collapsed.
    const l2Header = screen.getByRole("button", { name: /LEG-2/, expanded: false });
    expect(l2Header).toHaveTextContent("LEG-2");
    expect(l2Header).toHaveTextContent(/open for quoting/i);
  });

  it("(b) expands exactly one leg at a time — opening the second leg collapses the first", async () => {
    stubTwoLegRfq();
    renderAt("tok");
    await screen.findByText(/Acme/i);
    expect(document.getElementById(sectionAnchorId("L1", "density"))).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /LEG-2/, expanded: false }));

    expect(document.getElementById(sectionAnchorId("L1", "density"))).toBeNull();
    expect(document.getElementById(sectionAnchorId("L2", "density"))).not.toBeNull();
    // Exactly one leg's Submit button exists at a time (proves L1's body truly unmounted, not just
    // visually hidden, and L2's genuinely mounted — not a coincidental count).
    expect(screen.getAllByRole("button", { name: /submit quote/i })).toHaveLength(1);
  });
});
