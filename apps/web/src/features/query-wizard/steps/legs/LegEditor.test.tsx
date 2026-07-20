import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders";
import { LegEditor } from "./LegEditor";
import type { QueryDetail } from "@svyft/shared";

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LEG_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PICKUP_POINT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DELIVERY_POINT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const SEAPORT_POINT_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CARGO_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const testUser = { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" as const };

const baseDetail: QueryDetail = {
  id: QUERY_ID,
  queryCode: "YAL26-0001",
  status: "DRAFT",
  priority: "MEDIUM",
  dgIndicator: false,
  whatsappEnabled: false,
  queryDate: "2026-01-01T00:00:00+00:00",
  responseDeadline: null,
  responseDeadlineRemarks: null,
  clientId: null,
  contactName: null,
  contactDesignation: null,
  contactEmail: null,
  contactPhone: null,
  faxNumber: null,
  vesselId: null,
  vesselName: null,
  imoNumber: null,
  eta: null,
  etb: null,
  etd: null,
  portOfCall: null,
  incoterms: null,
  shipmentDescription: null,
  readyDate: null,
  targetDelivery: null,
  internalNotes: null,
  tenantId: null,
  rfqReadyAt: null,
  assignedUserId: null,
  createdAt: "2026-01-01T00:00:00+00:00",
  updatedAt: "2026-01-01T00:00:00+00:00",
  cargo: [
    {
      id: CARGO_ID,
      rowIndex: 0,
      poReference: "PO-001",
      productName: "Widget A",
      referenceTags: [],
      hsCode: null,
      packageType: "Carton",
      isDangerous: false,
      msdsFileId: null,
      qty: 1,
      dimL: "10",
      dimW: "10",
      dimH: "10",
      netWt: null,
      grossWt: "5",
      volumeCbm: null,
      freightDensity: null,
      chargeableWeight: null,
    },
  ],
  checklist: [],
  files: [],
  points: [
    {
      id: PICKUP_POINT_ID,
      tenantId: null,
      queryId: QUERY_ID,
      type: "PICKUP",
      name: "Sender HQ",
      streetAddress: "123 Main St",
      city: "London",
      postalCode: "SW1A",
      country: "UK",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
    },
    {
      id: DELIVERY_POINT_ID,
      tenantId: null,
      queryId: QUERY_ID,
      type: "DELIVERY",
      name: "Receiver Depot",
      streetAddress: "456 High St",
      city: "Manchester",
      postalCode: "M1 2AB",
      country: "UK",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
    },
    {
      id: SEAPORT_POINT_ID,
      tenantId: null,
      queryId: QUERY_ID,
      type: "SEAPORT",
      name: "Port of Felixstowe",
      streetAddress: null,
      city: "Felixstowe",
      postalCode: "IP11",
      country: "UK",
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: "GBFXT",
      terminal: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
    },
  ],
  legs: [],
  freightMode: [],
  origin: [],
  destination: [],
};

function makeFetchMock(
  overrides: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>> = {},
) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/api/auth/me"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ user: testUser }),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);

    if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(baseDetail),
        text: () => Promise.resolve(JSON.stringify(baseDetail)),
        blob: () => Promise.resolve(new Blob()),
      } as Response);

    // Check overrides
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) return handler(url, init);
    }

    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
      blob: () => Promise.resolve(new Blob()),
    } as Response);
  });
}

/**
 * In jsdom, Radix Select renders a visually-hidden <select aria-hidden="true"> alongside
 * each trigger button. We fire change events on those hidden selects to drive form state.
 * The selects appear in DOM order: origin (0), destination (1), mode (2).
 */
function getHiddenSelects(container: HTMLElement = document.body) {
  return Array.from(container.querySelectorAll<HTMLSelectElement>('select[aria-hidden="true"]'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LegEditor", () => {
  it("renders an open dialog", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

    renderWithProviders(
      <LegEditor
        open
        detail={baseDetail}
        queryId={QUERY_ID}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows a V-M1 client-side warning when SEA mode is selected with PICKUP→DELIVERY endpoints", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

    renderWithProviders(
      <LegEditor
        open
        detail={baseDetail}
        queryId={QUERY_ID}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole("dialog");

    const selects = getHiddenSelects();
    // selects[0] = origin, selects[1] = destination, selects[2] = mode
    fireEvent.change(selects[0], { target: { value: PICKUP_POINT_ID } });
    fireEvent.change(selects[1], { target: { value: DELIVERY_POINT_ID } });
    fireEvent.change(selects[2], { target: { value: "SEA" } });

    // V-M1 warning should appear (PICKUP + DELIVERY + SEA = incompatible)
    await waitFor(() => {
      expect(screen.getByTestId("vm1-client-warning")).toBeInTheDocument();
    });
  });

  it("clears the V-M1 warning when ROAD mode is selected", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

    renderWithProviders(
      <LegEditor
        open
        detail={baseDetail}
        queryId={QUERY_ID}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole("dialog");

    const selects = getHiddenSelects();
    // Set PICKUP → DELIVERY with SEA first
    fireEvent.change(selects[0], { target: { value: PICKUP_POINT_ID } });
    fireEvent.change(selects[1], { target: { value: DELIVERY_POINT_ID } });
    fireEvent.change(selects[2], { target: { value: "SEA" } });

    await waitFor(() => {
      expect(screen.getByTestId("vm1-client-warning")).toBeInTheDocument();
    });

    // Switch to ROAD — warning should clear
    fireEvent.change(selects[2], { target: { value: "ROAD" } });

    await waitFor(() => {
      expect(screen.queryByTestId("vm1-client-warning")).not.toBeInTheDocument();
    });
  });

  it("Save posts the correct payload with all required fields", async () => {
    const user = userEvent.setup();

    const legResponse = {
      id: LEG_ID,
      queryId: QUERY_ID,
      legCode: "L1",
      mode: "ROAD",
      originPointId: PICKUP_POINT_ID,
      destinationPointId: DELIVERY_POINT_ID,
      legCargo: [],
    };

    const fetchMock = makeFetchMock({
      "/legs": (_url, init) => {
        if (init?.method === "POST")
          return Promise.resolve({
            ok: true, status: 201,
            json: () => Promise.resolve(legResponse),
            text: () => Promise.resolve(JSON.stringify(legResponse)),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      },
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor
        open
        detail={baseDetail}
        queryId={QUERY_ID}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole("dialog");

    // Use fireEvent.change for Radix selects in jsdom
    const selects = getHiddenSelects();
    fireEvent.change(selects[0], { target: { value: PICKUP_POINT_ID } });
    fireEvent.change(selects[1], { target: { value: DELIVERY_POINT_ID } });
    fireEvent.change(selects[2], { target: { value: "ROAD" } });

    // Check the cargo checkbox
    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);

    // Fill Ready Date + Target Delivery (mandatory per #4)
    const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
    fireEvent.change(dateInputs[0], { target: { value: "2026-09-01T00:00" } });
    fireEvent.change(dateInputs[1], { target: { value: "2026-09-15T00:00" } });

    // Submit
    const saveBtn = screen.getByRole("button", { name: /save leg/i });
    await user.click(saveBtn);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/legs` &&
          (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.originPointId).toBe(PICKUP_POINT_ID);
      expect(body.destinationPointId).toBe(DELIVERY_POINT_ID);
      expect(body.mode).toBe("ROAD");
      expect(body.assignedCargoIds).toEqual([CARGO_ID]);
    });
  });

  it("surfaces server 422 findings (V-M1) inside the dialog and keeps it open", async () => {
    const user = userEvent.setup();
    const vmFinding = {
      rule: "V-M1",
      severity: "blocking",
      scope: { type: "leg" },
      message: "A Sea leg needs seaport endpoints",
    };

    const fetchMock = makeFetchMock({
      "/legs": (_url, init) => {
        if (init?.method === "POST")
          return Promise.resolve({
            ok: false, status: 422,
            json: () => Promise.resolve({ message: "Blocked", findings: [vmFinding] }),
            text: () => Promise.resolve(JSON.stringify({ message: "Blocked", findings: [vmFinding] })),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      },
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor
        open
        detail={baseDetail}
        queryId={QUERY_ID}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole("dialog");

    // Use native selects in jsdom
    const selects = getHiddenSelects();
    fireEvent.change(selects[0], { target: { value: PICKUP_POINT_ID } });
    fireEvent.change(selects[1], { target: { value: DELIVERY_POINT_ID } });
    fireEvent.change(selects[2], { target: { value: "SEA" } });

    // Check cargo
    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);

    // Fill Ready Date + Target Delivery (mandatory per #4) so the request reaches the server
    const dateInputs = document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
    fireEvent.change(dateInputs[0], { target: { value: "2026-09-01T00:00" } });
    fireEvent.change(dateInputs[1], { target: { value: "2026-09-15T00:00" } });

    // Submit
    const saveBtn = screen.getByRole("button", { name: /save leg/i });
    await user.click(saveBtn);

    // Server findings should appear in the dialog (via the findings list, not just the client warning)
    await waitFor(() => {
      // The server 422 finding message is rendered inside the server findings div
      const findingEls = screen.getAllByText(/A Sea leg needs seaport endpoints/i);
      expect(findingEls.length).toBeGreaterThanOrEqual(1);
    });

    // Dialog should remain open
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("blocks Save when mandatory fields are missing (#4)", async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock({
      "/legs": (_url, init) =>
        Promise.resolve({
          ok: true,
          status: init?.method === "POST" ? 201 : 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve("{}"),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor open detail={baseDetail} queryId={QUERY_ID} onSaved={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    // Set origin + destination + mode, but leave cargo unchecked and dates empty
    const selects = getHiddenSelects();
    fireEvent.change(selects[0], { target: { value: PICKUP_POINT_ID } });
    fireEvent.change(selects[1], { target: { value: DELIVERY_POINT_ID } });
    fireEvent.change(selects[2], { target: { value: "ROAD" } });

    await user.click(screen.getByRole("button", { name: /save leg/i }));

    // Required messages appear (dates) and no POST is issued
    await waitFor(() => expect(screen.getAllByText(/required/i).length).toBeGreaterThan(0));
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `/api/queries/${QUERY_ID}/legs` && (init as RequestInit)?.method === "POST",
    );
    expect(postCall).toBeFalsy();
  });
});
