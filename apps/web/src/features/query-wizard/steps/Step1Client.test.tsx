import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "../QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

// Dynamic date ~7 days ahead so auto-filled Response Deadline (queryDate + up to 48h)
// always passes the F4 "not in the past" schema check regardless of when tests run.
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
  readyDateTimezone: null,
  targetDeliveryTimezone: null,
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

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const CONTACT_1_ID = "22222222-2222-2222-2222-222222222222";
const CONTACT_2_ID = "33333333-3333-3333-3333-333333333333";

const client1 = {
  id: CLIENT_ID,
  clientCode: "CLI001",
  companyName: "Acme Corp",
  industry: "Logistics",
  country: "SG",
  status: "ACTIVE",
};

const contacts = [
  {
    id: CONTACT_1_ID,
    name: "John Doe",
    designation: "Manager",
    contactNo: "+6591234567",
    email: "john@acme.com",
    isPrimary: true,
  },
  {
    id: CONTACT_2_ID,
    name: "Jane Smith",
    designation: "Executive",
    contactNo: "+6598765432",
    email: "jane@acme.com",
    isPrimary: false,
  },
];

describe("Step1Client", () => {
  it("renders the Step 1 form with key fields", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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
    // Check that the form shows key field labels
    expect(screen.getByText(/Query ID/i)).toBeInTheDocument();
    expect(screen.getByText(/Priority/i)).toBeInTheDocument();

    // Regression: all key Step-1 fields must still render after any layout change
    for (const label of [
      /Query Date/i,
      /Priority/i,
      /Company \/ Client/i,
      /Contact Name/i,
      /Email/i,
      /Phone/i,
      /Target Pickup/i,
      /Target Delivery/i,
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // "Response Deadline" also matches "Response Deadline Remarks" — use getAllByText
    expect(screen.getAllByText(/Response Deadline/i).length).toBeGreaterThan(0);
  });

  it("selecting a client loads its contacts into the Contact Person select", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        if (url.includes(`/api/clients/${CLIENT_ID}/contacts`)) return { status: 200, body: contacts };
        if (url.includes("/api/clients") && url.includes("q=acme"))
          return { status: 200, body: { items: [client1], total: 1, page: 1, pageSize: 20 } };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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

    // Click the client picker trigger
    const clientPickerBtn = screen.getByRole("button", { name: /select client/i });
    await userEvent.click(clientPickerBtn);

    // Search for client
    const clientInput = screen.getByPlaceholderText(/search client/i);
    await userEvent.type(clientInput, "acme");

    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Acme Corp"));

    // After selecting client, contacts should load into the Contact Person selector
    await waitFor(() => expect(screen.getByText("John Doe")).toBeInTheDocument());
  });

  it("choosing a contact prefills contactName and contactEmail", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        if (url.includes(`/api/clients/${CLIENT_ID}/contacts`)) return { status: 200, body: contacts };
        if (url.includes("/api/clients") && url.includes("q=acme"))
          return { status: 200, body: { items: [client1], total: 1, page: 1, pageSize: 20 } };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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

    // Select client
    const clientPickerBtn = screen.getByRole("button", { name: /select client/i });
    await userEvent.click(clientPickerBtn);
    const clientInput = screen.getByPlaceholderText(/search client/i);
    await userEvent.type(clientInput, "acme");
    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Acme Corp"));

    // Wait for contacts to load, then select one
    await waitFor(() => expect(screen.getByText("John Doe")).toBeInTheDocument());

    // Open the contact person select
    const contactSelect = screen.getByRole("combobox", { name: /contact person/i });
    await userEvent.click(contactSelect);
    const johnDoeOption = await screen.findAllByText("John Doe");
    // Click on the option in the dropdown
    await userEvent.click(johnDoeOption[johnDoeOption.length - 1]);

    // Contact email should be prefilled
    await waitFor(() => {
      const emailInput = screen.getByDisplayValue("john@acme.com");
      expect(emailInput).toBeInTheDocument();
    });
  });

  it("on Save calls patch with clientId in the body when client is selected", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/clients/${CLIENT_ID}/contacts`)) return { status: 200, body: contacts };
        if (url.includes("/api/clients") && url.includes("q=acme"))
          return { status: 200, body: { items: [client1], total: 1, page: 1, pageSize: 20 } };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/queries/q9") && init?.method === "PATCH") {
          patches.push(JSON.parse(init.body as string));
          return { status: 200, body: draftDetail };
        }
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

    // Select client via ClientPicker
    const clientPickerBtn = screen.getByRole("button", { name: /select client/i });
    await userEvent.click(clientPickerBtn);
    const clientInput = screen.getByPlaceholderText(/search client/i);
    await userEvent.type(clientInput, "acme");
    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Acme Corp"));

    // Contacts load after client selection; wait for them
    await waitFor(() => expect(screen.getByText("John Doe")).toBeInTheDocument());

    // Fill in contactEmail directly via the email input
    const emailInput = screen.getByPlaceholderText("email@example.com");
    await userEvent.clear(emailInput);
    await userEvent.type(emailInput, "john@acme.com");

    // Ensure the value is in the DOM before saving
    await waitFor(() => expect(emailInput).toHaveValue("john@acme.com"));

    // Hit Save and wait for it to complete
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // PATCH should be called with clientId and contactEmail
    await waitFor(
      () => expect(patches.length).toBeGreaterThan(0),
      { timeout: 3000 },
    );
    const body = patches[0] as Record<string, unknown>;
    expect(body.clientId).toBe(CLIENT_ID);
    expect(body.contactEmail).toBe("john@acme.com");
  });

  it("a client-side schema error (bad email) shows FormMessage and blocks Save", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/queries") && init?.method === "PATCH") {
          patches.push(JSON.parse(init.body as string));
          return { status: 200, body: draftDetail };
        }
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

    // Type a bad email
    const emailInput = screen.getByPlaceholderText("email@example.com");
    await userEvent.clear(emailInput);
    await userEvent.type(emailInput, "not-an-email");

    // Hit Save
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Should show a validation error message (may appear in FormMessage and/or the shell error bar)
    await waitFor(() => {
      const matches = screen.getAllByText(/invalid email/i);
      expect(matches.length).toBeGreaterThan(0);
    });

    // PATCH should NOT have been called
    expect(patches.length).toBe(0);
  });

  it("new query (no detail) renders Query Date with today's date as default", async () => {
    // Fix 1: for a brand-new query the Query Date field must not be empty — it should
    // default to the real local now() so the pre-save UI shows the correct time.
    const todayPrefix = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "A", email: "a@x", role: "ADMINISTRATOR" } } };
        if (url.includes("/api/config/org-timezone"))
          return { status: 200, body: { timezone: "Asia/Kolkata" } };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/new" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new", user: { id: "u1", name: "A", email: "a@x", role: "ADMINISTRATOR" } },
    );

    // Wait for the Step 1 form to render (no queryCode for a new query — wait for the field label)
    await waitFor(() => expect(screen.getByText(/Query ID/i)).toBeInTheDocument());

    // The Query Date input must be non-empty and start with today's date.
    await waitFor(() => {
      // The Query Date field is read-only for non-admins; we test as ADMINISTRATOR so it's readable.
      const queryDateInput = screen.getByLabelText("Query Date") as HTMLInputElement;
      expect(queryDateInput.value).not.toBe("");
      // The displayed wall-clock (viewer zone) must correspond to today's date.
      expect(queryDateInput.value.slice(0, 10)).toBe(todayPrefix);
    });
  });

  it("new query seeds Target Pickup / Target Delivery to today 12:00 (:00) in the org zone", async () => {
    // The remaining datetime bug: empty date fields render the native datetime-local
    // placeholder, which reads as "12:30" once an empty UTC instant is projected into IST.
    // For a NEW query these must open on a clean 12:00 (:00, editable) default in the org zone.
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/config/org-timezone"))
          return { status: 200, body: { timezone: "Asia/Kolkata" } };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/new" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    await waitFor(() => expect(screen.getByText(/Query ID/i)).toBeInTheDocument());

    // Target Pickup and Target Delivery must both display 12:00 (minutes :00) in Asia/Kolkata.
    await waitFor(() => {
      const pickup = screen.getByLabelText(
        (c) => /^Target Pickup(\s*\*)?$/i.test(c),
      ) as HTMLInputElement;
      expect(pickup.value.endsWith("T12:00")).toBe(true);
    });
    const delivery = screen.getByLabelText(
      (c) => /^Target Delivery(\s*\*)?$/i.test(c),
    ) as HTMLInputElement;
    expect(delivery.value.endsWith("T12:00")).toBe(true);
  });

  it("ETA/ETB/ETD are NOT seeded (F3 ordering forbids equal defaults) — stay empty on a new query", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/config/org-timezone"))
          return { status: 200, body: { timezone: "Asia/Kolkata" } };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        return { status: 200, body: {} };
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/new" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/new", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    await waitFor(() => expect(screen.getByText(/Query ID/i)).toBeInTheDocument());
    // Wait until Target Pickup has been seeded (proves the seed effect has run) …
    await waitFor(() => {
      const pickup = screen.getByLabelText((c) => /^Target Pickup(\s*\*)?$/i.test(c)) as HTMLInputElement;
      expect(pickup.value).not.toBe("");
    });
    // … then ETA/ETB/ETD must still be empty (never defaulted).
    for (const label of ["ETA", "ETB", "ETD"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
    }
  });

  it("non-admin Save strips queryDate from PATCH body (existing query with queryDate)", async () => {
    const patches: unknown[] = [];
    const detailWithClient = {
      ...draftDetail,
      clientId: CLIENT_ID,
      // queryDate is always present on an existing query; keep dynamic to avoid F4 failures
      queryDate: FUTURE_QUERY_DATE,
    };
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes(`/api/clients/${CLIENT_ID}/contacts`)) return { status: 200, body: contacts };
        if (url.includes(`/api/clients/${CLIENT_ID}`)) return { status: 200, body: client1 };
        if (url.includes("/api/clients") && url.includes("q=acme"))
          return { status: 200, body: { items: [client1], total: 1, page: 1, pageSize: 20 } };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/queries/q9") && init?.method === "PATCH") {
          patches.push(JSON.parse(init.body as string));
          return { status: 200, body: detailWithClient };
        }
        if (url.includes("/api/queries/q9")) return { status: 200, body: detailWithClient };
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

    // Wait for the client name to appear (detail has clientId pre-set)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Acme Corp/i })).toBeInTheDocument();
    });

    // Hit Save — as EXECUTIVE (non-admin)
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(
      () => expect(patches.length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    const body = patches[0] as Record<string, unknown>;
    // queryDate must NOT be in the PATCH body for a non-admin user
    expect(body).not.toHaveProperty("queryDate");
    // Other editable fields should still be present
    expect(body).toHaveProperty("priority");
  });

  it("Response Deadline field shows a 'Times in' zone hint (org zone = Asia/Kolkata)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/config/org-timezone"))
          return { status: 200, body: { timezone: "Asia/Kolkata" } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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

    // The Response Deadline field should show a "Times in" hint (rendered by ZonedDateTimeField)
    await waitFor(() => {
      const hints = screen.getAllByText(/Times in/i);
      expect(hints.length).toBeGreaterThan(0);
    });
  });

  it("readyDate with a stored UTC instant renders the org-zone wall-clock when no points exist", async () => {
    // 2026-06-15T03:30:00.000Z in Asia/Kolkata (UTC+5:30) = 2026-06-15T09:00
    const STORED_READY_DATE = "2026-06-15T03:30:00.000Z";
    const detailWithReadyDate = {
      ...draftDetail,
      readyDate: STORED_READY_DATE,
      points: [], // no points → anchor = org zone
    };

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/config/org-timezone"))
          return { status: 200, body: { timezone: "Asia/Kolkata" } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: detailWithReadyDate };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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

    // The Ready Date field should show the UTC instant converted to Asia/Kolkata wall-clock
    await waitFor(() => {
      // getByLabelText with a function matcher: match labels whose text is "Ready Date"
      // (with optional " *" from required marker) but NOT "Ready Date timezone".
      const readyDateInput = screen.getByLabelText(
        (content) => /^Target Pickup(\s*\*)?$/i.test(content),
      ) as HTMLInputElement;
      // 2026-06-15T03:30Z in Asia/Kolkata (UTC+5:30) = 2026-06-15T09:00
      expect(readyDateInput.value).toBe("2026-06-15T09:00");
    });
  });

  it("defaults Response Deadline to Query Date + 24h for MEDIUM and recomputes on priority change until edited", async () => {
    const user = userEvent.setup();

    // Use a dynamic future queryDate so auto-filled deadline (queryDate + 24h) passes F4.
    const detailNoDeadline = {
      ...draftDetail,
      queryDate: FUTURE_QUERY_DATE,
      priority: "MEDIUM",
      responseDeadline: null,
    };

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/config/org-timezone"))
          return { status: 200, body: { timezone: "Asia/Kolkata" } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: detailNoDeadline };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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

    // Response Deadline should be auto-filled (MEDIUM = queryDate + 24h), zeroed to :00 in IST.
    // Use exact match to avoid matching "Response Deadline Remarks"
    const deadline = screen.getByLabelText("Response Deadline") as HTMLInputElement;
    await waitFor(() => expect(deadline.value).not.toBe(""));

    const mediumValue = deadline.value;
    expect(mediumValue).not.toBe("");
    // Fix 2: the displayed wall-clock (IST = UTC+5:30) must show :00 minutes, not :30.
    expect(mediumValue.endsWith(":00")).toBe(true);

    // Switch priority to URGENT via the Radix Select (URGENT = +12h, different from MEDIUM +24h)
    const priorityTrigger = screen.getByRole("combobox", { name: /Priority/i });
    await user.click(priorityTrigger);
    const urgentOption = await screen.findByRole("option", { name: "URGENT" });
    await user.click(urgentOption);

    // Deadline should recompute (still filled, but a different value)
    await waitFor(() => {
      expect(deadline.value).not.toBe("");
      expect(deadline.value).not.toBe(mediumValue);
    });

    // Manual edit marks it touched — after this, priority changes should NOT recompute.
    // Use a dynamic future value so this test stays green indefinitely.
    // minutes snap to :00 on first entry into an empty field (round-3 datetime default)
    const rawDeadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16); // "YYYY-MM-DDTHH:mm" — matches datetime-local input format
    // Force minutes to :00 so the value matches the :00-snap that ZonedDateTimeField applies
    // on first keystroke into an empty field.
    const manualDeadline = rawDeadline.slice(0, 13) + ":00"; // "YYYY-MM-DDTHH:00"
    await user.clear(deadline);
    await user.type(deadline, manualDeadline);
    expect(deadline.value).toBe(manualDeadline);

    // Switch priority again — deadline should stay at the manually typed value
    await user.click(priorityTrigger);
    const mediumOption = await screen.findByRole("option", { name: "MEDIUM" });
    await user.click(mediumOption);

    // Deadline must not change after manual edit
    expect(deadline.value).toBe(manualDeadline);
  });

  it("renders Ready-zone and Target-zone pickers defaulting to Asia/Kolkata, and Ready field hint reflects the zone", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/config/org-timezone"))
          return { status: 200, body: { timezone: "Asia/Kolkata" } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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

    // Ready-zone picker should render and default to Asia/Kolkata
    await waitFor(() => {
      const readyZonePicker = screen.getByRole("button", { name: /Target Pickup timezone/i });
      expect(readyZonePicker).toBeInTheDocument();
      expect(readyZonePicker.textContent).toContain("Asia/Kolkata");
    }, { timeout: 3000 });

    // Target-zone picker should render and default to Asia/Kolkata
    await waitFor(() => {
      const targetZonePicker = screen.getByRole("button", { name: /Target Delivery timezone/i });
      expect(targetZonePicker).toBeInTheDocument();
      expect(targetZonePicker.textContent).toContain("Asia/Kolkata");
    }, { timeout: 3000 });

    // Ready field's "Times in" hint should reflect the picked zone (Asia/Kolkata)
    await waitFor(() => {
      const hints = screen.getAllByText(/Times in/i);
      const readyHint = hints.find((h) => h.textContent?.includes("Asia/Kolkata"));
      expect(readyHint).toBeDefined();
    }, { timeout: 3000 });
  });

  it("non-Kolkata org (Asia/Singapore) — zone pickers show real org zone, not Kolkata default", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/config/org-timezone"))
          return { status: 200, body: { timezone: "Asia/Singapore" } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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

    // Regression: must show Asia/Singapore (GMT+08:00), NOT Asia/Kolkata (the DEFAULT_ORG_TIMEZONE)
    // This would fail under the old bug where defaultValues seeded Kolkata synchronously and
    // the seed-when-empty effect found the field non-empty and skipped setting the real zone.
    await waitFor(() => {
      const readyZonePicker = screen.getByRole("button", { name: /Target Pickup timezone/i });
      expect(readyZonePicker.textContent).toContain("Asia/Singapore");
      expect(readyZonePicker.textContent).not.toContain("Asia/Kolkata");
    }, { timeout: 3000 });

    await waitFor(() => {
      const targetZonePicker = screen.getByRole("button", { name: /Target Delivery timezone/i });
      expect(targetZonePicker.textContent).toContain("Asia/Singapore");
      expect(targetZonePicker.textContent).not.toContain("Asia/Kolkata");
    }, { timeout: 3000 });
  });

  it("org-zone clobber regression: user edits before org-zone resolves survive after it resolves", async () => {
    // Defer the org-timezone response so we can simulate an edit during the fetch window.
    // We bypass mockFetch for this test and install a raw vi.fn that returns Promises directly,
    // allowing us to hold the org-timezone response until after the user has made an edit.
    let resolveOrgTz!: () => void;
    const orgTzDeferred = new Promise<void>((res) => { resolveOrgTz = res; });

    const detailWithContact = {
      ...draftDetail,
      contactName: "Original Name",
    };

    const makeMockResponse = (body: unknown, status = 200) =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response);

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/auth/me"))
          return makeMockResponse({ user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } });
        if (url.includes("/api/config/org-timezone"))
          return orgTzDeferred.then(() => makeMockResponse({ timezone: "Asia/Singapore" }));
        if (url.includes("/api/queries/q9")) return makeMockResponse(detailWithContact);
        if (url.includes("/api/clients")) return makeMockResponse({ items: [], total: 0, page: 1, pageSize: 20 });
        if (url.includes("/api/vessels")) return makeMockResponse({ items: [], total: 0, page: 1, pageSize: 20 });
        return makeMockResponse({});
      }),
    );

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: "/queries/q9", user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } },
    );

    // Wait for the form to render with the detail's contact name
    await screen.findByText("YAL26-0009");
    const contactNameInput = screen.getByPlaceholderText("Contact name") as HTMLInputElement;
    await waitFor(() => expect(contactNameInput.value).toBe("Original Name"));

    // User edits the contact name BEFORE org-timezone fetch resolves
    await userEvent.clear(contactNameInput);
    await userEvent.type(contactNameInput, "Edited Name");
    expect(contactNameInput.value).toBe("Edited Name");

    // Now resolve the org-timezone fetch (simulates the deferred fetch returning Asia/Singapore)
    resolveOrgTz();

    // Wait for the org zone to appear in the zone picker (confirms the seed effect ran)
    await waitFor(() => {
      const readyZonePicker = screen.getByRole("button", { name: /Target Pickup timezone/i });
      expect(readyZonePicker.textContent).toContain("Asia/Singapore");
    }, { timeout: 3000 });

    // The user's edit to contactName must NOT have been wiped by the seed effect re-run
    expect(contactNameInput.value).toBe("Edited Name");
  });

  it("shows the Shipment Dates section with a Target Pickup label", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: draftDetail };
        if (url.includes("/api/clients")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels")) return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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
    expect(await screen.findByText("Shipment Dates")).toBeInTheDocument();
    expect(screen.getByText("Target Pickup")).toBeInTheDocument();
    expect(screen.queryByText(/^Ready Date$/)).not.toBeInTheDocument();
  });

  it("shows company name (not UUID) in client picker trigger when detail.clientId is pre-set", async () => {
    // Query detail that already has a clientId on the server
    const detailWithClient = {
      ...draftDetail,
      clientId: CLIENT_ID,
    };

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("/api/auth/me"))
          return { status: 200, body: { user: { id: "u1", name: "E", email: "e@x", role: "EXECUTIVE" } } };
        if (url.includes("/api/queries/q9")) return { status: 200, body: detailWithClient };
        // Single-client GET for the name lookup: /api/clients/:id (no trailing path segment)
        if (url === `/api/clients/${CLIENT_ID}`) return { status: 200, body: client1 };
        if (url.includes(`/api/clients/${CLIENT_ID}/contacts`)) return { status: 200, body: contacts };
        if (url.includes("/api/clients"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
        if (url.includes("/api/vessels"))
          return { status: 200, body: { items: [], total: 0, page: 1, pageSize: 20 } };
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

    // The client picker trigger should display "Acme Corp", not the raw UUID
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Acme Corp/i })).toBeInTheDocument();
    });
  });
});
