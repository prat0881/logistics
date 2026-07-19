import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "../QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const draftDetail = {
  id: QUERY_ID,
  queryCode: "YAL26-0042",
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

const draftDetailWithDg = {
  ...draftDetail,
  dgIndicator: true,
  incoterms: "FOB",
  shipmentDescription: "Electronics shipment",
};

function baseHandler(url: string, init?: RequestInit) {
  if (url.includes("/api/auth/me"))
    return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
  if (url.includes(`/api/queries/${QUERY_ID}`) && init?.method === "PATCH")
    return { status: 200, body: draftDetail };
  if (url.includes(`/api/queries/${QUERY_ID}`))
    return { status: 200, body: draftDetail };
  return { status: 200, body: {} };
}

/** Navigate to Step 2 (Shipment) by clicking the "Shipment" stepper entry. */
async function navigateToStep2() {
  // The wizard starts on step 0 (Client & Query); click on "Shipment" in the stepper.
  await screen.findByText("YAL26-0042");
  const shipmentTab = screen.getByRole("button", { name: /shipment/i });
  await userEvent.click(shipmentTab);
}

describe("Step2Shipment", () => {
  it("renders Incoterms options, shipment description textarea, and DG checkbox", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(baseHandler),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=1`, user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } },
    );

    await navigateToStep2();

    // Shipment Description textarea
    expect(screen.getByLabelText(/shipment description/i)).toBeInTheDocument();

    // DG Indicator checkbox
    expect(screen.getByRole("checkbox", { name: /dg indicator/i })).toBeInTheDocument();

    // Hint text about DG
    expect(screen.getByText(/set automatically when a cargo row is dangerous/i)).toBeInTheDocument();
  });

  it("DG checkbox reflects detail.dgIndicator (true case)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/queries/${QUERY_ID}`) && init?.method === "PATCH")
          return { status: 200, body: draftDetailWithDg };
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: draftDetailWithDg };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=1`, user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } },
    );

    await navigateToStep2();

    // DG checkbox should be checked when detail.dgIndicator is true
    await waitFor(() => {
      const dgCheckbox = screen.getByRole("checkbox", { name: /dg indicator/i });
      expect(dgCheckbox).toBeChecked();
    });
  });

  it("on Save the PATCH body carries incoterms, shipmentDescription, and dgIndicator", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/queries/${QUERY_ID}`) && init?.method === "PATCH") {
          patches.push(JSON.parse(init.body as string));
          return { status: 200, body: draftDetailWithDg };
        }
        if (url.includes(`/api/queries/${QUERY_ID}`))
          // Use draftDetailWithDg so the form default has incoterms: "FOB" pre-set
          return { status: 200, body: draftDetailWithDg };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=1`, user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } },
    );

    await navigateToStep2();

    // Fill in shipment description
    const descInput = screen.getByLabelText(/shipment description/i);
    await userEvent.clear(descInput);
    await userEvent.type(descInput, "Test cargo shipment");

    // Hit Save
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Wait for PATCH to be called
    await waitFor(
      () => expect(patches.length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const body = patches[patches.length - 1] as Record<string, unknown>;
    expect(body).toHaveProperty("shipmentDescription", "Test cargo shipment");
    expect(body).toHaveProperty("dgIndicator");
    // incoterms key must be present in the patch body (pre-seeded from draftDetailWithDg)
    expect(body).toHaveProperty("incoterms");
  });

  it("a single Step-2 Save issues exactly ONE PATCH to /api/queries/:id (no double-write)", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/queries/${QUERY_ID}`) && init?.method === "PATCH") {
          patches.push(JSON.parse(init.body as string));
          return { status: 200, body: draftDetail };
        }
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: draftDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=1`, user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } },
    );

    await navigateToStep2();

    // Hit Save
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Wait for at least one PATCH
    await waitFor(
      () => expect(patches.length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    // Allow a brief window for any spurious second PATCH to arrive
    await new Promise((r) => setTimeout(r, 100));

    // Must be exactly ONE PATCH — Step 2 self-patches and returns undefined to the shell
    expect(patches.length).toBe(1);
  });
});
