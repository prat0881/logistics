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

// Points with explicit IANA timezones for zone-anchor tests
const KOLKATA_POINT_ID = "11111111-1111-1111-1111-111111111111";
const SINGAPORE_POINT_ID = "22222222-2222-2222-2222-222222222222";

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
  readyDateTimezone: null,
  targetDelivery: null,
  targetDeliveryTimezone: null,
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
      dimUnit: "CM" as const,
      weightUnit: "KG" as const,
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
      timezone: null,
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
      timezone: null,
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
      timezone: null,
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
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
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
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
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

  it("edit mode shows a Delete button that removes the leg after confirm", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const EDIT_LEG_ID = "edit-leg-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const editLeg = {
      id: EDIT_LEG_ID,
      tenantId: null,
      queryId: QUERY_ID,
      legCode: "L1",
      legName: null,
      mode: "ROAD" as const,
      originPointId: PICKUP_POINT_ID,
      destinationPointId: DELIVERY_POINT_ID,
      assignedCargoIds: [] as string[],
      readyDate: null,
      targetDelivery: null,
      status: "DRAFT" as const,
      executionStatus: "PENDING" as const,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
      rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
    };

    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const onSaved = vi.fn();
    const onClose = vi.fn();

    renderWithProviders(
      <LegEditor
        open
        leg={editLeg}
        detail={baseDetail}
        queryId={QUERY_ID}
        onSaved={onSaved}
        onClose={onClose}
      />,
    );

    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/legs/${EDIT_LEG_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it("add mode shows no Delete button", async () => {
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
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("blocks saving a NEW leg with no origin/destination (asserts no POST)", async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock({
      "/legs": (_url, init) =>
        Promise.resolve({
          ok: true,
          status: init?.method === "POST" ? 201 : 200,
          json: () => Promise.resolve({ id: "should-not-post" }),
          text: () => Promise.resolve("{}"),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor open detail={baseDetail} queryId={QUERY_ID} onSaved={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    // Leave origin + destination empty; click Save.
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Inline required errors appear on both endpoint fields.
    expect(await screen.findByText(/origin is required/i)).toBeInTheDocument();
    expect(screen.getByText(/destination is required/i)).toBeInTheDocument();

    // No POST fired.
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `/api/queries/${QUERY_ID}/legs` && (init as RequestInit)?.method === "POST",
    );
    expect(postCall).toBeFalsy();
  });

  it("blocks saving an EDIT when an endpoint is missing (asserts no PATCH)", async () => {
    const user = userEvent.setup();
    const EDIT_LEG_ID = "0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a";
    const editLeg = {
      id: EDIT_LEG_ID,
      tenantId: null,
      queryId: QUERY_ID,
      legCode: "L1",
      legName: null,
      mode: "ROAD" as const,
      originPointId: null, // dangling origin — the dead-end scenario
      destinationPointId: DELIVERY_POINT_ID,
      assignedCargoIds: [] as string[],
      readyDate: null,
      targetDelivery: null,
      status: "DRAFT" as const,
      executionStatus: "PENDING" as const,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
      rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
    };
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor open leg={editLeg} detail={baseDetail} queryId={QUERY_ID} onSaved={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/origin is required/i)).toBeInTheDocument();

    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `/api/queries/${QUERY_ID}/legs/${EDIT_LEG_ID}` &&
        (init as RequestInit)?.method === "PATCH",
    );
    expect(patchCall).toBeFalsy();
  });

  it("saves a leg with origin+destination but no mode/cargo/dates (relaxed fields stay optional)", async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock({
      "/legs": (_url, init) =>
        Promise.resolve({
          ok: true,
          status: init?.method === "POST" ? 201 : 200,
          json: () => Promise.resolve({ id: "0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b" }),
          text: () => Promise.resolve("{}"),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor open detail={baseDetail} queryId={QUERY_ID} onSaved={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole("dialog");

    // Set only origin + destination (no mode, no cargo, no dates).
    const selects = getHiddenSelects();
    fireEvent.change(selects[0], { target: { value: PICKUP_POINT_ID } });
    fireEvent.change(selects[1], { target: { value: DELIVERY_POINT_ID } });

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/legs` && (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
    });
  });

  it("Ready Date anchors to origin zone (Asia/Kolkata); Target Delivery anchors to destination zone (Asia/Singapore)", async () => {
    // Build a detail with two points that have explicit timezones
    const zoneDetail: QueryDetail = {
      ...baseDetail,
      points: [
        {
          id: KOLKATA_POINT_ID,
          tenantId: null,
          queryId: QUERY_ID,
          type: "PICKUP",
          name: "Mumbai Warehouse",
          streetAddress: null,
          city: "Mumbai",
          postalCode: null,
          country: "IN",
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          warehouseType: null,
          iataCode: null,
          icaoCode: null,
          unLocode: null,
          terminal: null,
          timezone: "Asia/Kolkata",
          createdAt: "2026-01-01T00:00:00+00:00",
          updatedAt: "2026-01-01T00:00:00+00:00",
        },
        {
          id: SINGAPORE_POINT_ID,
          tenantId: null,
          queryId: QUERY_ID,
          type: "DELIVERY",
          name: "Singapore Depot",
          streetAddress: null,
          city: "Singapore",
          postalCode: null,
          country: "SG",
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          warehouseType: null,
          iataCode: null,
          icaoCode: null,
          unLocode: null,
          terminal: null,
          timezone: "Asia/Singapore",
          createdAt: "2026-01-01T00:00:00+00:00",
          updatedAt: "2026-01-01T00:00:00+00:00",
        },
      ],
    };

    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <LegEditor open detail={zoneDetail} queryId={QUERY_ID} onSaved={vi.fn()} onClose={vi.fn()} />,
    );

    await screen.findByRole("dialog");

    // Select origin (Kolkata) and destination (Singapore) via hidden selects
    const selects = getHiddenSelects();
    fireEvent.change(selects[0], { target: { value: KOLKATA_POINT_ID } });
    fireEvent.change(selects[1], { target: { value: SINGAPORE_POINT_ID } });

    // The "Times in …" hints from ZonedDateTimeField must reflect each point's zone.
    // ZonedDateTimeField renders: <p className="text-xs text-muted-foreground">Times in {zoneLabel(zone)}</p>
    // In jsdom, zoneLabel("Asia/Kolkata") → "GMT+5:30" and zoneLabel("Asia/Singapore") → "GMT+8:00"
    // (or similar offset strings). The two hints must be DIFFERENT from each other, proving
    // each field uses its own endpoint's zone rather than a shared fallback.
    await waitFor(() => {
      const hints = screen.getAllByText(/Times in /i);
      expect(hints).toHaveLength(2);
      const hintTexts = hints.map((el) => el.textContent ?? "");
      // The two fields must resolve to different zones (origin != destination)
      expect(hintTexts[0]).not.toBe(hintTexts[1]);
      // Neither hint should fall back to bare "UTC" (the org-fallback zone), since both
      // points have explicit timezone values set
      expect(hintTexts.every((t) => !t.endsWith("UTC"))).toBe(true);
    });
  });
});
