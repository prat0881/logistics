import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { WarehouseFormPage } from "./WarehouseFormPage";
import { mockFetch } from "@/test/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

function renderForm() {
  vi.stubGlobal(
    "fetch",
    mockFetch((url, init) => {
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
      if (url.endsWith("/api/warehouses") && init?.method === "POST") {
        return { status: 201, body: { id: "w9", name: "Owned DC" } };
      }
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/masters/warehouses/new"]}>
          <Routes>
            <Route path="/masters/warehouses/new" element={<WarehouseFormPage />} />
            <Route path="/masters/warehouses" element={<p>warehouses list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
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
    await userEvent.selectOptions(await screen.findByLabelText(/type of warehouse/i), "OWNED");
    await userEvent.type(screen.getByLabelText(/warehouse name/i), "Owned DC");
    await userEvent.type(screen.getByLabelText(/street address/i), "1 Dock Road");
    await userEvent.type(screen.getByLabelText(/^country$/i), "United Arab Emirates");
    await userEvent.type(screen.getByLabelText(/^city$/i), "Dubai");
    await userEvent.type(screen.getByLabelText(/pin ?code/i), "00000");
    await userEvent.type(screen.getByLabelText(/capacity$/i), "500");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => /required for owned and contracted/i.test(a.textContent ?? ""))).toBe(true);
  });

  it("submits a valid owned warehouse and navigates to the list", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      mockFetch((url, init) => {
        if (url.endsWith("/api/auth/me"))
          return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
        if (url.endsWith("/api/warehouses") && init?.method === "POST") {
          body = JSON.parse(init.body as string);
          return { status: 201, body: { id: "w9", name: "Owned DC" } };
        }
        return { status: 404 };
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={["/masters/warehouses/new"]}>
            <Routes>
              <Route path="/masters/warehouses/new" element={<WarehouseFormPage />} />
              <Route path="/masters/warehouses" element={<p>warehouses list</p>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.selectOptions(await screen.findByLabelText(/type of warehouse/i), "CLIENT");
    await userEvent.type(screen.getByLabelText(/warehouse name/i), "Client DC");
    await userEvent.type(screen.getByLabelText(/street address/i), "1 Dock Road");
    await userEvent.type(screen.getByLabelText(/^country$/i), "United Arab Emirates");
    await userEvent.type(screen.getByLabelText(/^city$/i), "Dubai");
    await userEvent.type(screen.getByLabelText(/pin ?code/i), "00000");
    await userEvent.type(screen.getByLabelText(/capacity$/i), "500");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("warehouses list")).toBeInTheDocument());
    expect(body).toMatchObject({ name: "Client DC", type: "CLIENT" });
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
      if (url.endsWith("/api/auth/me"))
        return { status: 200, body: { user: { id: "1", name: "T", email: "t@x.com", role: "MANAGER" } } };
      if (url.endsWith("/api/warehouses/w1") && (!init?.method || init.method === "GET"))
        return { status: 200, body: dto };
      if (url.endsWith("/api/warehouses/w1") && init?.method === "PATCH") {
        onPatch(JSON.parse(init.body as string));
        return { status: 200, body: dto };
      }
      if (url.endsWith("/api/warehouses/w1/contacts")) return { status: 200, body: [] };
      return { status: 404 };
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={["/masters/warehouses/w1"]}>
          <Routes>
            <Route path="/masters/warehouses/:id" element={<WarehouseFormPage />} />
            <Route path="/masters/warehouses" element={<p>warehouses list</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
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
});
