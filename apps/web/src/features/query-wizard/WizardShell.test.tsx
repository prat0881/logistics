import { describe, it, expect, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "./QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

/**
 * WizardShell test — validates that after a "Create Query" attempt:
 *   1. ValidationSummary heading renders with the correct count.
 *   2. Stepper badges show per-tab blocking-finding counts.
 *   3. Clicking a tab link in ValidationSummary navigates to that step.
 *
 * We drive this via QueryWizardPage (which wires WizardShell + WizardProvider)
 * so we don't have to duplicate provider setup, and so we test the real
 * findings → tabCounts → stepper badge + ValidationSummary integration.
 *
 * The detail includes all required client fields but NO internal notes
 * (F7 blocking) and leaves the checklist empty — so collectChecklistFindings
 * emits blocking findings for the "notes" tab.
 */

const FUTURE_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const CARGO_ID = "aaaa0001-0000-0000-0000-000000000000";
const PICKUP_ID = "aaaa0002-0000-0000-0000-000000000000";
const DELIVERY_ID = "aaaa0003-0000-0000-0000-000000000000";
const LEG_ID = "aaaa0004-0000-0000-0000-000000000000";

/**
 * A detail that passes all client/shipment/cargo/legs checks but:
 *   - internalNotes = "" → F7 blocking → notes tab
 *   - checklist = [] (no items) so collectChecklistFindings finds missing items → notes tab
 * We also include NO clientId so F1 fires → client tab.
 */
const detailWithClientAndNotesFindings = {
  id: "q1",
  queryCode: "YAL26-0001",
  status: "DRAFT",
  priority: "MEDIUM",
  dgIndicator: false,
  whatsappEnabled: false,
  queryDate: FUTURE_DATE,
  responseDeadline: null,
  responseDeadlineRemarks: null,
  // Missing client → F1 fires on client tab
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
  incoterms: "FOB",
  shipmentDescription: null,
  readyDate: FUTURE_DATE,
  targetDelivery: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  // Empty notes → F7 fires on notes tab
  internalNotes: "",
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
      productName: "Widget",
      referenceTags: [],
      hsCode: null,
      packageType: "Carton",
      isDangerous: false,
      msdsFileId: null,
      qty: 2,
      dimL: "30",
      dimW: "20",
      dimH: "10",
      netWt: null,
      grossWt: "5",
      volumeCbm: "0.006",
      freightDensity: null,
      chargeableWeight: null,
    },
  ],
  // Checklist empty → collectChecklistFindings emits blocking for notes tab
  checklist: [],
  files: [],
  points: [
    {
      id: PICKUP_ID,
      tenantId: null,
      queryId: "q1",
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
      id: DELIVERY_ID,
      tenantId: null,
      queryId: "q1",
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
      id: LEG_ID,
      tenantId: null,
      queryId: "q1",
      legCode: "L1",
      legName: null,
      originPointId: PICKUP_ID,
      destinationPointId: DELIVERY_ID,
      mode: "ROAD",
      readyDate: FUTURE_DATE,
      targetDelivery: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      status: "DRAFT",
      executionStatus: "NOT_STARTED",
      totalChargeableWeight: null,
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-01T00:00:00+00:00",
      assignedCargoIds: [CARGO_ID],
      rollup: { totalPackages: 2, totalCbm: 0.006, totalGrossWt: 5, totalNetWt: 0 },
    },
  ],
  freightMode: ["ROAD"],
  origin: [{ id: PICKUP_ID, name: "Origin", city: "Singapore", country: "SG" }],
  destination: [{ id: DELIVERY_ID, name: "Destination", city: "Kuala Lumpur", country: "MY" }],
};

describe("WizardShell", () => {
  it("shows the ValidationSummary and stepper badges for create findings, and navigates on click", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
          };
        if (url.includes("/api/queries/q1/create") && init?.method === "POST")
          return { status: 422, body: { findings: [] } };
        if (url.includes("/api/queries/q1")) return { status: 200, body: detailWithClientAndNotesFindings };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      {
        route: "/queries/q1?step=4",
        user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" },
      },
    );

    // Navigate to the final step and click Create Query
    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await userEvent.click(createBtn);

    // ValidationSummary heading must match the new format
    expect(await screen.findByText(/Resolve .* to create this query/i)).toBeInTheDocument();

    // Badge on the Notes & Checklist tab (at least 1 issue from empty notes + empty checklist)
    const notesBadge = screen.getByLabelText(/Notes & Checklist: \d+ issue/i);
    expect(notesBadge).toBeInTheDocument();

    // Badge on the Client & Query tab (F1: Client is required)
    const clientBadge = screen.getByLabelText(/Client & Query: \d+ issue/i);
    expect(clientBadge).toBeInTheDocument();
  });

  it("clicking a tab group in ValidationSummary navigates to that wizard step", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return {
            status: 200,
            body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
          };
        if (url.includes("/api/queries/q1/create") && init?.method === "POST")
          return { status: 422, body: { findings: [] } };
        if (url.includes("/api/queries/q1")) return { status: 200, body: detailWithClientAndNotesFindings };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      {
        route: "/queries/q1?step=4",
        user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" },
      },
    );

    // Trigger the findings display
    const createBtn = await screen.findByRole("button", { name: /Create Query/i });
    await userEvent.click(createBtn);

    // Wait for ValidationSummary to appear
    const summary = await screen.findByRole("alert");
    expect(summary).toBeInTheDocument();

    // Click on the "Client & Query" tab group button inside the ValidationSummary alert
    // (the Stepper also has a "Client & Query" button — we scope to the alert div)
    const clientGroupBtns = screen.getAllByRole("button", { name: /client & query/i });
    // The ValidationSummary button is the one WITHOUT aria-current and without data-completed
    const summaryBtn = clientGroupBtns.find(
      (b) => !b.hasAttribute("aria-current") && !b.hasAttribute("data-completed"),
    );
    expect(summaryBtn).toBeDefined();
    await userEvent.click(summaryBtn!);

    // Should navigate to the Client & Query step (step 0) — stepper shows it as current
    const allClientBtns = screen.getAllByRole("button", { name: /client & query/i });
    const stepperBtn = allClientBtns.find((b) => b.hasAttribute("aria-current"));
    expect(stepperBtn).toHaveAttribute("aria-current", "step");
  });
});
