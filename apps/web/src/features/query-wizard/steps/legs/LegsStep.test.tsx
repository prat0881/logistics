import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "../../QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LEG_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PICKUP_POINT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DELIVERY_POINT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const CARGO_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const testUser = { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" as const };

const baseDetail = {
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
      qty: 2,
      dimL: "40",
      dimW: "30",
      dimH: "20",
      netWt: null,
      grossWt: "10",
      volumeCbm: "0.024",
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
  ],
  legs: [],
  freightMode: [],
  origin: [],
  destination: [],
};

const legDto = {
  id: LEG_ID,
  tenantId: null,
  queryId: QUERY_ID,
  legCode: "L1",
  legName: null,
  originPointId: PICKUP_POINT_ID,
  destinationPointId: DELIVERY_POINT_ID,
  mode: "ROAD",
  readyDate: null,
  targetDelivery: null,
  status: "DRAFT",
  executionStatus: "PENDING",
  totalChargeableWeight: null,
  createdAt: "2026-01-01T00:00:00+00:00",
  updatedAt: "2026-01-01T00:00:00+00:00",
  assignedCargoIds: [CARGO_ID],
  rollup: {
    totalPackages: 2,
    totalCbm: 0.024,
    totalGrossWt: 10,
    totalNetWt: 0,
  },
};

const detailWithLeg = { ...baseDetail, legs: [legDto] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Navigate to Step 4 (Legs / Route) from the wizard */
async function navigateToStep4() {
  await screen.findByText("YAL26-0001");
  const legsTab = screen.getByRole("button", { name: /legs/i });
  await userEvent.click(legsTab);
}

describe("LegsStep", () => {
  it("shows empty state when there are no legs", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
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
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    await waitFor(() => {
      expect(screen.getByText(/add the first leg to build the route/i)).toBeInTheDocument();
    });
  });

  it("lists saved legs: legCode, mode badge, origin→destination names, assigned cargo count", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
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
          json: () => Promise.resolve(detailWithLeg),
          text: () => Promise.resolve(JSON.stringify(detailWithLeg)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    // legCode displayed as font-mono
    await waitFor(() => {
      expect(screen.getByText("L1")).toBeInTheDocument();
    });

    // mode badge
    expect(screen.getByText("ROAD")).toBeInTheDocument();

    // origin → destination
    expect(screen.getByText(/Sender HQ/)).toBeInTheDocument();
    expect(screen.getByText(/Receiver Depot/)).toBeInTheDocument();

    // Assigned cargo count
    expect(screen.getByText(/1 cargo/i)).toBeInTheDocument();
  });

  it("shows rollup totals for a leg (totalPackages, totalCbm, totalGrossWt)", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
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
          json: () => Promise.resolve(detailWithLeg),
          text: () => Promise.resolve(JSON.stringify(detailWithLeg)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    await waitFor(() => {
      expect(screen.getByText("L1")).toBeInTheDocument();
    });

    // rollup.totalPackages = 2
    expect(screen.getByText(/2 pkg/i)).toBeInTheDocument();
  });

  it("clicking '+ Add leg' opens the LegEditor dialog", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
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
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    const addLegBtn = await screen.findByRole("button", { name: /add leg/i });
    await user.click(addLegBtn);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  it("deleting a leg: shows confirm dialog then DELETEs the leg", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("confirm", vi.fn(() => true));

    let callCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ user: testUser }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);

      if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET")) {
        callCount++;
        const body = callCount > 1 ? baseDetail : detailWithLeg;
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      }

      if (url === `/api/queries/${QUERY_ID}/legs/${LEG_ID}` && init?.method === "DELETE")
        return Promise.resolve({
          ok: true, status: 204,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);

      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    // Wait for the leg to appear
    await screen.findByText("L1");

    // Click Remove
    const removeBtn = screen.getByRole("button", { name: /remove/i });
    await user.click(removeBtn);

    // Verify DELETE was called
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/legs/${LEG_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });
});
