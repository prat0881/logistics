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

const rfqReadyDetail = { ...draftDetail, status: "RFQ_READY" };

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

  it("on Create Query → 422 shows blocking findings and status stays DRAFT", async () => {
    const findings = [
      {
        rule: "F1",
        severity: "blocking",
        scope: { type: "query", id: "q9" },
        message: "Client is required",
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
          return { status: 422, body: { findings } };
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

    // Should show the blocking finding
    await waitFor(() =>
      expect(screen.getByText("Client is required")).toBeInTheDocument(),
    );
    // Status should still be DRAFT
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
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
          // First GET returns DRAFT, subsequent GETs return RFQ_READY
          return { status: 200, body: getCallCount <= 1 ? draftDetail : rfqReadyDetail };
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
});
