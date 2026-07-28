import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { RfqWorkspace } from "./RfqWorkspace";

const queryDetail = {
  id: "q1", queryCode: "YAL26-0001", incoterms: "FOB", status: "RFQ_READY",
  freightMode: ["AIR"], origin: [{ id: "p1", name: "PVG", city: "Shanghai", country: "CN" }],
  destination: [{ id: "p2", name: "DXB", city: "Dubai", country: "AE" }], cargo: [], points: [
    { id: "p1", name: "PVG", city: "Shanghai", country: "CN" }, { id: "p2", name: "DXB", city: "Dubai", country: "AE" },
  ],
  legs: [{ id: "l1", legCode: "L1", legName: "Air leg", mode: "AIR", status: "READY_FOR_RFQ",
    originPointId: "p1", destinationPointId: "p2", readyDate: null, targetDelivery: null, assignedCargoIds: [],
    rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 } }],
};

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("RfqWorkspace", () => {
  it("renders header + leg panels and runs Distribute All", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/queries/q1")) return { status: 200, body: queryDetail };
      if (url.includes("/rfq-state")) return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      if (url.includes("/distribute-all") && init?.method === "POST")
        return { status: 201, body: { rfqs: [], distributedLegIds: [], skipped: [{ legId: "l1", reason: "nothing-selected" }] } };
      return { status: 404 };
    }));

    wrap(<RfqWorkspace queryId="q1" />);
    expect(await screen.findByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByText("Air leg")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /distribute all/i }));
    expect(await screen.findAllByText(/L1/)).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByText(/nothing selected/i)).toBeInTheDocument());
  });
});
