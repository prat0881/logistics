import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VesselDto } from "@svyft/shared";
import { VesselPicker } from "./VesselPicker";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const vessel1: VesselDto = {
  id: "v1",
  vesselCode: "VES001",
  name: "Pacific Star",
  imoNumber: "1234567",
  shippingLine: "Maersk",
  vesselType: "CONTAINER",
  status: "ACTIVE",
};

const vessel2: VesselDto = {
  id: "v2",
  vesselCode: "VES002",
  name: "Atlantic Dawn",
  imoNumber: "7654321",
  shippingLine: null,
  vesselType: "BULK_CARRIER",
  status: "ACTIVE",
};

function renderVesselPicker(props: {
  value?: { id: string; name: string } | null;
  onSelect: (v: VesselDto) => void;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VesselPicker {...props} />
    </QueryClientProvider>,
  );
}

describe("VesselPicker", () => {
  it("shows placeholder when no value is selected", () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } })));
    renderVesselPicker({ value: null, onSelect: vi.fn() });
    expect(screen.getByText("Select vessel…")).toBeInTheDocument();
  });

  it("searches /api/vessels?q= on input and shows results", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/vessels") && url.includes("q=pacific")) {
          return { status: 200, body: { items: [vessel1], total: 1, page: 1, pageSize: 20 } };
        }
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
      }),
    );

    renderVesselPicker({ value: null, onSelect: vi.fn() });

    await userEvent.click(screen.getByRole("button"));
    const input = screen.getByPlaceholderText(/search vessel/i);
    await userEvent.type(input, "pacific");

    await waitFor(() => expect(screen.getByText("Pacific Star")).toBeInTheDocument());
  });

  it("calls onSelect with the clicked vessel", async () => {
    const onSelect = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/vessels")) {
          return { status: 200, body: { items: [vessel1, vessel2], total: 2, page: 1, pageSize: 20 } };
        }
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
      }),
    );

    renderVesselPicker({ value: null, onSelect });

    await userEvent.click(screen.getByRole("button"));
    const input = screen.getByPlaceholderText(/search vessel/i);
    await userEvent.type(input, "atlantic");

    await waitFor(() => expect(screen.getByText("Atlantic Dawn")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Atlantic Dawn"));

    expect(onSelect).toHaveBeenCalledWith(vessel2);
  });

  it("shows selected vessel name in trigger when value is set", () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } })));
    renderVesselPicker({ value: { id: "v1", name: "Pacific Star" }, onSelect: vi.fn() });
    expect(screen.getByText("Pacific Star")).toBeInTheDocument();
  });

  it("restricts the vessel search to ACTIVE only (G7)", async () => {
    let requested = "";
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/vessels")) requested = url;
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
      }),
    );
    renderVesselPicker({ value: null, onSelect: vi.fn() });
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByPlaceholderText(/search vessel/i), "pacific");
    await waitFor(() => expect(requested).toContain("/api/vessels"));
    expect(requested).toContain("status=ACTIVE");
  });
});
