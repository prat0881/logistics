import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { RfqWorkspace } from "./RfqWorkspace";

const basePoints = [
  { id: "p1", name: "PVG", city: "Shanghai", country: "CN", type: "AIRPORT",
    tenantId: null, queryId: "q1", streetAddress: null, postalCode: null,
    contactName: null, contactPhone: null, contactEmail: null, warehouseType: null,
    iataCode: "PVG", icaoCode: null, unLocode: null, terminal: null, timezone: null,
    createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
  { id: "p2", name: "DXB", city: "Dubai", country: "AE", type: "AIRPORT",
    tenantId: null, queryId: "q1", streetAddress: null, postalCode: null,
    contactName: null, contactPhone: null, contactEmail: null, warehouseType: null,
    iataCode: "DXB", icaoCode: null, unLocode: null, terminal: null, timezone: null,
    createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" },
];
const baseLeg = {
  id: "l1", legCode: "L1", legName: "Air leg", mode: "AIR", status: "READY_FOR_RFQ",
  originPointId: "p1", destinationPointId: "p2", readyDate: null, targetDelivery: null,
  assignedCargoIds: [], rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
};

function makeQueryDetail(status: string) {
  return {
    id: "q1", queryCode: "YAL26-0001", incoterms: "FOB", status,
    tenantId: null, queryDate: "2025-01-01", priority: "NORMAL",
    responseDeadline: null, responseDeadlineRemarks: null, clientId: null,
    contactName: null, contactDesignation: null, contactEmail: null, contactPhone: null,
    whatsappEnabled: false, faxNumber: null, vesselId: null, vesselName: null,
    imoNumber: null, eta: null, etb: null, etd: null, portOfCall: null,
    shipmentDescription: null, dgIndicator: false, readyDate: null, targetDelivery: null,
    readyDateTimezone: null, targetDeliveryTimezone: null, internalNotes: null,
    rfqReadyAt: null, assignedUserId: null,
    createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    freightMode: ["AIR"],
    origin: [{ id: "p1", name: "PVG", city: "Shanghai", country: "CN" }],
    destination: [{ id: "p2", name: "DXB", city: "Dubai", country: "AE" }],
    cargo: [], checklist: [], files: [],
    points: basePoints,
    legs: [baseLeg],
  };
}

// Backwards-compatible alias used by the first test
const queryDetail = makeQueryDetail("RFQ_READY");

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

function stubFetch(detail: ReturnType<typeof makeQueryDetail>) {
  vi.stubGlobal("fetch", mockFetch((url, init) => {
    if (url.endsWith("/api/queries/q1")) return { status: 200, body: detail };
    if (url.includes("/rfq-state")) return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
    if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
    if (url.includes("/distribute-all") && init?.method === "POST")
      return { status: 201, body: { rfqs: [], distributedLegIds: [], skipped: [{ legId: "l1", reason: "nothing-selected" }] } };
    return { status: 404 };
  }));
}

describe("RfqWorkspace", () => {
  it("renders header + leg panels and runs Distribute All", async () => {
    stubFetch(queryDetail);

    wrap(<RfqWorkspace queryId="q1" />);
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByText("Air leg")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /distribute all/i }));
    // the skipped-summary line rendered (single text node — robust)
    expect(await screen.findByText(/nothing selected/i)).toBeInTheDocument();
    // 1) "L1" appears in the leg panel toggle button (leg code chip)
    const legToggleBtn = screen.getByRole("button", { name: /Air leg/i });
    expect(within(legToggleBtn).getByText("L1")).toBeInTheDocument();
    // 2) "L1" appears in the skipped-distribution result paragraph
    const skippedLine = screen.getByText(/skipped/i);
    expect(skippedLine).toHaveTextContent(/L1/);
  });

  it("shows Route overview section for pre-distribution status (RFQ_READY)", async () => {
    stubFetch(makeQueryDetail("RFQ_READY"));
    wrap(<RfqWorkspace queryId="q1" />);
    await screen.findByText("YAL26-0001");
    expect(screen.getByRole("region", { name: /route overview/i })).toBeInTheDocument();
  });

  it("hides Route overview section for distributed status (RFQ_SENT)", async () => {
    stubFetch(makeQueryDetail("RFQ_SENT"));
    wrap(<RfqWorkspace queryId="q1" />);
    await screen.findByText("YAL26-0001");
    expect(screen.queryByRole("region", { name: /route overview/i })).toBeNull();
  });
});
