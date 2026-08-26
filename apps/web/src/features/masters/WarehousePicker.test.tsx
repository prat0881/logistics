import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WarehouseDto } from "@svyft/shared";
import { WarehousePicker } from "./WarehousePicker";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

/** A minimal, valid warehouse fixture; override only what a test cares about. */
function warehouse(overrides: Partial<WarehouseDto> = {}): WarehouseDto {
  return {
    id: "w0",
    name: "Test Warehouse",
    type: "FF",
    freightForwarderId: null,
    clientId: null,
    streetAddress: "1 Test Road",
    country: "Testland",
    city: "Test City",
    pinCode: "00000",
    capacity: "1000",
    capacityUnit: "CBM",
    capabilities: [],
    agreementValidUntil: null,
    insuranceValidUntil: null,
    isBonded: false,
    weekendWorking: false,
    weekendWorkingFee: null,
    workingEmployees: null,
    forkLiftCount: null,
    dipTrayCount: null,
    freeStorageDays: 0,
    rateCurrency: null,
    handlingRate: null,
    handlingUnit: null,
    storageRate: null,
    storageUnit: null,
    status: "ACTIVE",
    ...overrides,
  };
}

function renderPicker({ ownerId, assigned = [] }: { ownerId?: string; assigned?: WarehouseDto[] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <WarehousePicker ownerPath="freight-forwarders" ownerId={ownerId} assigned={assigned} />
      </QueryClientProvider>,
    ),
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  vi.stubGlobal("fetch", mockFetch(handler));
}

describe("WarehousePicker", () => {
  it("shows the 'save this record first' message when there is no ownerId", () => {
    renderPicker({ ownerId: undefined });
    expect(screen.getByText(/save this record before assigning warehouses/i)).toBeInTheDocument();
  });

  it("merges the unassigned pool with the currently-assigned warehouses, all checked appropriately", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [warehouse({ id: "u1", name: "Unassigned WH" })], total: 1, page: 1, pageSize: 100 } };
      }
      return { status: 404 };
    });
    renderPicker({ ownerId: "ff1", assigned: [warehouse({ id: "a1", name: "Assigned WH" })] });

    const assignedBox = await screen.findByRole("checkbox", { name: "Assigned WH" });
    const unassignedBox = await screen.findByRole("checkbox", { name: "Unassigned WH" });
    expect(assignedBox).toBeChecked();
    expect(unassignedBox).not.toBeChecked();
  });

  it("saves the selected set to the PUT endpoint, including a newly-checked warehouse", async () => {
    const captured: { url?: string; method?: string; body?: Record<string, unknown> } = {};
    stubFetch((url, init) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [warehouse({ id: "u1", name: "Unassigned WH" })], total: 1, page: 1, pageSize: 100 } };
      }
      if (url.endsWith("/api/freight-forwarders/ff1/warehouses") && init?.method === "PUT") {
        captured.url = url;
        captured.method = init.method;
        captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return { status: 200, body: [] };
      }
      return { status: 404 };
    });
    renderPicker({ ownerId: "ff1", assigned: [warehouse({ id: "a1", name: "Assigned WH" })] });

    await userEvent.click(await screen.findByRole("checkbox", { name: "Unassigned WH" }));
    await userEvent.click(screen.getByRole("button", { name: /save warehouses/i }));

    await waitFor(() => expect(captured.method).toBe("PUT"));
    expect(captured.url).toBe("/api/freight-forwarders/ff1/warehouses");
    expect(captured.body?.warehouseIds).toEqual(expect.arrayContaining(["a1", "u1"]));
    expect((captured.body?.warehouseIds as string[]).length).toBe(2);
  });

  it("surfaces the server's 409 message instead of failing silently, without clearing the selection", async () => {
    stubFetch((url, init) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };
      }
      if (init?.method === "PUT") {
        return { status: 409, body: { message: "Test WH is already assigned to another record" } };
      }
      return { status: 404 };
    });
    renderPicker({ ownerId: "ff1", assigned: [warehouse({ id: "a1", name: "Assigned WH" })] });

    await userEvent.click(screen.getByRole("button", { name: /save warehouses/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Test WH is already assigned to another record");
    // The selection was not cleared by the failed save.
    expect(screen.getByRole("checkbox", { name: "Assigned WH" })).toBeChecked();
  });

  it("unassigning everything sends an empty warehouseIds array", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    stubFetch((url, init) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };
      }
      if (init?.method === "PUT") {
        captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return { status: 200, body: [] };
      }
      return { status: 404 };
    });
    renderPicker({ ownerId: "ff1", assigned: [warehouse({ id: "a1", name: "Assigned WH" })] });

    await userEvent.click(await screen.findByRole("checkbox", { name: "Assigned WH" }));
    await userEvent.click(screen.getByRole("button", { name: /save warehouses/i }));

    await waitFor(() => expect(captured.body).toEqual({ warehouseIds: [] }));
  });
});
