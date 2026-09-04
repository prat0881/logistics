import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { WarehouseFormPage } from "./WarehouseFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

const authMe = { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };

function renderAtRoute(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/masters/warehouses/new" element={<WarehouseFormPage />} />
            <Route path="/masters/warehouses/:id" element={<WarehouseFormPage />} />
            <Route path="/masters/warehouses" element={<p>warehouses list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** `postCalls`, when given, collects every POST /api/warehouses body — for the tests that must
 *  prove Save sent nothing at all, not merely that a message appeared. */
function renderForm(postCalls?: unknown[]) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me")) return authMe;
      if (url.endsWith("/api/warehouses") && init?.method === "POST") {
        postCalls?.push(init.body ? JSON.parse(String(init.body)) : undefined);
        return { status: 201, body: { id: "w9", name: "Owned DC" } };
      }
      return { status: 404 };
    }),
  );
  return renderAtRoute("/masters/warehouses/new");
}

// Adds one PRIMARY contact through ContactsSection's dialog — warehouses require exactly one
// primary contact on create (design decision, same rule as Client/FreightForwarder), so every
// create-mode test that expects Save to actually reach the network needs this.
async function addPrimaryContact(
  name = "Priya Nair",
  email = "priya@example.com",
  phone = "+971501234567",
) {
  await userEvent.click(screen.getByRole("button", { name: /add contact/i }));
  await userEvent.type(screen.getByLabelText(/^name$/i), name);
  await userEvent.type(screen.getByLabelText(/email/i), email);
  await userEvent.type(screen.getByLabelText(/phone/i), phone);
  await userEvent.selectOptions(screen.getByLabelText(/poc level/i), "PRIMARY");
  await userEvent.click(screen.getByRole("button", { name: /save contact/i }));
}

// Adds one vehicle through VehiclesSection's dialog. `tonnage` must be a real TRUCK_TONNAGES
// enum value — the tonnage control is a SelectField, not free text.
async function addVehicle(tonnage = "T_5", quantity = "3") {
  await userEvent.click(screen.getByRole("button", { name: /add vehicle/i }));
  await userEvent.selectOptions(screen.getByLabelText(/tonnage/i), tonnage);
  await userEvent.type(screen.getByLabelText(/quantity/i), quantity);
  await userEvent.click(screen.getByRole("button", { name: /save vehicle/i }));
}

async function fillBaseFields(type: string, name: string) {
  await userEvent.selectOptions(await screen.findByLabelText(/type of warehouse/i), type);
  await userEvent.type(screen.getByLabelText(/warehouse name/i), name);
  await userEvent.type(screen.getByLabelText(/street address/i), "1 Dock Road");
  await userEvent.type(screen.getByLabelText(/^country$/i), "United Arab Emirates");
  await userEvent.type(screen.getByLabelText(/^city$/i), "Dubai");
  await userEvent.type(screen.getByLabelText(/pin ?code/i), "00000");
  await userEvent.type(screen.getByLabelText(/capacity$/i), "500");
}

describe("WarehouseFormPage (create)", () => {
  it("shows agreement and insurance dates only for owned and contracted warehouses", async () => {
    renderForm();
    await screen.findByLabelText(/type of warehouse/i);
    expect(screen.queryByLabelText(/agreement valid until/i)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "OWNED");
    expect(screen.getByLabelText(/agreement valid until/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/insurance valid until/i)).toBeInTheDocument();
  });

  it("reports the missing agreement date rather than silently failing", async () => {
    renderForm();
    // Everything else on the form is filled in and valid, so the only failure is the
    // OWNED/CONTRACTED invariant on the two dates — this proves that invariant message reaches
    // the user, not that the form has unrelated blank-field errors too.
    await fillBaseFields("OWNED", "Owned DC");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => /required for owned and contracted/i.test(a.textContent ?? ""))).toBe(true);
  });

  it("submits a valid owned warehouse and navigates to the list", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.endsWith("/api/warehouses") && init?.method === "POST") {
          body = JSON.parse(init.body as string);
          return { status: 201, body: { id: "w9", name: "Client DC" } };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/warehouses/new");
    await fillBaseFields("CLIENT", "Client DC");
    await addPrimaryContact();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());
    expect(body).toMatchObject({ name: "Client DC", type: "CLIENT" });
  });

  // Mirrors ChargeLineFormPage: before this, onSubmit had no try/catch and there is no toast
  // system anywhere in apps/web, so a rejected save produced NOTHING — the button stopped
  // spinning and the page sat there. The 409 below is the message the API actually returns.
  it("surfaces the server’s error message instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.endsWith("/api/warehouses") && init?.method === "POST")
          return { status: 409, body: { message: "A warehouse with that name already exists" } };
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/warehouses/new");
    await fillBaseFields("CLIENT", "Dubai DC");
    await addPrimaryContact();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    // Still on the form: a refused save must never look like a successful one.
    expect(screen.queryByText("warehouses list")).not.toBeInTheDocument();
  });

  it("saves after a handling rate is entered on OWNED and the type is switched to CLIENT", async () => {
    // Regression test for a real bug found in review, the same mechanism as ChargeLineFormPage's
    // mode-switch bug: ContractAndRatesSection is the ONLY renderer of the handlingUnit error,
    // it unmounts when the type leaves OWNED/CONTRACTED, react-hook-form keeps the entered
    // handlingRate registered, and refineWarehouseInvariants applies "a handling rate needs a
    // unit" for every type. So Save failed validation on a field no longer on screen and did
    // nothing at all — no navigation, no message. Proves the fix: the save goes through, and
    // the cleared rate fields are not in the submitted body.
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.endsWith("/api/warehouses") && init?.method === "POST") {
          body = JSON.parse(init.body as string);
          return { status: 201, body: { id: "w9", name: "Switcher DC" } };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/warehouses/new");
    await fillBaseFields("OWNED", "Switcher DC");
    // A handling rate with no handling unit — invalid while the section is on screen.
    await userEvent.type(screen.getByLabelText(/handling rate/i), "100");
    // Leaving OWNED unmounts the whole Contract & rates section, taking the only renderer of
    // the handlingUnit/rateCurrency errors with it.
    await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "CLIENT");
    expect(screen.queryByLabelText(/handling rate/i)).not.toBeInTheDocument();
    await addPrimaryContact();

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());
    expect(body).toMatchObject({ name: "Switcher DC", type: "CLIENT" });
    expect(body).not.toHaveProperty("handlingRate");
    expect(body).not.toHaveProperty("handlingUnit");
    expect(body).not.toHaveProperty("rateCurrency");
  });

  it("sends warehouse fields, contacts and vehicles in one request", async () => {
    const postBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.endsWith("/api/warehouses") && init?.method === "POST") {
          postBodies.push(JSON.parse(init.body as string));
          return { status: 201, body: { id: "w9", name: "WH One" } };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/warehouses/new");
    await fillBaseFields("CLIENT", "WH One");
    await addPrimaryContact();
    await addVehicle("T_5", "3");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).toMatchObject({
      name: "WH One",
      contacts: [expect.objectContaining({ pocLevel: "PRIMARY" })],
      vehicles: [expect.objectContaining({ tonnage: "T_5", quantity: 3 })],
    });
  });

  it("blocks Save when no contact is marked Primary", async () => {
    // Both halves, like the ClientFormPage sibling: the message appears AND nothing was sent. A
    // message-only assertion would stay green if the block were moved after the network call.
    const postCalls: unknown[] = [];
    renderForm(postCalls);
    await fillBaseFields("CLIENT", "No Primary DC");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/one contact must be marked primary/i);
    expect(postCalls).toHaveLength(0);
  });

  // Regression guard for the existing rate-field clearing effect, which must survive the
  // rewrite: it must only fire on a REAL transition out of OWNED/CONTRACTED (never on the first
  // observed type, or loading an existing record would blank its stored rate card).
  it("clears rate fields when the type leaves OWNED/CONTRACTED", async () => {
    renderForm();
    await userEvent.selectOptions(await screen.findByLabelText(/type of warehouse/i), "OWNED");
    await userEvent.type(screen.getByLabelText(/handling rate/i), "50");
    await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "CLIENT");
    await userEvent.selectOptions(screen.getByLabelText(/type of warehouse/i), "OWNED");
    expect(screen.getByLabelText(/handling rate/i)).toHaveValue(null);
  });

  // Total vehicles is the fleet size, not the number of tonnage rows — the `.length` this
  // replaced reported 2 here, and disagreed with the `totalVehicles` the API derives
  // (WarehousesService.get sums `quantity`). Two rows whose quantities differ from each other
  // AND from the row count, so 5 is reachable only by summing: a row count gives 2, and summing
  // the tonnage codes or taking a max would give neither.
  it("totals vehicles by quantity, not by the number of tonnage rows", async () => {
    renderForm();
    await screen.findByLabelText(/type of warehouse/i);
    await addVehicle("T_5", "3");
    await addVehicle("T_9", "2");
    expect(await screen.findByText(/total vehicles:/i)).toHaveTextContent("Total vehicles: 5");
  });

  it("offers the weekend working fee only once weekend working is ticked", async () => {
    renderForm();
    // The fee lives in Contract & rates, so OWNED is a precondition — this proves the fee is
    // gated on the checkbox specifically, not merely on the section being on screen.
    await userEvent.selectOptions(await screen.findByLabelText(/type of warehouse/i), "OWNED");
    expect(screen.getByLabelText(/handling rate/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/weekend working fee/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/^weekend working$/i));
    expect(screen.getByLabelText(/weekend working fee/i)).toBeInTheDocument();
  });

  it("does not save a weekend working fee after weekend working is un-ticked", async () => {
    // The half that matters is the POST body. react-hook-form keeps an unmounted field's
    // registered value (`shouldUnregister` defaults to false), so hiding the input is not enough
    // — without the clearing effect this body still carries weekendWorkingFee: 250.
    const postBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me")) return authMe;
        if (url.endsWith("/api/warehouses") && init?.method === "POST") {
          postBodies.push(JSON.parse(init.body as string));
          return { status: 201, body: { id: "w9", name: "Weekend DC" } };
        }
        return { status: 404 };
      }),
    );
    renderAtRoute("/masters/warehouses/new");
    await fillBaseFields("OWNED", "Weekend DC");
    await userEvent.type(screen.getByLabelText(/agreement valid until/i), "2027-01-01");
    await userEvent.type(screen.getByLabelText(/insurance valid until/i), "2027-02-01");
    await userEvent.click(screen.getByLabelText(/^weekend working$/i));
    await userEvent.type(screen.getByLabelText(/weekend working fee/i), "250");
    await userEvent.selectOptions(screen.getByLabelText(/rate currency/i), "AED");
    await userEvent.click(screen.getByLabelText(/^weekend working$/i));
    expect(screen.queryByLabelText(/weekend working fee/i)).not.toBeInTheDocument();
    await addPrimaryContact();
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(postBodies).toHaveLength(1));
    expect(postBodies[0]).not.toHaveProperty("weekendWorkingFee");
    expect(postBodies[0]).toMatchObject({ weekendWorking: false });
  });
});

function ownedWarehouseDto(overrides: Record<string, unknown> = {}) {
  return {
    id: "w1",
    name: "Dubai DC",
    type: "OWNED",
    freightForwarderId: null,
    clientId: null,
    streetAddress: "1 Dock Road",
    country: "United Arab Emirates",
    city: "Dubai",
    pinCode: "00000",
    capacity: "500",
    capacityUnit: "CBM",
    capabilities: [],
    agreementValidUntil: "2027-01-01T00:00:00.000Z",
    insuranceValidUntil: "2027-02-01T00:00:00.000Z",
    isBonded: false,
    weekendWorking: false,
    weekendWorkingFee: null,
    workingEmployees: null,
    forkLiftCount: null,
    dipTrayCount: null,
    freeStorageDays: 0,
    rateCurrency: null,
    handlingRate: null,
    handlingUnit: null,
    storageRate: null,
    storageUnit: null,
    status: "ACTIVE",
    contacts: [],
    vehicles: [],
    totalVehicles: 0,
    ...overrides,
  };
}

function renderEditForm(dto: Record<string, unknown>, onPatch: (body: Record<string, unknown>) => void) {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me")) return authMe;
      if (url.endsWith("/api/warehouses/w1") && (!init?.method || init.method === "GET"))
        return { status: 200, body: dto };
      if (url.endsWith("/api/warehouses/w1") && init?.method === "PATCH") {
        onPatch(JSON.parse(init.body as string));
        return { status: 200, body: dto };
      }
      return { status: 404 };
    }),
  );
  return renderAtRoute("/masters/warehouses/w1");
}

describe("WarehouseFormPage (edit)", () => {
  it("shows the stored agreement/insurance dates for an existing OWNED warehouse and saves without a validation error", async () => {
    let body: Record<string, unknown> | undefined;
    renderEditForm(ownedWarehouseDto(), (b) => (body = b));

    expect(await screen.findByLabelText(/agreement valid until/i)).toHaveValue("2027-01-01");
    expect(screen.getByLabelText(/insurance valid until/i)).toHaveValue("2027-02-01");

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(body).toMatchObject({
      agreementValidUntil: "2027-01-01T00:00:00.000Z",
      insuranceValidUntil: "2027-02-01T00:00:00.000Z",
    });
  });

  it("leaves isBonded true in the submitted body when an unrelated field is edited on a bonded warehouse", async () => {
    let body: Record<string, unknown> | undefined;
    renderEditForm(ownedWarehouseDto({ isBonded: true }), (b) => (body = b));

    const nameInput = (await screen.findByDisplayValue("Dubai DC")) as HTMLInputElement;
    await userEvent.type(nameInput, " (renamed)");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());
    expect(body).toMatchObject({ name: "Dubai DC (renamed)", isBonded: true });
  });

  // reset()'s own comment calls the `contacts:`/`vehicles:` mappings "the single most dangerous
  // lines in this effect" — omitting either would leave the draft's array empty, and the API
  // treats "absent from the array" as "delete", so the very next unrelated PATCH would silently
  // delete every contact and vehicle on the record. `ownedWarehouseDto()` alone can't catch a
  // regression here: its `contacts: []`/`vehicles: []` are already empty, so a dropped mapping
  // line would be indistinguishable from correct behaviour. This test loads a warehouse with a
  // REAL contact and a REAL vehicle, edits an unrelated scalar (city), and asserts both survive
  // in the PATCH body — by id, not just by array length, so a mapping that dropped the id and
  // re-created a same-shaped row from scratch would still be caught.
  it("keeps existing contacts and vehicles in the PATCH body when an unrelated field is edited", async () => {
    let body: Record<string, unknown> | undefined;
    renderEditForm(
      ownedWarehouseDto({
        contacts: [
          {
            id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
            name: "Priya Nair",
            designation: null,
            email: "priya@example.com",
            contactNo: "+971501234567",
            whatsappAvailable: false,
            wechatAvailable: false,
            botimAvailable: false,
            pocLevel: "PRIMARY",
            status: "ACTIVE",
          },
        ],
        vehicles: [{ id: "9e0c4c1a-2a3b-4d5e-8f6a-1b2c3d4e5f60", tonnage: "T_5", quantity: 3 }],
        totalVehicles: 3,
      }),
      (b) => (body = b),
    );

    const cityInput = (await screen.findByDisplayValue("Dubai")) as HTMLInputElement;
    await userEvent.type(cityInput, " Updated");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());

    expect(body).toMatchObject({ city: "Dubai Updated" });
    expect(body?.contacts).toMatchObject([
      { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", name: "Priya Nair", pocLevel: "PRIMARY" },
    ]);
    expect(body?.vehicles).toMatchObject([
      { id: "9e0c4c1a-2a3b-4d5e-8f6a-1b2c3d4e5f60", tonnage: "T_5", quantity: 3 },
    ]);
  });

  // State 3 of the three-state primary rule — a record that LOADED with contacts but none
  // marked PRIMARY. It is explicitly permitted to save (a legacy record must never become
  // un-editable, because this screen is the only place to fix it), which is exactly why it is
  // the residual hazard: `loadedWithPrimary` is false, so nothing blocks submission, and a
  // dropped `contacts:` mapping in reset() would PATCH `contacts: []` and have the API silently
  // delete every contact with no test failing. Assert on the contact's id, not a length — a
  // drop-and-recreate passes a length check. This is also the only cover for
  // `showNoPrimaryBanner` on this page.
  it("shows the advisory banner on a loaded warehouse with no primary, and still saves — carrying its contacts", async () => {
    let body: Record<string, unknown> | undefined;
    renderEditForm(
      ownedWarehouseDto({
        contacts: [
          {
            id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
            name: "Priya Nair",
            designation: null,
            email: "priya@example.com",
            contactNo: "+971501234567",
            whatsappAvailable: false,
            wechatAvailable: false,
            botimAvailable: false,
            pocLevel: "NONE",
            status: "ACTIVE",
          },
        ],
      }),
      (b) => (body = b),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(/no primary contact/i);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());
    expect(body?.contacts).toMatchObject([
      { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", name: "Priya Nair", pocLevel: "NONE" },
    ]);
  });

  // The `id` on a dialog-edited row survives only because react-hook-form carries unregistered
  // `defaultValues` through `handleSubmit` (VehicleDialog seeds them from `initial` and never
  // registers `id`) and `warehouseVehicleUpsertSchema` declares `id`. Neither is obvious, and
  // if either changed, every dialog edit would silently become delete-plus-create: a new row
  // id, a lost audit trail, and reconcile deleting the original because it is absent from the
  // payload. The test above only proves an UNTOUCHED vehicle keeps its id.
  it("carries the loaded vehicle's id through a dialog edit and into the PATCH body", async () => {
    let body: Record<string, unknown> | undefined;
    renderEditForm(
      ownedWarehouseDto({
        vehicles: [{ id: "9e0c4c1a-2a3b-4d5e-8f6a-1b2c3d4e5f60", tonnage: "T_5", quantity: 3 }],
        totalVehicles: 3,
      }),
      (b) => (body = b),
    );

    await userEvent.click(await screen.findByRole("button", { name: /5 T/i }));
    const dialog = screen.getByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText(/quantity/i));
    await userEvent.type(within(dialog).getByLabelText(/quantity/i), "7");
    await userEvent.click(within(dialog).getByRole("button", { name: /save vehicle/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());

    expect(body?.vehicles).toMatchObject([
      { id: "9e0c4c1a-2a3b-4d5e-8f6a-1b2c3d4e5f60", tonnage: "T_5", quantity: 7 },
    ]);
  });
});
