import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "./QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

// Use a dynamic date ~7 days in the future so the auto-filled Response Deadline
// (queryDate + up to 48h) always passes the F4 "not in the past" check.
const FUTURE_QUERY_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const draftDetail = {
  id: "q9",
  queryCode: "YAL26-0009",
  status: "DRAFT",
  priority: "MEDIUM",
  dgIndicator: false,
  whatsappEnabled: false,
  queryDate: FUTURE_QUERY_DATE,
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
  internalNotes: "Ready for RFQ",
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

  it("Create Query blocks with a validation summary when the checklist is incomplete", async () => {
    const createCalls: string[] = [];

    // fullDraftDetail has all required fields; add an unchecked checklist item +
    // empty notes → collectChecklistFindings returns blocking findings
    const detailWithIncompleteChecklist = {
      ...fullDraftDetail,
      internalNotes: "",
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
        if (url.includes("/api/queries/q9")) return { status: 200, body: detailWithIncompleteChecklist };
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

    // ValidationSummary should appear with blocking findings
    await screen.findByText(/Resolve .* to create this query/i);
    const blockingItems = await screen.findAllByText(/Internal notes are required|must be confirmed/i);
    expect(blockingItems.length).toBeGreaterThan(0);

    // Server was NOT called — gate aborted before the request
    expect(createCalls.length).toBe(0);
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

  it("Next advances to Step 2 even when Step-1 mandatory fields are empty (Round-1 Common #5)", async () => {
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

    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    expect(await screen.findByText(/Shipment Details/i)).toBeInTheDocument();
    expect(screen.queryByText(/required fields before continuing/i)).not.toBeInTheDocument();
  });

  it("mints a new query on Next even when Step-1 phone field has a format-invalid value (Final-review fix #1)", async () => {
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
        <Route path="/queries/new" element={<QueryWizardPage />} />
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    // Type a format-invalid phone into the Phone (E.164) field
    const phoneInput = await screen.findByPlaceholderText("+6591234567");
    await userEvent.clear(phoneInput);
    await userEvent.type(phoneInput, "abc");

    // Click Next — must mint the query even though the phone value is invalid
    await userEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    // POST /api/queries must have been called (the query was minted)
    await waitFor(() => expect(posts.length).toBe(1));
    // And the app navigated to the real query (queryCode appears)
    expect(await screen.findByText("YAL26-0009")).toBeInTheDocument();
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

  it("Create Query blocks when msds-received is unchecked (all checklist items are required, no DG exemption)", async () => {
    const createCalls: string[] = [];
    // Under the new gate, all checklist items must be confirmed — there is no DG exemption.
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

    // Gate blocks: msds-received unchecked is a blocking finding (no DG exemption)
    await waitFor(() =>
      expect(screen.getByText(/MSDS received must be confirmed/i)).toBeInTheDocument(),
    );
    // Server was NOT called
    expect(createCalls.length).toBe(0);
  });
});
