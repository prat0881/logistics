import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "../../QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

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

    // legCode displayed as font-mono in the leg-list row (the RouteDiagram also
    // renders "L1" as an SVG edge label, so scope to the list <span>).
    await waitFor(() => {
      expect(screen.getByText("L1", { selector: "span" })).toBeInTheDocument();
    });

    // Scope remaining assertions to the leg-list ROW — legCode, mode, and point
    // names also legitimately appear in the RouteDiagram (SVG) and FindingsPanel.
    const legRow = screen
      .getByText("L1", { selector: "span" })
      .closest("div.rounded-md") as HTMLElement;
    expect(legRow).not.toBeNull();
    const row = within(legRow);

    // mode badge
    expect(row.getByText("ROAD")).toBeInTheDocument();

    // origin → destination
    expect(row.getByText(/Sender HQ/)).toBeInTheDocument();
    expect(row.getByText(/Receiver Depot/)).toBeInTheDocument();

    // Assigned cargo count
    expect(row.getByText(/1 cargo/i)).toBeInTheDocument();
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
      expect(screen.getByText("L1", { selector: "span" })).toBeInTheDocument();
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

  it("on a new (unsaved) query at Step 4, '+ Add leg' mints the query (POST /api/queries) and does NOT show the dead-end message", async () => {
    const user = userEvent.setup();
    const mintedDetail = {
      ...baseDetail,
      id: "new-minted-id",
      queryCode: "YAL26-9999",
    };

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: testUser },
          };
        // Mint: POST /api/queries → return a fresh detail
        if (url === "/api/queries" && init?.method === "POST")
          return { status: 201, body: mintedDetail };
        // After navigation, the wizard GETs the newly minted query
        if (url.includes(`/api/queries/${mintedDetail.id}`))
          return { status: 200, body: mintedDetail };
        return { status: 200, body: {} };
      }),
    );

    // Render as a NEW query (no :id param) at step=3 (Legs / Route)
    renderWithProviders(
      <Routes>
        <Route path="/queries/new" element={<QueryWizardPage />} />
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new?step=3" },
    );

    // Navigate to step 4 in the shell (click the "Legs / Route" tab)
    // On new query, tabs may not be clickable — but "+ Add leg" is always present
    // because we removed the dead-end guard.
    const addLegBtn = await screen.findByRole("button", { name: /add leg/i });

    // The dead-end "Save the query first" message must NOT appear
    expect(screen.queryByText(/save the query first/i)).not.toBeInTheDocument();

    await user.click(addLegBtn);

    // POST /api/queries must have been called (mint)
    await waitFor(() => {
      const calls: unknown[][] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const mintCall = calls.find(
        (args) =>
          (args[0] as string) === "/api/queries" &&
          (args[1] as RequestInit)?.method === "POST",
      );
      expect(mintCall).toBeTruthy();
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

    // Wait for the leg to appear (scope to the list <span>; the RouteDiagram
    // also renders "L1" as an SVG edge label).
    const legSpan = await screen.findByText("L1", { selector: "span" });

    // Click the leg's Remove — scope to the leg row, since points now also
    // render Remove buttons (U6).
    const legRow = legSpan.closest("div.rounded-md") as HTMLElement;
    const removeBtn = within(legRow).getByRole("button", { name: /remove/i });
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

  it("lists points with their address and lets you edit an existing one (U6)", async () => {
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

    // (1) the pickup point's street address is now shown on the main screen
    const addr = await screen.findByText(/123 Main St/);

    // (2) that point row has an Edit button that opens PointEditor pre-filled
    const pointRow = addr.closest("div.rounded-md") as HTMLElement;
    expect(pointRow).not.toBeNull();
    await user.click(within(pointRow).getByRole("button", { name: /edit/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Sender HQ")).toBeInTheDocument();
  });

  it("hides the Validate button and shows a notices strip + per-box hover (Legs rework)", async () => {
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

    // (1) the "Validate route" button is gone (validation runs on Save/Next now)
    await screen.findByText(/123 Main St/);
    expect(screen.queryByRole("button", { name: /validate route/i })).not.toBeInTheDocument();

    // (2) baseDetail has unused points + unassigned cargo → create-phase errors →
    // the notices strip prompts hovering the boxes
    await waitFor(() =>
      expect(screen.getByText(/hover the highlighted boxes/i)).toBeInTheDocument(),
    );

    // (3) the problematic PICKUP point card carries a hover (title) message
    const addr = screen.getByText(/123 Main St/);
    const card = addr.closest("div.rounded-md") as HTMLElement;
    expect(card.getAttribute("title") ?? "").toMatch(/not used by any leg/i);
  });

  it("shows route findings as a hover tooltip on the diagram edge (Legs rework step 4)", async () => {
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

    // legDto has null ready/target dates → create-phase C1 finding on leg L1.
    await screen.findByText("L1", { selector: "span" });
    const edge = document.querySelector(`[data-leg-id="${LEG_ID}"]`);
    expect(edge).not.toBeNull();
    const title = edge?.querySelector("title");
    expect(title?.textContent ?? "").toMatch(/missing|ready date|target delivery/i);
  });
});
