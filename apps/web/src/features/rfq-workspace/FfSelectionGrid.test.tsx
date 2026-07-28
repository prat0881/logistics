import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FreightForwarderDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { FfSelectionGrid } from "./FfSelectionGrid";

const ff = (id: string, name: string): FreightForwarderDto => ({
  id, freightForwarderCode: id, companyName: name, companyAddress: null, pic: "P",
  contactNumber: "+1", email: `${id}@x.com`, availableCountries: ["AE"], modes: ["AIR"],
  handleDg: false, vatTrnEori: null, whLocation: null, defaultCurrency: null,
  paymentTerms: "NET 30", typicalLeadTime: "2d", status: "ACTIVE",
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("FfSelectionGrid", () => {
  it("lists eligible FFs, toggles selection via PUT, shows counts", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("a", "Alpha FF"), ff("b", "Beta FF")] };
      if (url.includes("/ff-selection") && init?.method === "PUT") return { status: 200, body: { selected: ["a"] } };
      return { status: 404 };
    });
    vi.stubGlobal("fetch", fetchMock);

    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    expect(await screen.findByText("Alpha FF")).toBeInTheDocument();
    expect(screen.getByText(/Eligible 2/i)).toBeInTheDocument();
    expect(screen.getByText(/Selected 0/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: /select alpha ff/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("ff-selection"))).toBe(true),
    );
  });

  it("renders a frozen (RFQ_SENT) FF read-only with its forwarder badge", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [] };
      return { status: 404 };
    }));
    wrap(
      <FfSelectionGrid
        queryId="q1" legId="l1"
        legQuotes={[{ freightForwarderId: "b", status: "RFQ_SENT" }]}
        referencedFfs={[ff("b", "Beta FF")]}
      />,
    );
    expect(await screen.findByText("Beta FF")).toBeInTheDocument();
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /beta ff/i })).toBeDisabled();
  });

  it("shows the E1 empty state with a broaden action", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("broaden=false")) return { status: 200, body: [] };
      if (url.includes("broaden=true")) return { status: 200, body: [ff("c", "Gamma FF")] };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    expect(await screen.findByText(/No eligible Freight Forwarders/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /view all active/i }));
    expect(await screen.findByText("Gamma FF")).toBeInTheDocument();
  });
});
