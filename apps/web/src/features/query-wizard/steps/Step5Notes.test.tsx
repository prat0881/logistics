import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import type { EmailLogDto } from "@svyft/shared";
import { QueryWizardPage } from "../QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const QUERY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const CHECKLIST_ITEMS = [
  { id: "i1", itemKey: "weight-confirmed", checked: false },
  { id: "i2", itemKey: "dimensions-confirmed", checked: false },
  { id: "i3", itemKey: "hs-code-received", checked: true },
  { id: "i4", itemKey: "dg-confirmed", checked: false },
  { id: "i5", itemKey: "msds-received", checked: false },
  { id: "i6", itemKey: "commercial-invoice", checked: false },
  { id: "i7", itemKey: "packing-list", checked: true },
  { id: "i8", itemKey: "pickup-address", checked: false },
  { id: "i9", itemKey: "delivery-address", checked: false },
];

const baseDetail = {
  id: QUERY_ID,
  queryCode: "YAL26-0055",
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
  checklist: CHECKLIST_ITEMS,
  files: [],
  points: [],
  legs: [],
  freightMode: [],
  origin: [],
  destination: [],
};

/** Navigate to Step 5 (Notes & Checklist) via the stepper button. */
async function navigateToStep5() {
  await screen.findByText("YAL26-0055");
  const notesTab = screen.getByRole("button", { name: /notes/i });
  await userEvent.click(notesTab);
}

describe("Step5Notes", () => {
  it("renders all 9 checklist items with their labels", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=4` },
    );

    await navigateToStep5();

    // All 9 checklist labels should be visible
    expect(await screen.findByText("Weight confirmed")).toBeInTheDocument();
    expect(screen.getByText("Dimensions confirmed")).toBeInTheDocument();
    expect(screen.getByText("HS / HSN code received")).toBeInTheDocument();
    expect(screen.getByText("DG / Non-DG confirmed")).toBeInTheDocument();
    expect(screen.getByText("MSDS received")).toBeInTheDocument();
    expect(screen.getByText("Commercial invoice received")).toBeInTheDocument();
    expect(screen.getByText("Packing list received")).toBeInTheDocument();
    expect(screen.getByText("Pickup address confirmed")).toBeInTheDocument();
    expect(screen.getByText("Delivery address confirmed")).toBeInTheDocument();

    // Should be exactly 9 checkboxes in the checklist section
    // (there may be others in the shell like whatsappEnabled)
    // We look for the checklist items specifically by their presence
    const checkboxes = screen.getAllByRole("checkbox");
    // At least 9 checklist checkboxes
    expect(checkboxes.length).toBeGreaterThanOrEqual(9);
  });

  it("renders the internal notes textarea", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=4` },
    );

    await navigateToStep5();

    // Internal Notes textarea should be present
    const textarea = await screen.findByLabelText(/internal notes/i);
    expect(textarea).toBeInTheDocument();
    // Should show a char counter
    expect(screen.getByText(/\/500/)).toBeInTheDocument();
  });

  it("toggling a checklist item and Save sends PATCH /checklist with {items: [...]} for all items", async () => {
    const checklistPatches: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url === `/api/queries/${QUERY_ID}/checklist` && init?.method === "PATCH") {
          checklistPatches.push(JSON.parse(init.body as string));
          return { status: 200, body: baseDetail };
        }
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=4` },
    );

    await navigateToStep5();

    // Wait for checklist to load
    await screen.findByText("Weight confirmed");

    // Find the "Weight confirmed" checkbox and toggle it
    const weightLabel = screen.getByText("Weight confirmed");
    const weightRow = weightLabel.closest("div");
    const weightCheckbox = weightRow?.querySelector('[role="checkbox"]') as HTMLElement;
    expect(weightCheckbox).toBeTruthy();

    await userEvent.click(weightCheckbox);

    // Click Save
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(checklistPatches.length).toBeGreaterThan(0);
    });

    const body = checklistPatches[checklistPatches.length - 1] as { items: Array<{ itemKey: string; checked: boolean }> };
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    // Should contain all 9 items
    expect(body.items).toHaveLength(9);
    // The "weight-confirmed" item should be toggled to true (was false, now true)
    const weightItem = body.items.find((i) => i.itemKey === "weight-confirmed");
    expect(weightItem).toBeDefined();
    expect(weightItem!.checked).toBe(true);
  });

  it("Save sends notes PATCH /api/queries/:id with {internalNotes}", async () => {
    const notesPatches: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url === `/api/queries/${QUERY_ID}` && init?.method === "PATCH") {
          notesPatches.push(JSON.parse(init.body as string));
          return { status: 200, body: baseDetail };
        }
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=4` },
    );

    await navigateToStep5();

    // Wait for notes textarea to appear
    const textarea = await screen.findByLabelText(/internal notes/i);

    // Type some notes
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Important shipment notes");

    // Click Save
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(notesPatches.length).toBeGreaterThan(0);
    });

    const body = notesPatches[notesPatches.length - 1] as Record<string, unknown>;
    expect(body).toHaveProperty("internalNotes", "Important shipment notes");
  });

  // ── Task 8: Send Follow-up / Acknowledgement + email log ──────────────────

  it("Send Follow-up is disabled when every checklist item is checked", async () => {
    const allChecked = CHECKLIST_ITEMS.map((i) => ({ ...i, checked: true }));

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url === `/api/queries/${QUERY_ID}/emails`)
          return { status: 200, body: [] };
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: { ...baseDetail, checklist: allChecked } };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=4` },
    );

    await navigateToStep5();
    await screen.findByText("Weight confirmed");

    const followUpBtn = await screen.findByRole("button", { name: /send follow-up/i });
    expect(followUpBtn).toBeDisabled();
  });

  it("Send Follow-up POSTs /emails/follow-up when ≥1 checklist item is unchecked", async () => {
    const posts: string[] = [];

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url === `/api/queries/${QUERY_ID}/emails/follow-up` && init?.method === "POST") {
          posts.push(url);
          return { status: 200, body: {} };
        }
        if (url === `/api/queries/${QUERY_ID}/emails`)
          return { status: 200, body: [] };
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: baseDetail }; // has unchecked items
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=4` },
    );

    await navigateToStep5();
    await screen.findByText("Weight confirmed");

    const followUpBtn = await screen.findByRole("button", { name: /send follow-up/i });
    expect(followUpBtn).not.toBeDisabled();
    await userEvent.click(followUpBtn);

    await waitFor(() => {
      expect(posts).toContain(`/api/queries/${QUERY_ID}/emails/follow-up`);
    });
  });

  it("Send Acknowledgement POSTs /emails/acknowledgement and the email appears in the log", async () => {
    const posts: string[] = [];
    let emailsCallCount = 0;

    const loggedEmail: EmailLogDto = {
      id: "email-1",
      queryId: QUERY_ID,
      template: "ACKNOWLEDGEMENT",
      fromAddress: "noreply@svyft.ai",
      toAddress: "client@example.com",
      subject: "Acknowledgement of your query",
      bodyRendered: "We have received your query.",
      status: "LOGGED",
      createdAt: "2026-01-15T10:30:00+00:00",
    };

    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url === `/api/queries/${QUERY_ID}/emails/acknowledgement` && init?.method === "POST") {
          posts.push(url);
          return { status: 200, body: {} };
        }
        if (url === `/api/queries/${QUERY_ID}/emails`) {
          emailsCallCount += 1;
          // Return the logged email after the POST has fired
          return { status: 200, body: emailsCallCount > 1 ? [loggedEmail] : [] };
        }
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: baseDetail };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=4` },
    );

    await navigateToStep5();
    await screen.findByText("Weight confirmed");

    const ackBtn = await screen.findByRole("button", { name: /send acknowledgement/i });
    expect(ackBtn).not.toBeDisabled();
    await userEvent.click(ackBtn);

    await waitFor(() => {
      expect(posts).toContain(`/api/queries/${QUERY_ID}/emails/acknowledgement`);
    });

    // After the POST invalidates the email list query, the log row should appear
    await waitFor(() => {
      expect(screen.getByText(/Acknowledgement of your query/i)).toBeInTheDocument();
    });
  });

  it("renders all 9 checklist boxes enabled, even for a non-DG query", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/queries/${QUERY_ID}`))
          return { status: 200, body: baseDetail }; // dgIndicator: false
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=4` },
    );

    await navigateToStep5();

    // Wait for checklist to load
    await screen.findByText("MSDS received");

    // Find the checklist rows specifically (excludes other checkboxes like whatsappEnabled in the shell)
    const rows = screen.getAllByTestId("checklist-row");
    expect(rows).toHaveLength(9);
    rows.forEach((row) => {
      const checkbox = row.querySelector('[role="checkbox"]') as HTMLElement;
      expect(checkbox).toBeTruthy();
      expect(checkbox).not.toBeDisabled();
    });

    // The N/A hint should not appear for any row
    expect(screen.queryByText(/N\/A — not a DG shipment/i)).not.toBeInTheDocument();
  });
});
