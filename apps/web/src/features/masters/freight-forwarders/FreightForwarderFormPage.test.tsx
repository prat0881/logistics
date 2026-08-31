import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { FreightForwarderFormPage } from "./FreightForwarderFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const authMe = { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
// WarehousePicker queries the unassigned pool unconditionally (Task 8 dropped the ownerId gate,
// since a brand-new record can assign warehouses before it exists) — every test renders through
// it, so every handler below needs a branch for it.
const emptyUnassignedWarehouses = { status: 200, body: { items: [], total: 0, page: 1, pageSize: 100 } };

function renderAtRoute(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/masters/freight-forwarders/new" element={<FreightForwarderFormPage />} />
            <Route path="/masters/freight-forwarders/:id" element={<FreightForwarderFormPage />} />
            <Route path="/masters/freight-forwarders" element={<p>ff list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function selectCountryAndMode() {
  await userEvent.click(screen.getByRole("button", { name: /countries/i }));
  await userEvent.click(await screen.findByText("Singapore"));
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: /^modes$/i }));
  await userEvent.click(await screen.findByText("AIR"));
  await userEvent.keyboard("{Escape}");
}

describe("FreightForwarderFormPage (create)", () => {
  it("blocks submit and shows an error when required fields are missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST") {
          calls.push("create");
          return { status: 201, body: {} };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/new");
    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/select at least one mode/i)).toBeInTheDocument();
    expect(calls).not.toContain("create");
  });

  it("submits a valid FF and navigates to the list", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST") {
          calls.push("create");
          return { status: 201, body: { id: "f9", freightForwarderCode: "FF-0009" } };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/new");
    await userEvent.type(await screen.findByLabelText(/company name/i), "Acme Freight");
    await userEvent.type(screen.getByLabelText(/street address/i), "1 Cargo Way");
    await userEvent.type(screen.getByLabelText(/^city$/i), "Singapore");
    await userEvent.type(screen.getByLabelText(/^country$/i), "Singapore");
    await userEvent.type(screen.getByLabelText(/person in charge/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+15551234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ops@acme.example");
    await selectCountryAndMode();
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText("ff list")).toBeInTheDocument());
    expect(calls).toContain("create");
  });

  it("relabels address to Street Address and submits city/postal/country", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST") {
          body = JSON.parse(init.body as string);
          return { status: 201, body: { id: "f9", freightForwarderCode: "FF-0009" } };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/new");
    expect(await screen.findByLabelText(/street address/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/company address/i)).not.toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText(/company name/i), "Acme Freight");
    await userEvent.type(screen.getByLabelText(/street address/i), "1 Cargo Way");
    await userEvent.type(screen.getByLabelText(/person in charge/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+15551234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ops@acme.example");
    await userEvent.type(screen.getByLabelText(/^city$/i), "Singapore");
    await userEvent.type(screen.getByLabelText(/postal code/i), "049145");
    await userEvent.type(screen.getByLabelText(/^country$/i), "Singapore");
    await selectCountryAndMode();
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText("ff list")).toBeInTheDocument());
    expect(body).toMatchObject({ city: "Singapore", postalCode: "049145", country: "Singapore" });
  });

  // Mirrors ChargeLineFormPage: before this, onSubmit had no try/catch and there is no toast
  // system anywhere in apps/web, so a rejected save produced NOTHING — the button stopped
  // spinning and the page sat there. The 409 below is the message the API actually returns.
  it("surfaces the server’s error message instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST")
          return {
            status: 409,
            body: { message: "A freight forwarder with that company name already exists" },
          };
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/new");
    await userEvent.type(await screen.findByLabelText(/company name/i), "Acme Freight");
    await userEvent.type(screen.getByLabelText(/street address/i), "1 Cargo Way");
    await userEvent.type(screen.getByLabelText(/^city$/i), "Singapore");
    await userEvent.type(screen.getByLabelText(/^country$/i), "Singapore");
    await userEvent.type(screen.getByLabelText(/person in charge/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+15551234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ops@acme.example");
    await selectCountryAndMode();
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    // Still on the form: a refused save must never look like a successful one.
    expect(screen.queryByText("ff list")).not.toBeInTheDocument();
  });

  // The mirror: the three "own" columns are also the source of the primary contact the API
  // seeds on create, so the Contacts table should reflect them live instead of making the user
  // type the same person twice.
  it("mirrors pic/contactNumber/email into a PRIMARY row while creating", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/new");
    await userEvent.type(await screen.findByLabelText(/person in charge/i), "Ravi K");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+971501234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ravi@ff.com");

    const table = screen.getByRole("table", { name: /contacts/i });
    expect(within(table).getByText("Ravi K")).toBeInTheDocument();
    expect(within(table).getByText("PRIMARY")).toBeInTheDocument();
  });

  // Without this, the mirror was prepended unconditionally: a brand-new /new page rendered one
  // PRIMARY row with an empty name/email/phone before the user had typed anything, and
  // ContactsSection's own empty state could never appear in create mode.
  it("shows no ghost PRIMARY row before any of pic/contactNumber/email is filled", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/new");
    await screen.findByLabelText(/person in charge/i);

    expect(screen.queryByText("PRIMARY")).not.toBeInTheDocument();
    expect(screen.getByText(/no contacts yet/i)).toBeInTheDocument();
  });

  it("does not let a second contact be made primary while the mirror holds it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/new");
    await userEvent.type(await screen.findByLabelText(/person in charge/i), "Ravi K");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+971501234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ravi@ff.com");

    // add a contact, choose PRIMARY, save contact — scoped to the dialog, since the page
    // itself also has an "Email" field (the mirror source) that would otherwise ambiguously
    // match the same label text.
    await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^name$/i), "Second Person");
    await userEvent.type(within(dialog).getByLabelText(/email/i), "second@ff.com");
    await userEvent.type(within(dialog).getByLabelText(/phone/i), "+971509998888");
    await userEvent.selectOptions(within(dialog).getByLabelText(/poc level/i), "PRIMARY");
    await userEvent.click(within(dialog).getByRole("button", { name: /save contact/i }));

    const rows = screen.getAllByRole("row").slice(1); // drop the header row
    const primaries = rows.filter((r) => within(r).queryByText("PRIMARY"));
    expect(primaries).toHaveLength(1);
    expect(within(primaries[0]).getByText(/ravi k/i)).toBeInTheDocument();
  });

  // The plan correction: an explicit `contacts: []` has zero primaries and is rejected with a
  // 400 by freightForwarderCreateSchema's exactlyOnePrimary refine. The mirrored array always
  // carries exactly the one synthetic PRIMARY row, so it must go out over the wire as such —
  // never dropped, never emptied.
  it("sends the full mirrored contacts array on create, never an empty array", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/freight-forwarders") && init?.method === "POST") {
          body = JSON.parse(init.body as string);
          return { status: 201, body: { id: "f9", freightForwarderCode: "FF-0009" } };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/new");
    await userEvent.type(await screen.findByLabelText(/company name/i), "Acme Freight");
    await userEvent.type(screen.getByLabelText(/street address/i), "1 Cargo Way");
    await userEvent.type(screen.getByLabelText(/^city$/i), "Singapore");
    await userEvent.type(screen.getByLabelText(/^country$/i), "Singapore");
    await userEvent.type(screen.getByLabelText(/person in charge/i), "Jane Doe");
    await userEvent.type(screen.getByLabelText(/contact number/i), "+15551234567");
    await userEvent.type(screen.getByLabelText(/^email$/i), "ops@acme.example");
    await selectCountryAndMode();
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText("ff list")).toBeInTheDocument());

    expect(body?.contacts).not.toEqual([]);
    expect(body?.contacts).toMatchObject([
      { name: "Jane Doe", email: "ops@acme.example", contactNo: "+15551234567", pocLevel: "PRIMARY" },
    ]);
  });
});

describe("FreightForwarderFormPage (edit)", () => {
  function mockLoadedForwarder({
    id,
    contacts,
    patchCalls,
    assignedWarehouses = [],
  }: {
    id: string;
    contacts: { id: string; name: string; email: string; contactNo: string; pocLevel: "NONE" | "PRIMARY" }[];
    patchCalls: unknown[];
    assignedWarehouses?: { id: string; name: string }[];
  }) {
    return mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me")) return authMe;
      if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
      if (url.endsWith(`/api/freight-forwarders/${id}/warehouses`)) return { status: 200, body: assignedWarehouses };
      if (url.endsWith(`/api/freight-forwarders/${id}/contacts`)) {
        return {
          status: 200,
          body: contacts.map((c) => ({
            id: c.id,
            name: c.name,
            designation: null,
            email: c.email,
            contactNo: c.contactNo,
            whatsappAvailable: false,
            wechatAvailable: false,
            botimAvailable: false,
            pocLevel: c.pocLevel,
            status: "ACTIVE",
          })),
        };
      }
      if (url.endsWith(`/api/freight-forwarders/${id}`)) {
        if (init?.method === "PATCH") {
          patchCalls.push(JSON.parse(String(init.body)));
          return { status: 200, body: {} };
        }
        return {
          status: 200,
          body: {
            id,
            freightForwarderCode: "FF-0001",
            companyName: "Legacy Forwarders Co",
            companyAddress: "1 Old Rd",
            city: "Old City",
            postalCode: null,
            country: "Singapore",
            pic: contacts[0]?.name ?? "",
            contactNumber: contacts[0]?.contactNo ?? "",
            email: contacts[0]?.email ?? "",
            availableCountries: ["SG"],
            modes: ["AIR"],
            handleDg: false,
            vatTrnEori: null,
            whLocation: null,
            defaultCurrency: null,
            paymentTerms: null,
            typicalLeadTime: null,
            status: "ACTIVE",
          },
        };
      }
      return { status: 404 };
    });
  }

  it("keeps pic/contactNumber/email disabled on an existing record", async () => {
    vi.stubGlobal(
      "fetch",
      mockLoadedForwarder({
        id: "f1",
        contacts: [
          { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", name: "Asha Menon", email: "asha@example.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
        ],
        patchCalls: [],
      }),
    );
    renderAtRoute("/masters/freight-forwarders/f1");

    expect(await screen.findByLabelText(/person in charge/i)).toBeDisabled();
    expect(screen.getByLabelText(/contact number/i)).toBeDisabled();
    expect(screen.getByLabelText(/^email$/i)).toBeDisabled();
  });

  it("sends one PATCH carrying both parent fields and contacts", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockLoadedForwarder({
        id: "f2",
        contacts: [
          { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", name: "Asha Menon", email: "asha@example.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
        ],
        patchCalls,
      }),
    );
    renderAtRoute("/masters/freight-forwarders/f2");

    // ...edit a contact through the dialog, click Save...
    await userEvent.click(await screen.findByRole("button", { name: /asha menon/i }));
    await userEvent.clear(screen.getByLabelText(/^name$/i));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Asha M. Menon");
    await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0]).toHaveProperty("contacts");
    expect(patchCalls[0]).toMatchObject({
      companyName: "Legacy Forwarders Co",
      contacts: [expect.objectContaining({ name: "Asha M. Menon", pocLevel: "PRIMARY" })],
    });
  });

  it("shows the advisory banner on a loaded forwarder with no primary, and still saves", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockLoadedForwarder({
        id: "f3",
        contacts: [
          { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", name: "Legacy Contact", email: "legacy@example.com", contactNo: "+971501112222", pocLevel: "NONE" },
        ],
        patchCalls,
      }),
    );
    renderAtRoute("/masters/freight-forwarders/f3");

    expect(await screen.findByRole("status")).toHaveTextContent(/no primary contact/i);
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patchCalls).toHaveLength(1));
  });

  // The third state of the three-state rule, and the one the state-3 test above can't cover:
  // the record LOADED with a primary and the user is demoting it away. That must block, even
  // though a record that loaded WITHOUT one saves freely. Critically, this pins
  // `loadedWithPrimary` to the SERVER's loaded contacts (contactsQuery.data) rather than the
  // live draft — regressing that sourcing to read the draft instead would leave every other
  // test in this file green, since the state-3 test's draft also ends up with zero primaries.
  it("blocks Save when the user demotes away the primary the record loaded with", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockLoadedForwarder({
        id: "f7",
        contacts: [
          { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", name: "Asha Menon", email: "asha@example.com", contactNo: "+971501234567", pocLevel: "PRIMARY" },
        ],
        patchCalls,
      }),
    );
    renderAtRoute("/masters/freight-forwarders/f7");

    await userEvent.click(await screen.findByRole("button", { name: /asha menon/i }));
    const dialog = screen.getByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText(/poc level/i), "SECONDARY");
    await userEvent.click(within(dialog).getByRole("button", { name: /save contact/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/one contact must be marked primary/i);
    expect(patchCalls).toHaveLength(0);
  });

  // The two-query split this page needs (FreightForwarderDto doesn't embed contacts, unlike
  // ClientDto — see useFreightForwarderContacts) opens a data-loss window ClientFormPage never
  // had: if GET /:id/contacts fails (or is simply still loading) while GET /:id has already
  // resolved, the rest of the form is fully valid and nothing before this guard stops Save. The
  // load effect's `contacts: (contactsQuery.data ?? []).map(...)` would then reset the draft to
  // an empty array, and the API (freight-forwarders.service.ts: `if (contacts)` — `Boolean([])`
  // is `true`) treats a present empty array as "delete every contact", not "leave unchanged".
  it("blocks Save (sends no PATCH) when the contacts fetch has failed", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/freight-forwarders/f8/warehouses")) return { status: 200, body: [] };
        if (url.endsWith("/api/freight-forwarders/f8/contacts")) return { status: 500, body: { message: "boom" } };
        if (url.endsWith("/api/freight-forwarders/f8")) {
          if (init?.method === "PATCH") {
            patchCalls.push(JSON.parse(String(init.body)));
            return { status: 200, body: {} };
          }
          return {
            status: 200,
            body: {
              id: "f8",
              freightForwarderCode: "FF-0008",
              companyName: "Stale Contacts Co",
              companyAddress: "1 Old Rd",
              city: "Old City",
              postalCode: null,
              country: "Singapore",
              pic: "Someone",
              contactNumber: "+971501234567",
              email: "someone@ff.com",
              availableCountries: ["SG"],
              modes: ["AIR"],
              handleDg: false,
              vatTrnEori: null,
              whLocation: null,
              defaultCurrency: null,
              paymentTerms: null,
              typicalLeadTime: null,
              status: "ACTIVE",
            },
          };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/f8");

    // The parent record is fully loaded and valid — nothing about it blocks Save. Only the
    // failed contacts fetch should.
    await screen.findByLabelText(/company name/i);
    await waitFor(() => expect(screen.getByLabelText(/company name/i)).toHaveValue("Stale Contacts Co"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/contacts/i);
    expect(patchCalls).toHaveLength(0);
  });

  // Nothing in this page renders `errors.contacts` — ContactsSection is Controller-driven, not
  // a Field. Before the onInvalid handler existed (see ClientFormPage), a loaded contact that
  // failed validation made zodResolver reject the whole submit and RHF never called the submit
  // handler at all — Save just... stopped spinning. Silently. On exactly the legacy record
  // whose only repair surface is this screen.
  it("surfaces a visible error when a loaded contact fails validation, instead of doing nothing", async () => {
    const patchCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.startsWith("/api/warehouses?unassigned=true")) return emptyUnassignedWarehouses;
        if (url.endsWith("/api/freight-forwarders/f4/warehouses")) return { status: 200, body: [] };
        if (url.endsWith("/api/freight-forwarders/f4/contacts")) {
          return {
            status: 200,
            body: [
              {
                id: "9e0c4c1a-2a3b-4d5e-8f6a-1b2c3d4e5f60",
                name: "Bad Phone Contact",
                designation: null,
                email: "legacy@example.com",
                // Missing the leading "+" — predates the E.164 tightening, fails
                // contactUpsertSchema's regex on load.
                contactNo: "971501234567",
                whatsappAvailable: false,
                wechatAvailable: false,
                botimAvailable: false,
                pocLevel: "PRIMARY",
                status: "ACTIVE",
              },
            ],
          };
        }
        if (url.endsWith("/api/freight-forwarders/f4")) {
          if (init?.method === "PATCH") {
            patchCalls.push(1);
            return { status: 200, body: {} };
          }
          return {
            status: 200,
            body: {
              id: "f4",
              freightForwarderCode: "FF-0004",
              companyName: "Bad Phone Co",
              companyAddress: "4 Old Rd",
              city: "Old City",
              postalCode: null,
              country: "Singapore",
              pic: "Bad Phone Contact",
              contactNumber: "971501234567",
              email: "legacy@example.com",
              availableCountries: ["SG"],
              modes: ["AIR"],
              handleDg: false,
              vatTrnEori: null,
              whLocation: null,
              defaultCurrency: null,
              paymentTerms: null,
              typicalLeadTime: null,
              status: "ACTIVE",
            },
          };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/freight-forwarders/f4");

    await userEvent.click(await screen.findByRole("button", { name: /^save$/i }));

    // Two alerts legitimately coexist here: the field-level "Phone must be E.164" under the
    // (disabled, mirrored) contactNumber input, AND the onInvalidSubmit-produced page-level
    // alert this test exists to prove. Assert on the latter specifically rather than
    // `findByRole("alert")`, which would throw "multiple elements found" given both.
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => /bad phone contact/i.test(a.textContent ?? ""))).toBe(true);
    expect(patchCalls).toHaveLength(0);
  });
});
