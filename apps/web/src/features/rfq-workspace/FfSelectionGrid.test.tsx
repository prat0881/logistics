import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FreightForwarderDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { FfSelectionGrid } from "./FfSelectionGrid";

const ff = (id: string, name: string): FreightForwarderDto => ({
  id, freightForwarderCode: id, companyName: name, companyAddress: null,
  city: null, postalCode: null, country: null, pic: "P",
  contactNumber: "+1", email: `${id}@x.com`, availableCountries: ["AE"], modes: ["AIR"],
  handleDg: false, vatTrnEori: null, whLocation: null, defaultCurrency: null,
  paymentTerms: "NET 30", typicalLeadTime: "2d", status: "ACTIVE",
});

const manyFfs = (n: number) =>
  Array.from({ length: n }, (_, i) => ff(`ff${i}`, `Forwarder ${String(i).padStart(2, "0")}`));

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
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("ff-selection"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ ffIds: ["a"] });
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

  it("shows full country names, hides payment terms/lead time, and offers regenerate for distributed FFs", async () => {
    const ffIn: FreightForwarderDto = {
      ...ff("ff1", "India FF"),
      availableCountries: ["IN"],
      paymentTerms: "NET30",
      typicalLeadTime: "5d",
    };
    vi.stubGlobal("fetch", mockFetch((url, init) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ffIn] };
      if (url.includes("/reissue-token") && init?.method === "POST") return { status: 200, body: { accessToken: "tok123" } };
      return { status: 404 };
    }));
    wrap(
      <FfSelectionGrid
        queryId="q1" legId="l1"
        legQuotes={[{ freightForwarderId: "ff1", status: "RFQ_SENT" }]}
        referencedFfs={[ffIn]}
      />,
    );
    // Full country name rendered in the country/mode paragraph, not the bare code
    expect(await screen.findByText(/India · AIR/)).toBeInTheDocument();
    expect(screen.queryByText(/\bIN\b/)).toBeNull();
    // Payment terms and lead time are absent
    expect(screen.queryByText(/NET30|Lead/)).toBeNull();
    // Distributed FF shows Regenerate button
    expect(screen.getByRole("button", { name: /regenerate portal link/i })).toBeInTheDocument();
  });

  it("does NOT show regenerate button for a SELECT (not-yet-distributed) FF", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("ff2", "Select FF")] };
      return { status: 404 };
    }));
    wrap(
      <FfSelectionGrid
        queryId="q1" legId="l1"
        legQuotes={[{ freightForwarderId: "ff2", status: "SELECT" }]}
        referencedFfs={[ff("ff2", "Select FF")]}
      />,
    );
    expect(await screen.findByText("Select FF")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /regenerate portal link/i })).toBeNull();
  });

  it("defaults to Cards and toggles to Table (with column headers)", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("a", "Alpha FF"), ff("b", "Beta FF")] };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    expect(await screen.findByText("Alpha FF")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /forwarder/i })).toBeNull(); // cards first
    await userEvent.click(screen.getByRole("button", { name: /^table$/i }));
    expect(screen.getByRole("columnheader", { name: /forwarder/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /country/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /modes/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /status/i })).toBeInTheDocument();
    // no Terms / Lead columns (D1)
    expect(screen.queryByRole("columnheader", { name: /terms|lead/i })).toBeNull();
  });

  it("filters by search text", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("a", "Alpha FF"), ff("b", "Beta FF")] };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    await screen.findByText("Alpha FF");
    await userEvent.type(screen.getByRole("textbox", { name: /search forwarders/i }), "beta");
    expect(screen.queryByText("Alpha FF")).toBeNull();
    expect(screen.getByText("Beta FF")).toBeInTheDocument();
  });

  it("pages the table with Load 10 more", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: manyFfs(12) };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    await screen.findByText("Forwarder 00");
    await userEvent.click(screen.getByRole("button", { name: /^table$/i }));
    // first 10 rows: 00..09 visible, 10/11 not yet
    expect(screen.getByText("Forwarder 09")).toBeInTheDocument();
    expect(screen.queryByText("Forwarder 11")).toBeNull();
    expect(screen.getByText(/showing 10 of 12/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /load 10 more/i }));
    expect(screen.getByText("Forwarder 11")).toBeInTheDocument();
  });

  it("sorts the table by Forwarder when the header is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/eligible-ffs")) return { status: 200, body: [ff("a", "Alpha FF"), ff("z", "Zulu FF")] };
      return { status: 404 };
    }));
    wrap(<FfSelectionGrid queryId="q1" legId="l1" legQuotes={[]} referencedFfs={[]} />);
    await screen.findByText("Alpha FF");
    await userEvent.click(screen.getByRole("button", { name: /^table$/i }));
    let rows = screen.getAllByRole("row").slice(1); // skip header row
    expect(within(rows[0]).getByText("Alpha FF")).toBeInTheDocument(); // ascending default
    await userEvent.click(screen.getByRole("button", { name: /forwarder/i }));
    rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Zulu FF")).toBeInTheDocument(); // descending
  });
});
