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

const draftDetailWithIncoterms = {
  ...draftDetail,
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
  it("renders Incoterms select and shipment description textarea", async () => {
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

    // Incoterms select trigger
    expect(screen.getByLabelText("Incoterms")).toBeInTheDocument();
  });

  it("no longer renders a DG Indicator field", async () => {
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

    expect(screen.queryByLabelText(/DG Indicator/i)).not.toBeInTheDocument();
  });

  it("offers N/A as an incoterm option", async () => {
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

    // Radix Select renders a hidden native <select> for accessibility/form purposes.
    // We query its options to assert N/A is present (Radix popup is not rendered in jsdom).
    const nativeSelect = document.querySelector(
      'select[aria-hidden="true"]',
    ) as HTMLSelectElement;
    expect(nativeSelect).not.toBeNull();
    const optionValues = Array.from(nativeSelect.options).map((o) => o.value);
    expect(optionValues).toContain("NA");
  });

  it("on Save the PATCH body carries incoterms and shipmentDescription (no dgIndicator)", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/queries/${QUERY_ID}`) && init?.method === "PATCH") {
          patches.push(JSON.parse(init.body as string));
          return { status: 200, body: draftDetailWithIncoterms };
        }
        if (url.includes(`/api/queries/${QUERY_ID}`))
          // Use draftDetailWithIncoterms so the form default has incoterms: "FOB" pre-set
          return { status: 200, body: draftDetailWithIncoterms };
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
    expect(body).not.toHaveProperty("dgIndicator");
    // incoterms key must be present in the patch body (pre-seeded from draftDetailWithIncoterms)
    expect(body).toHaveProperty("incoterms");
  });

  it("defaults Incoterms to N/A and PATCHes incoterms='NA' on save", async () => {
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
          // draftDetail has incoterms: null — so the default "NA" should kick in
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

    // Default shown — the select trigger should display "N/A"
    expect(screen.getByLabelText("Incoterms")).toHaveTextContent("N/A");

    // Hit Save
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Wait for PATCH to be called
    await waitFor(
      () => expect(patches.length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const body = patches[patches.length - 1] as Record<string, unknown>;
    // The PATCH body must carry incoterms: "NA" (stored value, not display label)
    expect(body).toHaveProperty("incoterms", "NA");
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
