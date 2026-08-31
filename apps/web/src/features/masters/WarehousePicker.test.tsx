import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  vi.stubGlobal("fetch", mockFetch(handler));
}

/** Renders the picker with fixed, non-interactive props — for tests that only assert on the
 *  initial render (checked state, truncation hint) and never toggle a box. */
function renderFixed({ value = [] as string[], assigned = [] as WarehouseDto[] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WarehousePicker ownerPath="freight-forwarders" value={value} onChange={() => {}} assigned={assigned} />
    </QueryClientProvider>,
  );
}

/** A real, stateful value/onChange pair — like ContactsSection.test.tsx's Harness — for tests
 *  that need toggling and re-rendering to actually flow through the controlled contract, not a
 *  spy that never updates what's on screen. */
function Harness({ initialValue = [] as string[], initialAssigned = [] as WarehouseDto[] }) {
  const [value, setValue] = useState<string[]>(initialValue);
  const [assigned, setAssigned] = useState<WarehouseDto[]>(initialAssigned);
  return (
    <>
      <WarehousePicker ownerPath="freight-forwarders" value={value} onChange={setValue} assigned={assigned} />
      {/* Lets a test simulate the parent re-rendering with a fresh `assigned` array — exactly
          what `ownedWarehouses.data ?? []` produces on an unrelated re-render or an
          identical-content refetch. */}
      <button type="button" onClick={() => setAssigned([...assigned])}>
        rerender-with-new-array
      </button>
    </>
  );
}

describe("WarehousePicker", () => {
  it("merges the unassigned pool with the currently-assigned warehouses, all checked appropriately", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [warehouse({ id: "u1", name: "Unassigned WH" })], total: 1, page: 1, pageSize: 100 } };
      }
      return { status: 404 };
    });
    renderFixed({ value: ["a1"], assigned: [warehouse({ id: "a1", name: "Assigned WH" })] });

    const assignedBox = await screen.findByRole("checkbox", { name: "Assigned WH" });
    const unassignedBox = await screen.findByRole("checkbox", { name: "Unassigned WH" });
    expect(assignedBox).toBeChecked();
    expect(unassignedBox).not.toBeChecked();
  });

  it("checking an unassigned warehouse calls onChange with it added to the draft", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [warehouse({ id: "u1", name: "Unassigned WH" })], total: 1, page: 1, pageSize: 100 } };
      }
      return { status: 404 };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Harness initialValue={["a1"]} initialAssigned={[warehouse({ id: "a1", name: "Assigned WH" })]} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("checkbox", { name: "Unassigned WH" }));

    expect(screen.getByRole("checkbox", { name: "Unassigned WH" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Assigned WH" })).toBeChecked();
  });

  it("unchecking an assigned warehouse calls onChange with it removed from the draft", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };
      }
      return { status: 404 };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Harness initialValue={["a1"]} initialAssigned={[warehouse({ id: "a1", name: "Assigned WH" })]} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("checkbox", { name: "Assigned WH" }));

    expect(screen.getByRole("checkbox", { name: "Assigned WH" })).not.toBeChecked();
  });

  it("does not discard a checked-but-unsaved selection when the parent re-renders with a content-equal but different assigned array", async () => {
    // Simulates the real trigger: the parent hands us `ownedWarehouses.data ?? []`, and every
    // parent re-render — an unrelated form field changing, or a window-focus refetch that
    // resolves to identical content — can produce a fresh array *reference* for the same
    // *content*. A fix keyed on that reference (not the ids it holds, and not the emptiness of
    // the draft) would wipe the user's still-unsaved checkbox change right here.
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return {
          status: 200,
          body: { items: [warehouse({ id: "u1", name: "Unassigned WH" })], total: 1, page: 1, pageSize: 100 },
        };
      }
      return { status: 404 };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Harness initialValue={["a1"]} initialAssigned={[warehouse({ id: "a1", name: "Assigned WH" })]} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("checkbox", { name: "Unassigned WH" }));
    expect(screen.getByRole("checkbox", { name: "Unassigned WH" })).toBeChecked();

    // A brand-new array, freshly allocated, but the same ids as before.
    await userEvent.click(screen.getByRole("button", { name: "rerender-with-new-array" }));

    expect(screen.getByRole("checkbox", { name: "Unassigned WH" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Assigned WH" })).toBeChecked();
  });

  it("seeds the draft from the assigned set when the draft starts empty", async () => {
    // The other half of the same mechanism: the draft (`value`) starts empty — a fresh
    // `defaultValues: { warehouseIds: [] }` before the parent's load effect has run, or before
    // it has resolved — and once the assigned set becomes known, the picker seeds `onChange`
    // with it exactly once, without requiring the user to re-check boxes the server already
    // has recorded as assigned.
    stubFetch((url) => {
      if (url.startsWith("/api/warehouses?unassigned=true")) {
        return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };
      }
      return { status: 404 };
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Harness initialValue={[]} initialAssigned={[warehouse({ id: "a1", name: "Assigned WH" })]} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("checkbox", { name: "Assigned WH" })).toBeChecked();
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
    renderFixed({ value: [], assigned: [] });

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
    renderFixed({ value: [], assigned: [] });

    await screen.findByRole("checkbox", { name: "Unassigned WH" });
    expect(screen.queryByText(/showing .* of .* unassigned warehouses/i)).not.toBeInTheDocument();
  });
});
