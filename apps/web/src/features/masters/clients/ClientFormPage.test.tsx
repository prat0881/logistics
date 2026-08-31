import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ClientFormPage } from "./ClientFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const authMe = { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
// WarehousePicker now queries the unassigned pool unconditionally (Task 8 dropped the ownerId
// gate, since a brand-new record can assign warehouses before it exists) — every test renders
// through it, so every handler below needs a branch for it.
const emptyUnassignedWarehouses = { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };

function renderAtRoute(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/masters/clients/new" element={<ClientFormPage />} />
            <Route path="/masters/clients/:id" element={<ClientFormPage />} />
            <Route path="/masters/clients" element={<p>clients list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function fillParentFields(companyName: string) {
  await userEvent.type(await screen.findByLabelText(/company name/i), companyName);
  await userEvent.type(screen.getByLabelText(/country/i), "IN");
  await userEvent.type(screen.getByLabelText(/street address/i), "1 Test Road");
  await userEvent.type(screen.getByLabelText(/city/i), "Test City");
}

async function addContactViaDialog({
  name,
  email,
  phone,
  primary,
}: {
  name: string;
  email: string;
  phone: string;
  primary: boolean;
}) {
  await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
  await userEvent.type(screen.getByLabelText(/^name$/i), name);
  await userEvent.type(screen.getByLabelText(/email/i), email);
  await userEvent.type(screen.getByLabelText(/phone/i), phone);
  if (primary) await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "PRIMARY");
  await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
}

describe("ClientFormPage (create)", () => {
  it("sends parent fields and contacts in ONE request", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients") && init?.method === "POST") {
          bodies.push(JSON.parse(String(init.body)));
          return {
            status: 201,
            body: { id: "c9", clientCode: "CL-0009", companyName: "NewCo", country: "IN", status: "ACTIVE" },
          };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    await fillParentFields("NewCo");
    await addContactViaDialog({ name: "Asha Menon", email: "asha@example.com", phone: "+971501234567", primary: true });
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      companyName: "NewCo",
      contacts: [expect.objectContaining({ name: "Asha Menon", pocLevel: "PRIMARY" })],
    });
  });

  it("blocks Save when no contact is marked Primary", async () => {
    const postCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients") && init?.method === "POST") {
          postCalls.push(1);
          return { status: 201, body: {} };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    await fillParentFields("NewCo");
    await addContactViaDialog({ name: "No Primary Person", email: "np@example.com", phone: "+971501112222", primary: false });
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/one contact must be marked primary/i);
    expect(postCalls).toHaveLength(0);
  });

  it("renders the Status field the schema has always carried", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    expect(await screen.findByLabelText(/status/i)).toBeInTheDocument();
  });
});

describe("ClientFormPage save failure", () => {
  // Mirrors ChargeLineFormPage: before this, onSubmit had no try/catch and there is no toast
  // system anywhere in apps/web, so a rejected save produced NOTHING — the button stopped
  // spinning and the page sat there. The 409 below is the message the API actually returns.
  // A primary contact must be added first: create-mode now blocks the network call entirely
  // when no contact is marked Primary, so reaching the server's 409 requires a valid draft.
  it("surfaces the server's error message instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/clients") && init?.method === "POST")
          return { status: 409, body: { message: "A client with that company name already exists" } };
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/clients/new");
    await fillParentFields("Dupe Co");
    await addContactViaDialog({ name: "Asha Menon", email: "asha@example.com", phone: "+971501234567", primary: true });
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    // Still on the form: a refused save must never look like a successful one.
    expect(screen.queryByText("clients list")).not.toBeInTheDocument();
  });
});

describe("ClientFormPage (edit)", () => {
  function mockLegacyClient({
    id,
    pocLevel,
    patchCalls,
  }: {
    id: string;
    pocLevel: "NONE" | "PRIMARY";
    patchCalls: unknown[];
  }) {
    return mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me")) return authMe;
      if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
      if (url.endsWith(`/api/clients/${id}/warehouses`)) return { status: 200, body: [] };
      if (url.endsWith(`/api/clients/${id}`)) {
        if (init?.method === "PATCH") {
          patchCalls.push(JSON.parse(String(init.body)));
          return { status: 200, body: {} };
        }
        return {
          status: 200,
          body: {
            id,
            clientCode: "CL-0001",
            companyName: "Legacy Co",
            industry: null,
            country: "IN",
            streetAddress: "1 Old Rd",
            city: "Old City",
            postalCode: null,
            status: "ACTIVE",
            contacts: [
              {
                id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
                name: "Asha Menon",
                designation: null,
                email: "asha@example.com",
                contactNo: "+971501234567",
                whatsappAvailable: false,
                wechatAvailable: false,
                botimAvailable: false,
                pocLevel,
                status: "ACTIVE",
              },
            ],
          },
        };
      }
      return { status: 404 };
    });
  }

  it("shows the advisory banner on a loaded client with no primary, and still saves", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal("fetch", mockLegacyClient({ id: "c1", pocLevel: "NONE", patchCalls }));
    renderAtRoute("/masters/clients/c1");

    expect(await screen.findByRole("status")).toHaveTextContent(/no primary contact/i);
    // Save without touching anything — an unrelated field edit isn't even needed to expose the
    // hazard: if the load effect failed to map `contacts` in, this PATCH would carry an empty
    // array and the API (which treats "absent from the array" as "delete") would wipe the
    // client's one legacy contact on the very first save.
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0]).toMatchObject({
      contacts: [expect.objectContaining({ name: "Asha Menon", pocLevel: "NONE" })],
    });
  });

  // The third state of the §4.4 rule, and the one the two tests above don't cover: the record
  // LOADED with a primary and the user is demoting it away. That must block, even though a
  // record that loaded WITHOUT one saves freely.
  it("blocks Save when the user demotes away the primary the record loaded with", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal("fetch", mockLegacyClient({ id: "c2", pocLevel: "PRIMARY", patchCalls }));
    renderAtRoute("/masters/clients/c2");

    await userEvent.click(await screen.findByRole("button", { name: /asha menon/i }));
    await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "SECONDARY");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/one contact must be marked primary/i);
    expect(patchCalls).toHaveLength(0);
  });
});
