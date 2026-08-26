import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientDto } from "@svyft/shared";
import { ClientPicker } from "./ClientPicker";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const client1: ClientDto = {
  id: "c1",
  clientCode: "CLI001",
  companyName: "Acme Corp",
  industry: "Logistics",
  country: "SG",
  streetAddress: "1 Raffles Place",
  city: "Singapore",
  postalCode: "048616",
  status: "ACTIVE",
};

const client2: ClientDto = {
  id: "c2",
  clientCode: "CLI002",
  companyName: "Beta Ltd",
  industry: null,
  country: "US",
  streetAddress: "1 Beta Avenue",
  city: "Boston",
  postalCode: "02110",
  status: "ACTIVE",
};

function renderClientPicker(props: {
  value?: { id: string; companyName: string } | null;
  onSelect: (c: ClientDto) => void;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClientPicker {...props} />
    </QueryClientProvider>,
  );
}

describe("ClientPicker", () => {
  it("shows placeholder when no value is selected", () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } })));
    renderClientPicker({ value: null, onSelect: vi.fn() });
    expect(screen.getByText("Select client…")).toBeInTheDocument();
  });

  it("searches /api/clients?q= on input and shows results", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/clients") && url.includes("q=acme")) {
          return { status: 200, body: { items: [client1], total: 1, page: 1, pageSize: 20 } };
        }
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
      }),
    );

    renderClientPicker({ value: null, onSelect: vi.fn() });

    // Open the popover
    await userEvent.click(screen.getByRole("button"));
    // Type to search
    const input = screen.getByPlaceholderText(/search client/i);
    await userEvent.type(input, "acme");

    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());
  });

  it("calls onSelect with the clicked client", async () => {
    const onSelect = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/clients")) {
          return { status: 200, body: { items: [client1, client2], total: 2, page: 1, pageSize: 20 } };
        }
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
      }),
    );

    renderClientPicker({ value: null, onSelect });

    await userEvent.click(screen.getByRole("button"));
    const input = screen.getByPlaceholderText(/search client/i);
    await userEvent.type(input, "beta");

    await waitFor(() => expect(screen.getByText("Beta Ltd")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Beta Ltd"));

    expect(onSelect).toHaveBeenCalledWith(client2);
  });

  it("shows selected client name in trigger when value is set", () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } })));
    renderClientPicker({ value: { id: "c1", companyName: "Acme Corp" }, onSelect: vi.fn() });
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
  });
});
