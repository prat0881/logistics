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
const secondLeg = {
  ...baseLeg, id: "l2", legCode: "L2", legName: "Sea leg", originPointId: "p2", destinationPointId: "p1",
};
function twoLegDetail(status: string) {
  const d = makeQueryDetail(status);
  return { ...d, legs: [baseLeg, secondLeg] };
}

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
    if (url.includes("/charge-line-definitions")) return { status: 200, body: [] };
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
    expect(screen.getByText(/PVG → DXB/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /distribute all/i }));
    // the skipped-summary line rendered (single text node — robust)
    expect(await screen.findByText(/nothing selected/i)).toBeInTheDocument();
    // 1) "L1" appears in the leg panel toggle button (leg code chip)
    const legToggleBtn = screen.getByRole("button", { name: /^L1/ });
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

  it("shows Route overview section for distributed status too (RFQ_SENT)", async () => {
    stubFetch(makeQueryDetail("RFQ_SENT"));
    wrap(<RfqWorkspace queryId="q1" />);
    await screen.findByText("YAL26-0001");
    expect(screen.getByRole("region", { name: /route overview/i })).toBeInTheDocument();
  });

  it("single-expands legs (first open by default) and Collapse All closes them", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.endsWith("/api/queries/q1")) return { status: 200, body: twoLegDetail("RFQ_READY") };
      if (url.includes("/rfq-state")) return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      if (url.includes("/charge-line-definitions")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(<RfqWorkspace queryId="q1" />);
    await screen.findByText("YAL26-0001");
    // first leg (L1) open by default → its deadline field is present; L2's is not
    expect(await screen.findByLabelText(/submission deadline/i)).toBeInTheDocument();
    expect(screen.getAllByLabelText(/submission deadline/i)).toHaveLength(1);
    // open L2 → L1 collapses (still exactly one deadline field, now L2's)
    await userEvent.click(screen.getByRole("button", { name: /^L2/ }));
    expect(screen.getAllByLabelText(/submission deadline/i)).toHaveLength(1);
    // Collapse All → no open leg bodies
    await userEvent.click(screen.getByRole("button", { name: /collapse all/i }));
    expect(screen.queryByLabelText(/submission deadline/i)).not.toBeInTheDocument();
  });

  it("opens a leg when its edge is clicked in the route diagram", async () => {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.endsWith("/api/queries/q1")) return { status: 200, body: twoLegDetail("RFQ_READY") };
      if (url.includes("/rfq-state")) return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      if (url.includes("/charge-line-definitions")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(<RfqWorkspace queryId="q1" />);
    await screen.findByText("YAL26-0001");
    // L1 open by default → deadline-l1 in DOM, deadline-l2 not
    expect(document.getElementById("deadline-l1")).toBeTruthy();
    expect(document.getElementById("deadline-l2")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Leg L2/ }));
    expect(document.getElementById("deadline-l2")).toBeTruthy();
    expect(document.getElementById("deadline-l1")).toBeNull();
  });
});
