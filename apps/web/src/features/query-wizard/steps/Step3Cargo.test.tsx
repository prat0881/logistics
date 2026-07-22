import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { QueryWizardPage } from "../QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const QUERY_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CARGO_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const baseDetail = {
  id: QUERY_ID,
  queryCode: "YAL26-0099",
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

const cargoRowDto = {
  id: CARGO_ID,
  rowIndex: 0,
  poReference: "PO-001",
  productName: "Widget A",
  referenceTags: [],
  hsCode: null,
  packageType: "Carton",
  isDangerous: false,
  msdsFileId: null,
  qty: 10,
  dimL: "100",
  dimW: "50",
  dimH: "50",
  netWt: "50",
  grossWt: "60",
  volumeCbm: "2.5000",
  freightDensity: null,
  chargeableWeight: null,
};

const detailWithCargo = { ...baseDetail, cargo: [cargoRowDto] };

/** Navigate to Step 3 (Cargo) in the wizard */
async function navigateToStep3() {
  await screen.findByText("YAL26-0099");
  const cargoTab = screen.getByRole("button", { name: /cargo/i });
  await userEvent.click(cargoTab);
}

describe("Step3Cargo", () => {
  it("opens the Add-cargo dialog with Save + Cancel", async () => {
    const user = userEvent.setup();

    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      if (url === `/api/queries/${QUERY_ID}`)
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(baseDetail),
          text: () => Promise.resolve(JSON.stringify(baseDetail)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=2` },
    );

    await navigateToStep3();

    await user.click(screen.getByRole("button", { name: /add row/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
  });

  it("adds a cargo row: POSTs with poReference + grossWt + dims then shows the row in the table", async () => {
    const user = userEvent.setup();

    // After POST, the query GET should return the updated detail with cargo
    let callCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);

      if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET")) {
        callCount++;
        // First load: no cargo. After POST invalidation: with cargo
        const body = callCount > 1 ? detailWithCargo : baseDetail;
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      }

      if (url === `/api/queries/${QUERY_ID}/cargo` && init?.method === "POST")
        return Promise.resolve({
          ok: true, status: 201,
          json: () => Promise.resolve(cargoRowDto),
          text: () => Promise.resolve(JSON.stringify(cargoRowDto)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);

      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=2` },
    );

    await navigateToStep3();

    // Click "+ Add Row" button to open the add form
    const addRowBtn = await screen.findByRole("button", { name: /add row/i });
    await user.click(addRowBtn);

    // Fill in required fields
    const poInput = await screen.findByPlaceholderText(/PO-001/);
    await user.type(poInput, "PO-001");

    const productInput = screen.getByPlaceholderText(/product name/i);
    await user.type(productInput, "Widget A");

    const pkgInput = screen.getByPlaceholderText(/carton/i);
    await user.type(pkgInput, "Carton");

    // Fill numeric fields
    const qtyInput = await screen.findByPlaceholderText("1");
    await user.type(qtyInput, "10");

    const lInput = screen.getByPlaceholderText("100");
    await user.type(lInput, "100");

    // W and H both have placeholder "50" — use getAllByPlaceholderText
    const fiftyInputs = screen.getAllByPlaceholderText("50");
    await user.type(fiftyInputs[0], "50");
    await user.type(fiftyInputs[1], "50");

    const grossWtInput = screen.getByPlaceholderText("60");
    await user.type(grossWtInput, "60");

    // Submit — the dialog's form submit button is "Save"
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^save$/i }));

    // Verify POST was called with required fields
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo` && (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.poReference).toBe("PO-001");
      expect(body.grossWt).toBe(60);
      expect(body.dimL).toBe(100);
      expect(body.dimW).toBe(50);
      expect(body.dimH).toBe(50);
    });

    // The row should now appear in the table after cache invalidation + refetch
    await waitFor(() => {
      expect(screen.getByText("PO-001")).toBeInTheDocument();
    });
  });

  it("ticking DG on a saved row's edit form reveals the MSDS file input", async () => {
    const user = userEvent.setup();

    const dgCargoRow = { ...cargoRowDto, isDangerous: false };
    const detailWithDgCargo = { ...baseDetail, cargo: [dgCargoRow] };

    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      if (url === `/api/queries/${QUERY_ID}`)
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(detailWithDgCargo),
          text: () => Promise.resolve(JSON.stringify(detailWithDgCargo)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=2` },
    );

    await navigateToStep3();

    // Wait for the cargo table row to appear
    await screen.findByText("PO-001");

    // Click Edit on the row
    const editBtn = screen.getByRole("button", { name: /edit/i });
    await user.click(editBtn);

    // DG checkbox should not be checked initially
    const dgCheckboxes = screen.getAllByRole("checkbox");
    const dgCheckbox = dgCheckboxes.find((cb) => {
      const label = cb.closest("div")?.querySelector("label");
      return label?.textContent?.includes("Dangerous");
    });
    expect(dgCheckbox).toBeTruthy();

    // MSDS input should not be visible yet
    expect(screen.queryByLabelText(/upload msds/i)).toBeNull();

    // Tick the DG checkbox
    await user.click(dgCheckbox!);

    // MSDS file input should now be visible
    await waitFor(() => {
      expect(screen.getByLabelText(/upload msds/i)).toBeInTheDocument();
    });
  });

  it("clicking Export triggers the blob download flow (POST + createObjectURL + <a>.click)", async () => {
    const user = userEvent.setup();

    const fakeBlob = new Blob(["xlsx"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const fakeObjectUrl = "blob:http://localhost/export-uuid";

    const createObjectURLMock = vi.fn(() => fakeObjectUrl);
    const revokeObjectURLMock = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectURLMock,
      revokeObjectURL: revokeObjectURLMock,
    });

    const clickMock = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        const el = origCreate("a");
        el.click = clickMock;
        return el;
      }
      return origCreate(tag);
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      if (url === `/api/queries/${QUERY_ID}`)
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(baseDetail),
          text: () => Promise.resolve(JSON.stringify(baseDetail)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      if (url === `/api/queries/${QUERY_ID}/cargo/export` && init?.method === "POST")
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(fakeBlob),
        } as Response);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=2` },
    );

    await navigateToStep3();

    // Click Export
    const exportBtn = await screen.findByRole("button", { name: /export to excel/i });
    await user.click(exportBtn);

    // Assert export POST was made
    await waitFor(() => {
      const exportCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo/export` && (init as RequestInit)?.method === "POST",
      );
      expect(exportCall).toBeTruthy();
    });

    // Assert createObjectURL was called and click triggered
    await waitFor(() => {
      expect(createObjectURLMock).toHaveBeenCalledWith(fakeBlob);
      expect(clickMock).toHaveBeenCalled();
      expect(revokeObjectURLMock).toHaveBeenCalledWith(fakeObjectUrl);
    });
  });

  it("removes a cargo row: DELETEs /cargo/:cid after confirmation", async () => {
    const user = userEvent.setup();

    // Stub window.confirm to always return true
    vi.stubGlobal("confirm", vi.fn(() => true));

    let callCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/auth/me"))
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } }),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET")) {
        callCount++;
        const body = callCount > 1 ? baseDetail : detailWithCargo;
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      }
      if (url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}` && init?.method === "DELETE")
        return Promise.resolve({
          ok: true, status: 204,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <Routes>
        <Route path="/queries/:id" element={<QueryWizardPage />} />
      </Routes>,
      { route: `/queries/${QUERY_ID}?step=2` },
    );

    await navigateToStep3();

    // Wait for cargo row to appear
    await screen.findByText("PO-001");

    // Click the remove button
    const removeBtn = screen.getByRole("button", { name: /remove/i });
    await user.click(removeBtn);

    // Verify DELETE was called
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });
});
