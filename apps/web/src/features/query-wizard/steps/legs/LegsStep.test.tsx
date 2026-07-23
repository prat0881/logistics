import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route, useLocation } from "react-router-dom";
import { QueryWizardPage } from "../../QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

/**
 * LocationProbe — mounts inside the router tree and calls onSearch with the
 * current search string on every location change. Used by ?add= round-trip
 * tests to assert that the param is cleared after the editor opens.
 */
function LocationProbe({ onSearch }: { onSearch: (search: string) => void }) {
  const location = useLocation();
  // Call synchronously on each render so the caller captures the latest value.
  onSearch(location.search);
  return null;
}

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

// A leg with a dangling (null) origin — RouteDiagram can't draw it, so the
// escape strip is the only place to reach it.
const danglingLegDto = {
  ...legDto,
  id: "99999999-9999-9999-9999-999999999999",
  legCode: "L2",
  originPointId: null,
  destinationPointId: DELIVERY_POINT_ID,
  assignedCargoIds: [],
  rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
};
const detailWithDangling = { ...baseDetail, legs: [danglingLegDto] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Navigate to Step 4 (Leg & Route) from the wizard */
async function navigateToStep4() {
  await screen.findByText("YAL26-0001");
  const legsTab = screen.getByRole("button", { name: /leg & route/i });
  await userEvent.click(legsTab);
}

describe("LegsStep", () => {
  it("shows the + Add point / + Add leg toolbar and the route canvas (no list cards)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /\+ add point/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /\+ add leg/i })).toBeInTheDocument();
      expect(document.querySelector('[data-slot="route-diagram"]')).toBeInTheDocument();
    });

    // The old list section headings are gone
    expect(screen.queryByText(/^Points$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Legs$/)).not.toBeInTheDocument();
  });

  it("clicking a point box in the canvas opens the Point editor in edit mode", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    // Wait for the canvas to render with a point node
    await waitFor(() => {
      expect(document.querySelector(`[data-point-id="${PICKUP_POINT_ID}"]`)).toBeInTheDocument();
    });

    const pointNode = document.querySelector(
      `[data-point-id="${PICKUP_POINT_ID}"]`,
    ) as SVGGElement;
    await userEvent.click(pointNode);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("clicking '+ Add leg' toolbar button opens the LegEditor dialog", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    const addLegBtn = await screen.findByRole("button", { name: /\+ add leg/i });
    await user.click(addLegBtn);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  it("on a new (unsaved) query at Step 4, '+ Add leg' mints the query (POST /api/queries) with ?add=leg", async () => {
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

    // Render as a NEW query (no :id param) at step=3 (Leg & Route)
    renderWithProviders(
      <Routes>
        <Route path="/queries/new" element={<QueryWizardPage />} />
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new?step=3" },
    );

    // On new query, the pre-mint toolbar is shown — find the "+ Add leg" button
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

  it("shows route findings notices strip and canvas (Legs rework)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );
    await navigateToStep4();

    // (1) the "Validate route" button is gone (validation runs on Save/Next now)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="route-diagram"]')).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /validate route/i })).not.toBeInTheDocument();

    // (2) baseDetail has unused points + unassigned cargo → create-phase errors →
    // the notices strip prompts hovering the boxes
    await waitFor(() =>
      expect(screen.getByText(/hover the highlighted boxes/i)).toBeInTheDocument(),
    );
  });

  it("shows route findings as a hover tooltip on the diagram edge (Legs rework step 4)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: detailWithLeg };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );
    await navigateToStep4();

    // legDto has null ready/target dates → create-phase C1 finding on leg L1.
    await waitFor(() => {
      expect(document.querySelector(`[data-leg-id="${LEG_ID}"]`)).toBeInTheDocument();
    });

    const edge = document.querySelector(`[data-leg-id="${LEG_ID}"]`);
    expect(edge).not.toBeNull();
    const title = edge?.querySelector("title");
    expect(title?.textContent ?? "").toMatch(/missing|ready date|target delivery/i);
  });

  it("Next advances from Step 4 even when the route has errors (Round-1 Common #5)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url.includes("/validate")) return { status: 200, body: { findings: [] } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );
    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );
    await navigateToStep4();

    await waitFor(() =>
      expect(document.querySelector('[data-slot="route-diagram"]')).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    expect(screen.queryByText(/before continuing/i)).not.toBeInTheDocument();
    // Step 5 heading is shown (Internal Notes label is unique to Step5Notes body)
    expect(await screen.findByLabelText(/internal notes/i)).toBeInTheDocument();
  });

  it("empty state shows placeholder text when no points and no legs exist", async () => {
    const emptyDetail = { ...baseDetail, points: [], legs: [] };
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: emptyDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );

    await navigateToStep4();

    await waitFor(() => {
      expect(
        screen.getByText(/add a point or leg to start the route/i),
      ).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Leg & Route" })).toBeInTheDocument();
    });
  });

  it("lists an incomplete (dangling-endpoint) leg in the escape strip and opens the editor on click", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: detailWithDangling };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3` },
    );
    await navigateToStep4();

    // The strip names the incomplete leg + the "needs origin & destination" hint.
    const stripRow = await screen.findByRole("button", {
      name: /L2.*needs origin & destination/i,
    });
    expect(stripRow).toBeInTheDocument();

    // Clicking the row opens the LegEditor dialog (edit mode) so it can be completed/deleted.
    await user.click(stripRow);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  // ?add= mint-intent round-trip tests
  it("?add=leg on an existing query opens the LegEditor dialog and clears the param", async () => {
    let capturedSearch = "";
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    // Render directly at step=3&add=leg — simulates navigation after a mint.
    // The wizard reads step=3 from the URL and renders LegsStepBody directly;
    // no need to click the stepper tab.
    renderWithProviders(
      <Routes>
        <Route
          path="/queries/:id"
          element={
            <>
              <QueryWizardPage />
              {/* Location probe: captures current search string on every render */}
              <LocationProbe onSearch={(s) => { capturedSearch = s; }} />
            </>
          }
        />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3&add=leg` },
    );

    // LegEditor dialog must open (add= consumed on mount by LegsStepBody)
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // The ?add= param must have been stripped (replace:true, no re-open on refresh)
    await waitFor(() => {
      expect(capturedSearch).not.toContain("add=leg");
    });
  });

  it("?add=point on an existing query opens the PointEditor dialog and clears the param", async () => {
    let capturedSearch = "";
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me")) return { status: 200, body: { user: testUser } };
        if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    // Render directly at step=3&add=point — simulates navigation after a mint.
    renderWithProviders(
      <Routes>
        <Route
          path="/queries/:id"
          element={
            <>
              <QueryWizardPage />
              <LocationProbe onSearch={(s) => { capturedSearch = s; }} />
            </>
          }
        />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=3&add=point` },
    );

    // PointEditor dialog must open
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // The ?add= param must have been stripped
    await waitFor(() => {
      expect(capturedSearch).not.toContain("add=point");
    });
  });
});
