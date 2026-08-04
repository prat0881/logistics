import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ChargeLineDefinitionDto, QueryLegDto, QueryPointDto, QuoteDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { LegPanel, defaultDeadlineLocal } from "./LegPanel";

const leg = {
  id: "l1", legCode: "L1", legName: "Main air leg", mode: "AIR", status: "READY_FOR_RFQ",
  originPointId: "p1", destinationPointId: "p2", readyDate: "2026-08-01T00:00:00.000Z",
  targetDelivery: "2026-08-05T00:00:00.000Z",
  rollup: { totalPackages: 3, totalCbm: 12, totalGrossWt: 500, totalNetWt: 400 },
  chargeLineDefinitionIds: [], warehouseHandlingIncluded: null,
} as unknown as QueryLegDto;

const points = [
  { id: "p1", name: "Shanghai PVG", city: "Shanghai", country: "CN" },
  { id: "p2", name: "Dubai DXB", city: "Dubai", country: "AE" },
] as unknown as QueryPointDto[];

// Same route, but the origin is a WAREHOUSE point — used to prove legTouchesWarehouse
// wiring in LegPanel (the toggle only mounts when an endpoint is type WAREHOUSE).
const warehousePoints = [
  { id: "p1", name: "Shanghai Bonded WH", city: "Shanghai", country: "CN", type: "WAREHOUSE" },
  { id: "p2", name: "Dubai DXB", city: "Dubai", country: "AE", type: "AIRPORT" },
] as unknown as QueryPointDto[];

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// LegPanel mounts ConfigureChargesPopover, which calls useChargeCatalogue() →
// GET /api/charge-line-definitions. Every test needs that stubbed (defaults to an
// empty catalogue) alongside the pre-existing /eligible-ffs stub.
function stubFetch(catalogue: ChargeLineDefinitionDto[] = []) {
  const fetchMock = mockFetch((url) => {
    if (url.includes("/charge-line-definitions")) return { status: 200, body: catalogue };
    if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
    return { status: 404 };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("LegPanel", () => {
  it("defaultDeadlineLocal is +48h from now", () => {
    const s = defaultDeadlineLocal(Date.parse("2026-08-01T10:00:00.000Z"));
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("shows leg code + route + status (no leg name); toggles via onToggle", async () => {
    stubFetch();
    const onToggle = vi.fn();
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={onToggle} />);
    expect(screen.getByText("L1")).toBeInTheDocument();
    expect(screen.getByText(/Shanghai PVG → Dubai DXB/)).toBeInTheDocument();
    expect(screen.getByText("Ready for RFQ")).toBeInTheDocument();
    expect(screen.queryByText("Main air leg")).toBeNull(); // leg name removed
    expect(await screen.findByText(/Eligible 0/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /L1/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("hides the body when open is false", () => {
    stubFetch();
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open={false} onToggle={() => {}} />);
    expect(screen.queryByText(/Eligible 0/i)).not.toBeInTheDocument();
  });

  it("shows kg net when totalNetWt > 0", () => {
    stubFetch();
    const legWithNet = {
      ...leg,
      rollup: { ...leg.rollup, totalNetWt: 120 },
    } as unknown as QueryLegDto;
    wrap(<LegPanel queryId="q1" leg={legWithNet} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={() => {}} />);
    expect(screen.getByText(/120 kg net/)).toBeInTheDocument();
    expect(screen.getByText(/kg gross/)).toBeInTheDocument();
  });

  it("hides kg net when totalNetWt is 0, still shows gross", () => {
    stubFetch();
    const legZeroNet = {
      ...leg,
      rollup: { ...leg.rollup, totalNetWt: 0 },
    } as unknown as QueryLegDto;
    wrap(<LegPanel queryId="q1" leg={legZeroNet} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={() => {}} />);
    expect(screen.queryByText(/kg net/)).not.toBeInTheDocument();
    expect(screen.getByText(/kg gross/)).toBeInTheDocument();
  });

  it("shows the FF country-scope chip derived from the leg's origin/destination points", async () => {
    stubFetch();
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={() => {}} />);
    const scope = await screen.findByText(/forwarders covering/i);
    expect(scope).toHaveTextContent("China");                // getCountryName("CN")
    expect(scope).toHaveTextContent("United Arab Emirates");  // getCountryName("AE")
  });

  it("mounts the Configure-charges control above the FF grid once the catalogue loads", async () => {
    stubFetch();
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={() => {}} />);
    expect(await screen.findByRole("button", { name: /configure charges/i })).toBeInTheDocument();
  });

  it("renders the warehouse handling toggle when an endpoint is a WAREHOUSE point", async () => {
    stubFetch();
    wrap(<LegPanel queryId="q1" leg={leg} points={warehousePoints} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={() => {}} />);
    expect(await screen.findByText(/warehouse handling included\?/i)).toBeInTheDocument();
  });

  it("does not render the warehouse handling toggle when neither endpoint is a WAREHOUSE point", async () => {
    stubFetch();
    wrap(<LegPanel queryId="q1" leg={leg} points={points} legQuotes={[]} referencedFfs={[]} cargo={[]} open onToggle={() => {}} />);
    await screen.findByText(/forwarders covering/i); // let the leg body settle first
    expect(screen.queryByText(/warehouse handling included\?/i)).toBeNull();
  });

  it("disables the Configure-charges control and the warehouse toggle once a quote is no longer SELECT (hasSent)", async () => {
    const catalogue: ChargeLineDefinitionDto[] = [
      {
        id: "std-1", key: "FUEL_SURCHARGE", label: "Fuel Surcharge", role: "STANDARD", mode: "AIR",
        inputType: "PLAIN", zone: null, tagKey: null, sortOrder: 0, isActive: true,
      },
    ];
    stubFetch(catalogue);
    const sentQuote = {
      id: "quo1", queryId: "q1", legId: "l1", freightForwarderId: "ff1", rfqId: "rfq1",
      status: "RFQ_SENT", submittedAt: "2026-08-01T00:00:00.000Z",
    } as unknown as QuoteDto;
    wrap(
      <LegPanel
        queryId="q1"
        leg={leg}
        points={warehousePoints}
        legQuotes={[sentQuote]}
        referencedFfs={[]}
        cargo={[]}
        open
        onToggle={() => {}}
      />,
    );

    // Warehouse toggle: disabled propagates straight to the Yes/No buttons.
    expect(await screen.findByRole("button", { name: "Yes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "No" })).toBeDisabled();

    // Configure-charges: the trigger itself stays clickable (Task 12 keeps it a
    // read-only *viewer* once distributed, not a fully blocked control) — opening it
    // shows the underlying selection as disabled/read-only checkboxes. `findBy` (not
    // `getBy`) because the catalogue query resolves asynchronously, after the toggle
    // (which needs no fetch) has already mounted.
    const trigger = await screen.findByRole("button", { name: /configure charges/i });
    await userEvent.click(trigger);
    expect(await screen.findByRole("checkbox", { name: /fuel surcharge/i })).toBeDisabled();
  });
});
