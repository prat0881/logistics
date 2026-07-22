import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "./QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const draftDetail = {
  id: "q9",
  queryCode: "YAL26-0009",
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
  cargo: [],
  checklist: [],
  files: [],
  points: [],
  legs: [],
  freightMode: [],
  origin: [],
  destination: [],
};

// ── A fully-populated detail that passes client-side preview (for 201 test) ──
const READY_DATE_Q9 = "2026-09-01T00:00:00+00:00";
const TARGET_DELIVERY_Q9 = "2026-09-15T00:00:00+00:00";
const PICKUP_ID_Q9 = "aaaa0001-0000-0000-0000-000000000000";
const DELIVERY_ID_Q9 = "aaaa0002-0000-0000-0000-000000000000";
const CARGO_ID_Q9 = "aaaa0003-0000-0000-0000-000000000000";
const LEG_ID_Q9 = "aaaa0004-0000-0000-0000-000000000000";

const fullDraftDetail = {
  ...draftDetail,
  clientId: "aaaa0005-0000-0000-0000-000000000000",
  contactName: "Alice Test",
  contactEmail: "alice@test.com",
  contactPhone: "+6591234567",
  incoterms: "FOB",
  readyDate: READY_DATE_Q9,
  targetDelivery: TARGET_DELIVERY_Q9,
  cargo: [
    {
      id: CARGO_ID_Q9,
      rowIndex: 0,
      poReference: "PO-Q9-001",
      productName: "Widget",
      referenceTags: [],
      hsCode: null,
      packageType: "Carton",
      isDangerous: false,
      msdsFileId: null,
      qty: 5,
      dimL: "30",
      dimW: "20",
      dimH: "10",
      netWt: null,
      grossWt: "10",
      volumeCbm: "0.006",
      freightDensity: null,
      chargeableWeight: null,
    },
  ],
  points: [
    {
      id: PICKUP_ID_Q9,
      tenantId: null,
      queryId: "q9",
      type: "PICKUP",
      name: "Origin",
      streetAddress: "1 Main St",
      city: "Singapore",
      postalCode: "018989",
      country: "SG",
      contactName: "Sender",
      contactPhone: "+6591234567",
      contactEmail: "sender@test.com",
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
    },
    {
      id: DELIVERY_ID_Q9,
      tenantId: null,
      queryId: "q9",
      type: "DELIVERY",
      name: "Destination",
      streetAddress: "2 High St",
      city: "Kuala Lumpur",
      postalCode: "50000",
      country: "MY",
      contactName: "Receiver",
      contactPhone: "+60123456789",
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
  legs: [
    {
      id: LEG_ID_Q9,
      tenantId: null,
      queryId: "q9",
      legCode: "L1",
      legName: null,
      originPointId: PICKUP_ID_Q9,
      destinationPointId: DELIVERY_ID_Q9,
      mode: "ROAD",
      readyDate: READY_DATE_Q9,
      targetDelivery: TARGET_DELIVERY_Q9,
      status: "DRAFT",
      executionStatus: "NOT_STARTED",
      totalChargeableWeight: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
      assignedCargoIds: [CARGO_ID_Q9],
      rollup: { totalPackages: 5, totalCbm: 0.006, totalGrossWt: 10, totalNetWt: 0 },
    },
  ],
  freightMode: ["ROAD"],
  origin: [{ id: PICKUP_ID_Q9, name: "Origin", city: "Singapore", country: "SG" }],
  destination: [{ id: DELIVERY_ID_Q9, name: "Destination", city: "Kuala Lumpur", country: "MY" }],
};

const fullRfqReadyDetail = { ...fullDraftDetail, status: "RFQ_READY" };

describe("QueryWizardPage", () => {
  it("mints the Query ID on first Save of a new query and switches to edit", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
          };
        if (url.endsWith("/api/queries") && init?.method === "POST") {
          posts.push(JSON.parse(init.body as string));
          return { status: 201, body: draftDetail };
        }
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/new" element={<QueryWizardPage />} />
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    // The Save button should be present on Step 1
    await userEvent.click(await screen.findByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(await screen.findByText("YAL26-0009")).toBeInTheDocument();
  });

  it("Create Query with missing required fields → client preview blocks (no server call)", async () => {
    const createCalls: string[] = [];

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
          };
        if (url.includes("/api/queries/q9/create") && init?.method === "POST") {
          createCalls.push(url);
          return { status: 422, body: { findings: [] } };
        }
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      {
        route: "/queries/q9?step=4",
        user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" },
      },
    );

    // Wait for the page to load and show the final step
    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await userEvent.click(createBtn);

    // Client-side preview fires first — "Client is required" is an F1 blocking finding
    await waitFor(() =>
      expect(screen.getByText("Client is required")).toBeInTheDocument(),
    );
    // Status should still be DRAFT
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
    // The server /create endpoint must NOT have been called — client preview blocked it
    expect(createCalls.length).toBe(0);
  });

  it("Create Query → server returns 422 blocking findings → renders server finding, status stays DRAFT", async () => {
    const serverFindings = [
      {
        rule: "R2",
        severity: "blocking",
        scope: { type: "cargo" },
        message: "Cargo chain is invalid: missing pickup leg",
      },
    ];

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
          };
        if (url.includes("/api/queries/q9/create") && init?.method === "POST")
          return { status: 422, body: { findings: serverFindings } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: fullDraftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      {
        route: "/queries/q9?step=4",
        user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" },
      },
    );

    // Wait for the page to load (fullDraftDetail passes client-side preview)
    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await userEvent.click(createBtn);

    // Server 422 finding should render
    await waitFor(() =>
      expect(screen.getByText("Cargo chain is invalid: missing pickup leg")).toBeInTheDocument(),
    );
    // Status badge should still be DRAFT
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
  });

  it("Cancel navigates back to the Queries list (U2)", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
          };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
        <Route path="/queries" element={<span>queries-list</span>} />
      </Routes>,
      {
        route: "/queries/q9",
        user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" },
      },
    );

    await screen.findByText("YAL26-0009");

    // Click Cancel → confirm → navigate to the Queries list (U2)
    await userEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.getByText("queries-list")).toBeInTheDocument());

    vi.unstubAllGlobals();
  });

  it("Save Draft from optional-gaps dialog persists the draft (PATCH) and does NOT call /create (G2)", async () => {
    const createCalls: string[] = [];
    const patchCalls: string[] = [];

    // fullDraftDetail passes client-side preview; add an unchecked checklist item
    // so the optional-gaps dialog opens
    const detailWithUnchecked = {
      ...fullDraftDetail,
      checklist: [
        { id: "c1", itemKey: "weight-confirmed", checked: false },
        { id: "c2", itemKey: "dimensions-confirmed", checked: true },
      ],
    };

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
          };
        if (url.includes("/api/queries/q9/create") && init?.method === "POST") {
          createCalls.push(url);
          return { status: 201, body: { id: "q9", status: "RFQ_READY" } };
        }
        if (url.includes("/api/queries/q9") && init?.method === "PATCH") {
          patchCalls.push(url);
          return { status: 200, body: detailWithUnchecked };
        }
        if (url.includes("/api/queries/q9")) return { status: 200, body: detailWithUnchecked };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      {
        route: "/queries/q9?step=4",
        user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" },
      },
    );

    // Wait for the page and click Create Query — triggers optional-gaps dialog
    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await userEvent.click(createBtn);

    // Optional-gaps dialog should open
    await waitFor(() =>
      expect(screen.getByText(/Create query with missing optional info/i)).toBeInTheDocument(),
    );

    // Click "Save Draft"
    const saveDraftBtn = screen.getByRole("button", { name: /^Save Draft$/i });
    await userEvent.click(saveDraftBtn);

    // Dialog should close
    await waitFor(() =>
      expect(screen.queryByText(/Create query with missing optional info/i)).not.toBeInTheDocument(),
    );
    // /create must NOT have been called, but the draft WAS persisted (G2)
    expect(createCalls.length).toBe(0);
    await waitFor(() => expect(patchCalls.length).toBeGreaterThan(0));
  });

  it("on Create Query → 201 re-GETs and shows RFQ_READY + success banner", async () => {
    let getCallCount = 0;

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
          };
        if (url.includes("/api/queries/q9/create") && init?.method === "POST")
          return { status: 201, body: { id: "q9", status: "RFQ_READY" } };
        if (url.includes("/api/queries/q9")) {
          getCallCount++;
          // First GET returns fully-populated DRAFT (passes client-side preview),
          // subsequent GETs (after /create) return RFQ_READY
          return { status: 200, body: getCallCount <= 1 ? fullDraftDetail : fullRfqReadyDetail };
        }
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      {
        route: "/queries/q9?step=4",
        user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" },
      },
    );

    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await userEvent.click(createBtn);

    // Success banner should appear
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/created successfully/i),
    );

    // Status badge should flip to RFQ_READY
    await waitFor(() =>
      expect(screen.getByText("RFQ_READY")).toBeInTheDocument(),
    );
  });

  it("Next on Step 1 with missing required fields blocks navigation and flags them (U5)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/q9", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    await screen.findByText("YAL26-0009");

    // Click Next with every required field empty
    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    // A required-fields message appears and we do NOT advance to Step 2 (no Incoterms)
    await waitFor(() => expect(screen.getByText(/required fields/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/incoterms/i)).not.toBeInTheDocument();
  });

  it("Next on Step 1 with all required fields present advances to Step 2 (U5)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url === `/api/clients/${fullDraftDetail.clientId}`)
          return { status: 200, body: { id: fullDraftDetail.clientId, companyName: "Acme", country: "SG", status: "ACTIVE" } };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/queries/q9") && init?.method === "PATCH")
          return { status: 200, body: fullDraftDetail };
        if (url.includes("/api/queries/q9")) return { status: 200, body: fullDraftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/q9", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    await screen.findByText("YAL26-0009");

    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    // Advances to Step 2 — the Incoterms control becomes visible
    await waitFor(() => expect(screen.getByLabelText(/incoterms/i)).toBeInTheDocument());
  });

  it("Save shows a success message at the top (U3)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/queries/q9") && init?.method === "PATCH")
          return { status: 200, body: draftDetail };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/q9", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    await screen.findByText("YAL26-0009");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(screen.getByText(/saved/i)).toBeInTheDocument());
  });

  it("Create Query surfaces a non-422 server error instead of swallowing it (G3)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9/create") && init?.method === "POST")
          return { status: 500, body: { message: "Internal error" } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: fullDraftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/q9?step=4", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await userEvent.click(createBtn);

    // The 500 error is shown to the user (not swallowed); status stays DRAFT
    await waitFor(() => expect(screen.getByText(/internal error/i)).toBeInTheDocument());
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
  });

  it("does not prompt for the un-checkable MSDS item on a non-DG query (G5)", async () => {
    const createCalls: string[] = [];
    // Non-DG query whose ONLY unchecked checklist item is msds-received — which is
    // un-checkable when dgIndicator is false, so it must not count as a missing gap.
    const detailNonDgMsds = {
      ...fullDraftDetail,
      dgIndicator: false,
      checklist: [{ id: "c1", itemKey: "msds-received", checked: false }],
    };

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9/create") && init?.method === "POST") {
          createCalls.push(url);
          return { status: 201, body: { id: "q9", status: "RFQ_READY" } };
        }
        if (url.includes("/api/queries/q9")) return { status: 200, body: detailNonDgMsds };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/q9?step=4", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await userEvent.click(createBtn);

    // No optional-gaps dialog appears; Create proceeds straight to POST /create.
    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(
      screen.queryByText(/Create query with missing optional info/i),
    ).not.toBeInTheDocument();
  });
});
