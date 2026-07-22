/**
 * QueryWizard.e2e.test.tsx
 *
 * Full-flow component test (e2e style) for the Query Wizard:
 *   - Happy path: mint → create fired → RFQ_READY badge + success banner
 *   - 422 path: create returns blocking findings → panel renders, status stays DRAFT
 *
 * Approach:
 *   - All API calls are mocked via mockFetch / vi.stubGlobal("fetch", …)
 *   - Radix <Select> is driven via the hidden native <select aria-hidden="true"> elements
 *   - Focus is on the KEY transitions; not on every field widget
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "./QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

// ── Stable UUIDs ────────────────────────────────────────────────────────────
const Q_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const CARGO_ID = "33333333-3333-3333-3333-333333333333";
const PICKUP_ID = "44444444-4444-4444-4444-444444444444";
const DELIVERY_ID = "55555555-5555-5555-5555-555555555555";
const LEG_ID = "66666666-6666-6666-6666-666666666666";

// ── Shared response fixtures ─────────────────────────────────────────────────
const READY_DATE = "2026-09-01T00:00:00+00:00";
const TARGET_DELIVERY = "2026-09-15T00:00:00+00:00";

/** A fully-populated DRAFT detail (post-mint) with all required fields for Create */
const fullDraftDetail = {
  id: Q_ID,
  queryCode: "YAL26-0042",
  status: "DRAFT",
  priority: "MEDIUM",
  dgIndicator: false,
  whatsappEnabled: false,
  queryDate: "2026-07-01T00:00:00+00:00",
  responseDeadline: null,
  responseDeadlineRemarks: null,
  clientId: CLIENT_ID,
  contactName: "Alice Tester",
  contactDesignation: null,
  contactEmail: "alice@example.com",
  contactPhone: "+6591234567",
  faxNumber: null,
  vesselId: null,
  vesselName: null,
  imoNumber: null,
  eta: null,
  etb: null,
  etd: null,
  portOfCall: null,
  incoterms: "FOB",
  shipmentDescription: null,
  readyDate: READY_DATE,
  targetDelivery: TARGET_DELIVERY,
  internalNotes: "Ready for RFQ",
  tenantId: null,
  rfqReadyAt: null,
  assignedUserId: null,
  createdAt: "2026-07-01T00:00:00+00:00",
  updatedAt: "2026-07-01T00:00:00+00:00",
  cargo: [
    {
      id: CARGO_ID,
      rowIndex: 0,
      poReference: "PO-E2E-001",
      productName: "Test Widget",
      referenceTags: [],
      hsCode: null,
      packageType: "Carton",
      isDangerous: false,
      msdsFileId: null,
      qty: 10,
      dimL: "50",
      dimW: "40",
      dimH: "30",
      netWt: "45",
      grossWt: "50",
      volumeCbm: "0.06",
      freightDensity: null,
      chargeableWeight: null,
    },
  ],
  checklist: [],
  files: [],
  points: [
    {
      id: PICKUP_ID,
      tenantId: null,
      queryId: Q_ID,
      type: "PICKUP",
      name: "Origin Warehouse",
      streetAddress: "1 Origin St",
      city: "Singapore",
      postalCode: "018989",
      country: "SG",
      contactName: "Sender Contact",
      contactPhone: "+6591234567",
      contactEmail: "sender@example.com",
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      createdAt: "2026-07-01T00:00:00+00:00",
      updatedAt: "2026-07-01T00:00:00+00:00",
    },
    {
      id: DELIVERY_ID,
      tenantId: null,
      queryId: Q_ID,
      type: "DELIVERY",
      name: "Dest Warehouse",
      streetAddress: "2 Dest Rd",
      city: "Kuala Lumpur",
      postalCode: "50000",
      country: "MY",
      contactName: "Receiver Contact",
      contactPhone: "+60123456789",
      contactEmail: null,
      warehouseType: null,
      iataCode: null,
      icaoCode: null,
      unLocode: null,
      terminal: null,
      createdAt: "2026-07-01T00:00:00+00:00",
      updatedAt: "2026-07-01T00:00:00+00:00",
    },
  ],
  legs: [
    {
      id: LEG_ID,
      tenantId: null,
      queryId: Q_ID,
      legCode: "L1",
      legName: null,
      originPointId: PICKUP_ID,
      destinationPointId: DELIVERY_ID,
      mode: "ROAD",
      readyDate: READY_DATE,
      targetDelivery: TARGET_DELIVERY,
      status: "DRAFT",
      executionStatus: "NOT_STARTED",
      totalChargeableWeight: null,
      createdAt: "2026-07-01T00:00:00+00:00",
      updatedAt: "2026-07-01T00:00:00+00:00",
      assignedCargoIds: [CARGO_ID],
      rollup: { totalPackages: 10, totalCbm: 0.06, totalGrossWt: 50, totalNetWt: 45 },
    },
  ],
  freightMode: ["ROAD"],
  origin: [{ id: PICKUP_ID, name: "Origin Warehouse", city: "Singapore", country: "SG" }],
  destination: [{ id: DELIVERY_ID, name: "Dest Warehouse", city: "Kuala Lumpur", country: "MY" }],
};

/** Minimal bare-bones DRAFT returned right after minting (no fields filled yet) */
const mintedDraft = {
  id: Q_ID,
  queryCode: "YAL26-0042",
  status: "DRAFT",
  priority: "MEDIUM",
  dgIndicator: false,
  whatsappEnabled: false,
  queryDate: "2026-07-01T00:00:00+00:00",
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
  createdAt: "2026-07-01T00:00:00+00:00",
  updatedAt: "2026-07-01T00:00:00+00:00",
  cargo: [],
  checklist: [],
  files: [],
  points: [],
  legs: [],
  freightMode: [],
  origin: [],
  destination: [],
};

const rfqReadyDetail = { ...fullDraftDetail, status: "RFQ_READY" };

const testUser = { id: "u1", name: "Alice Exec", email: "alice@svyft.ai", role: "EXECUTIVE" as const };

// ── Scenario 1: Happy path — mint → navigate to final step → Create → RFQ_READY ────
describe("QueryWizard e2e — happy path", () => {
  it("mints a query, then Create Query fires POST /create and shows RFQ_READY + success banner", async () => {
    const user = userEvent.setup();
    const createCalls: string[] = [];

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        // Auth
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: testUser } };

        // POST /api/queries → mint
        if (url === "/api/queries" && init?.method === "POST")
          return { status: 201, body: mintedDraft };

        // POST /api/queries/:id/create
        if (url.includes(`/api/queries/${Q_ID}/create`) && init?.method === "POST") {
          createCalls.push(url);
          return { status: 201, body: { id: Q_ID, status: "RFQ_READY" } };
        }

        // GET /api/queries/:id — returns full DRAFT until /create fires, then RFQ_READY
        if (url.includes(`/api/queries/${Q_ID}`) && (!init?.method || init.method === "GET")) {
          return {
            status: 200,
            body: createCalls.length > 0 ? rfqReadyDetail : fullDraftDetail,
          };
        }

        // Fallback
        return { status: 200, body: {} };
      }),
    );

    // Start at /queries/new
    renderWithProviders(
      <Routes>
        <Route path="/queries/new" element={<QueryWizardPage />} />
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new", user: testUser },
    );

    // ── Step 1: click Save to mint the query ────────────────────────────────
    const saveBtn = await screen.findByRole("button", { name: /^Save$/ });
    await user.click(saveBtn);

    // Assert query code appears (mint succeeded)
    await waitFor(() =>
      expect(screen.getByText("YAL26-0042")).toBeInTheDocument(),
    );

    // ── Jump to the final step (step=4) — stepper jump is available now ──────
    // After mint, we navigate to /queries/:id?step=0. Navigate directly to step 4.
    // In the test, we can use the stepper or just re-render at step=4.
    // The simplest approach: navigate to the notes step via the stepper click
    // (the wizard route now has the query id and stepper is enabled).
    // We'll find the "Notes & Checklist" step and click it.
    const notesStepBtn = await screen.findByRole("button", { name: /Notes & Checklist/i });
    await user.click(notesStepBtn);

    // Wait for the Create Query button (only visible on final step)
    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    expect(createBtn).not.toBeDisabled();

    // ── Click Create Query ───────────────────────────────────────────────────
    await user.click(createBtn);

    // Assert POST /create was fired
    await waitFor(() => expect(createCalls.length).toBe(1));

    // Assert success banner appears
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/created successfully/i),
    );

    // Assert header badge flips to RFQ_READY
    await waitFor(() =>
      expect(screen.getByText("RFQ_READY")).toBeInTheDocument(),
    );
  });
});

// ── Scenario 2: 422 from server → blocking findings shown, DRAFT stays ───────
describe("QueryWizard e2e — 422 server block", () => {
  it("shows server 422 findings and status stays DRAFT when create is rejected", async () => {
    const user = userEvent.setup();

    const serverFindings = [
      {
        rule: "R2",
        severity: "blocking",
        scope: { type: "cargo", id: CARGO_ID },
        message: "Cargo PO-E2E-001: chain must start at a Pickup",
      },
    ];

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: testUser } };

        if (url.includes(`/api/queries/${Q_ID}/create`) && init?.method === "POST")
          return { status: 422, body: { findings: serverFindings } };

        if (url.includes(`/api/queries/${Q_ID}`))
          return { status: 200, body: fullDraftDetail };

        return { status: 200, body: {} };
      }),
    );

    // Start directly at the final step of an existing query
    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${Q_ID}?step=4`, user: testUser },
    );

    // Wait for page load
    await screen.findByText("YAL26-0042");

    // Click Create Query
    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await user.click(createBtn);

    // The server 422 finding should render
    await waitFor(() =>
      expect(
        screen.getByText("Cargo PO-E2E-001: chain must start at a Pickup"),
      ).toBeInTheDocument(),
    );

    // Status badge should still say DRAFT
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
  });
});

// ── Scenario 3: client-side blocking preview stops the create call ────────────
describe("QueryWizard e2e — client preview blocks missing fields", () => {
  it("shows client-side blocking findings without calling /create when required fields missing", async () => {
    const user = userEvent.setup();
    const createCalls: string[] = [];

    // Detail with NO clientId / contactName / etc. — will trigger F1 blocking findings
    const incompleteDraft = {
      ...fullDraftDetail,
      clientId: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      incoterms: null,
    };

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: testUser } };

        if (url.includes(`/api/queries/${Q_ID}/create`) && init?.method === "POST") {
          createCalls.push(url);
          return { status: 201, body: { id: Q_ID, status: "RFQ_READY" } };
        }

        if (url.includes(`/api/queries/${Q_ID}`))
          return { status: 200, body: incompleteDraft };

        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${Q_ID}?step=4`, user: testUser },
    );

    await screen.findByText("YAL26-0042");

    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await user.click(createBtn);

    // Client-side blocking finding should appear (F1 — Client is required)
    await waitFor(() =>
      expect(screen.getByText("Client is required")).toBeInTheDocument(),
    );

    // /create should NOT have been called
    expect(createCalls.length).toBe(0);

    // Status stays DRAFT
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
  });
});

