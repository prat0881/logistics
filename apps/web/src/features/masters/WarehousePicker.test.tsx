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

  it("does not discard a checked-but-unsaved selection when the parent re-renders with a content-equal but different assigned array", async () => {
    // Simulates the real trigger: the parent hands us `ownedWarehouses.data ?? []`, and every
    // parent re-render — an unrelated form field changing, or a window-focus refetch that
    // resolves to identical content — can produce a fresh array *reference* for the same
    // *content*. A fix keyed on that reference (not the ids it holds) would wipe the user's
    // still-unsaved checkbox change right here.
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return {
          status: 200,
          body: { items: [warehouse({ id: "u1", name: "Unassigned WH" })], total: 1, page: 1, pageSize: 100 },
        };
      }
      return { status: 404 };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <WarehousePicker
          ownerPath="freight-forwarders"
          ownerId="ff1"
          assigned={[warehouse({ id: "a1", name: "Assigned WH" })]}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("checkbox", { name: "Unassigned WH" }));
    expect(screen.getByRole("checkbox", { name: "Unassigned WH" })).toBeChecked();

    // A brand-new array, freshly allocated, but the same ids as before — exactly what
    // `ownedWarehouses.data ?? []` produces across an unrelated re-render or an
    // identical-content refetch.
    rerender(
      <QueryClientProvider client={qc}>
        <WarehousePicker
          ownerPath="freight-forwarders"
          ownerId="ff1"
          assigned={[warehouse({ id: "a1", name: "Assigned WH" })]}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("checkbox", { name: "Unassigned WH" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Assigned WH" })).toBeChecked();
  });

  it("resets the selection when the assigned set actually changes", async () => {
    // The other half of the same fix: a content-based signature must still reset `selected`
    // when the assignment genuinely changes underneath the component (e.g. after a save), not
    // just skip every reset unconditionally.
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };
      }
      return { status: 404 };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <WarehousePicker
          ownerPath="freight-forwarders"
          ownerId="ff1"
          assigned={[warehouse({ id: "a1", name: "Assigned WH" })]}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("checkbox", { name: "Assigned WH" })).toBeChecked();

    rerender(
      <QueryClientProvider client={qc}>
        <WarehousePicker ownerPath="freight-forwarders" ownerId="ff1" assigned={[]} />
      </QueryClientProvider>,
    );

    // "Assigned WH" no longer appears at all (it's neither assigned nor in the unassigned pool
    // in this fixture) — the real assertion is that the component picked up the change.
    expect(screen.queryByRole("checkbox", { name: "Assigned WH" })).not.toBeInTheDocument();
  });

  it("shows a truncation hint when the unassigned pool exceeds what was fetched, and searching re-queries the server rather than filtering client-side", async () => {
    const requestedUrls: string[] = [];
    stubFetch((url) => {
      requestedUrls.push(url);
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        if (url.includes("q=Foo")) {
          return { status: 200, body: { items: [warehouse({ id: "f1", name: "Foo WH" })], total: 1, page: 1, pageSize: 100 } };
        }
        return {
          status: 200,
          body: { items: [warehouse({ id: "u1", name: "Unassigned WH" })], total: 150, page: 1, pageSize: 100 },
        };
      }
      return { status: 404 };
    });
    renderPicker({ ownerId: "ff1", assigned: [] });

    expect(await screen.findByText(/showing 1 of 150 unassigned warehouses/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/search warehouses by name/i), "Foo");
    expect(await screen.findByRole("checkbox", { name: "Foo WH" })).toBeInTheDocument();
    expect(requestedUrls.some((u) => u.includes("q=Foo"))).toBe(true);
  });

  it("does not show a truncation hint once every unassigned warehouse has been fetched", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [warehouse({ id: "u1", name: "Unassigned WH" })], total: 1, page: 1, pageSize: 100 } };
      }
      return { status: 404 };
    });
    renderPicker({ ownerId: "ff1", assigned: [] });

    await screen.findByRole("checkbox", { name: "Unassigned WH" });
    expect(screen.queryByText(/showing .* of .* unassigned warehouses/i)).not.toBeInTheDocument();
  });

  it("on save, invalidates the master Warehouses list and the owner's own cached record, not just its own unassigned-pool query", async () => {
    stubFetch((url, init) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };
      }
      if (init?.method === "PUT") return { status: 200, body: [] };
      return { status: 404 };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <WarehousePicker
          ownerPath="freight-forwarders"
          ownerId="ff1"
          assigned={[warehouse({ id: "a1", name: "Assigned WH" })]}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: /save warehouses/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const invalidatedKeys = spy.mock.calls.map((call) => (call[0] as { queryKey?: unknown[] })?.queryKey);
    // The master Warehouses list (useWarehouses) is keyed ["warehouses", q, page, pageSize] —
    // only a bare ["warehouses"] prefix invalidation reaches it, an exact
    // ["warehouses","unassigned",search] does not.
    expect(invalidatedKeys).toContainEqual(["warehouses"]);
    // FreightForwarderFormPage's own cached record (useFreightForwarder) is keyed
    // ["freight-forwarder", id] — this is what makes the read-only whLocation field refresh.
    expect(invalidatedKeys).toContainEqual(["freight-forwarder", "ff1"]);
    expect(invalidatedKeys).toContainEqual(["freight-forwarders", "ff1", "warehouses"]);
  });

  it("invalidates the client's own cached record ([\"client\", id]) when saving from a client's picker", async () => {
    stubFetch((url, init) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };
      }
      if (init?.method === "PUT") return { status: 200, body: [] };
      return { status: 404 };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <WarehousePicker ownerPath="clients" ownerId="c1" assigned={[]} />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: /save warehouses/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const invalidatedKeys = spy.mock.calls.map((call) => (call[0] as { queryKey?: unknown[] })?.queryKey);
    expect(invalidatedKeys).toContainEqual(["client", "c1"]);
  });
});
