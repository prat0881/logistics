import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import type { CargoDto } from "@svyft/shared";
import { QueryWizardPage } from "../QueryWizardPage";
import { renderWithProviders } from "@/test/renderWithProviders";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const QUERY_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CARGO_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const PACKAGE_ID_1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const PACKAGE_ID_2 = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const ITEM_ID_1 = "11111111-1111-1111-1111-111111111111";

// Every QueryDetail field the wizard shell / other steps touch on mount, so the page
// renders without unrelated crashes. `cargos` (not `cargo` — the API's actual key,
// see shapeQuery in queries.service.ts) is overridden per-test via renderStep3().
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
  cargos: [] as CargoDto[],
  checklist: [],
  files: [],
  points: [],
  legs: [],
  freightMode: [],
  origin: [],
  destination: [],
};

/** One Cargo ("PO-1", CM/KG) with two packages: P-1 (one item, "Deck paint" x8) and P-2 (no items). */
function oneCargoWithTwoPackages(): CargoDto {
  return {
    id: CARGO_ID,
    rowIndex: 0,
    poReference: "PO-1",
    label: null,
    dimUnit: "CM",
    weightUnit: "KG",
    packages: [
      {
        id: PACKAGE_ID_1,
        rowIndex: 0,
        packageNo: "P-1",
        packageType: "CARTON",
        dimL: "100",
        dimW: "50",
        dimH: "50",
        grossWt: "60",
        netWt: "50",
        volumeCbm: "0.2500",
        tags: [],
        effectiveTags: [],
        msdsFileId: null,
        items: [
          {
            id: ITEM_ID_1,
            rowIndex: 0,
            product: "Deck paint",
            qty: "8",
            uom: "PC",
            hsCode: null,
            tags: [],
          },
        ],
      },
      {
        id: PACKAGE_ID_2,
        rowIndex: 1,
        packageNo: "P-2",
        packageType: "PALLET",
        dimL: "80",
        dimW: "40",
        dimH: "40",
        grossWt: "30",
        netWt: "25",
        volumeCbm: "0.1280",
        tags: [],
        effectiveTags: [],
        msdsFileId: null,
        items: [],
      },
    ],
    packageCount: 2,
    grossWeightKg: "90",
    volumeCbm: "0.3780",
    tags: [],
    chargeableWeight: null,
  };
}

/**
 * One Cargo ("PO-2", MM/GM — deliberately NON-canonical units) with one package, one
 * item. Canonical storage is always cm/kg; dimUnit/weightUnit here are chosen so
 * `fromCanonicalDim`/`fromCanonicalWeight` are NOT identity functions, unlike
 * `oneCargoWithTwoPackages` above (CM/KG, where conversion is a no-op and the display
 * test can't distinguish "converted correctly" from "raw canonical value echoed as-is").
 * Canonical dims 15/9/4 cm -> 150/90/40 mm; canonical gross 2.75 kg -> 2750 g — chosen to
 * be distinctive from both the canonical values and from each other.
 */
function oneCargoWithNonCanonicalUnits(): CargoDto {
  return {
    id: CARGO_ID,
    rowIndex: 0,
    poReference: "PO-2",
    label: null,
    dimUnit: "MM",
    weightUnit: "GM",
    packages: [
      {
        id: PACKAGE_ID_1,
        rowIndex: 0,
        packageNo: "P-9",
        packageType: "CRATE",
        dimL: "15",
        dimW: "9",
        dimH: "4",
        grossWt: "2.75",
        netWt: null,
        volumeCbm: "0.0005",
        tags: [],
        effectiveTags: [],
        msdsFileId: null,
        items: [
          {
            id: ITEM_ID_1,
            rowIndex: 0,
            product: "Deck paint",
            qty: "8",
            uom: "PC",
            hsCode: null,
            tags: [],
          },
        ],
      },
    ],
    packageCount: 1,
    grossWeightKg: "2.75",
    volumeCbm: "0.0005",
    tags: [],
    chargeableWeight: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    blob: () => Promise.resolve(new Blob()),
  } as Response;
}

/**
 * Navigate to Step 3 (Cargo) in the wizard. Scoped to the Stepper's own <nav> (not a
 * bare `getByRole("button", { name: /cargo/i })`) because the new cargo table's own
 * "+ Add Cargo" button also matches that name once Step3Cargo is on screen.
 */
async function navigateToStep3() {
  await screen.findByText("YAL26-0099");
  const stepper = screen.getByRole("navigation", { name: /progress/i });
  const cargoTab = within(stepper).getByRole("button", { name: /cargo/i });
  await userEvent.click(cargoTab);
}

/**
 * Render the wizard routed to an existing query's Cargo step, with `detail.cargos`
 * seeded from `cargos`. Mirrors how earlier Step3Cargo tests inject `detail` (mock
 * /api/auth/me + GET /api/queries/:id, then navigate via QueryWizardPage), packaged
 * as a reusable helper. `extra` lets a test layer in additional routes (export,
 * delete, ...) — return a Response to handle a call, or undefined to fall through.
 */
async function renderStep3(
  opts: {
    cargos?: CargoDto[];
    extra?: (url: string, init?: RequestInit) => Response | undefined;
  } = {},
) {
  const detail = { ...baseDetail, cargos: opts.cargos ?? [] };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/api/auth/me"))
      return Promise.resolve(
        jsonResponse({ user: { id: "u1", name: "Agent", email: "a@x", role: "EXECUTIVE" } }),
      );
    if (url === `/api/queries/${QUERY_ID}` && (!init?.method || init.method === "GET"))
      return Promise.resolve(jsonResponse(detail));
    const extraRes = opts.extra?.(url, init);
    if (extraRes) return Promise.resolve(extraRes);
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  renderWithProviders(
    <Routes>
      <Route path="/queries/:id" element={<QueryWizardPage />} />
    </Routes>,
    { route: `/queries/${QUERY_ID}?step=2` },
  );
  await navigateToStep3();
  return { fetchMock };
}

describe("Step3Cargo", () => {
  it("shows a cargo row with derived totals and expands to packages then items", async () => {
    const user = userEvent.setup();
    await renderStep3({ cargos: [oneCargoWithTwoPackages()] });

    const cargoRow = (await screen.findByText("PO-1")).closest("tr")!;
    expect(within(cargoRow).getByText("2")).toBeInTheDocument(); // package count

    await user.click(screen.getByLabelText("Expand cargo PO-1"));
    expect(await screen.findByText("P-1")).toBeInTheDocument(); // package row

    await user.click(screen.getByLabelText("Expand package P-1"));
    expect(await screen.findByText("Deck paint")).toBeInTheDocument(); // item row
  });

  it("converts non-canonical units (MM/GM) for display instead of echoing raw canonical cm/kg", async () => {
    const user = userEvent.setup();
    await renderStep3({ cargos: [oneCargoWithNonCanonicalUnits()] });

    const cargoRow = (await screen.findByText("PO-2")).closest("tr")!;
    // Σ Gross: canonical 2.75 kg -> 2750 g (GM) — a stub identity conversion would show "2.75"
    expect(within(cargoRow).getByText("2750.00")).toBeInTheDocument();
    expect(within(cargoRow).getByText("GM")).toBeInTheDocument();
    expect(within(cargoRow).getByText("Deck paint ×8")).toBeInTheDocument(); // Contents cell

    await user.click(screen.getByLabelText("Expand cargo PO-2"));
    const pkgRow = (await screen.findByText("P-9")).closest("tr")!;

    // L/W/H: canonical 15/9/4 cm -> 150/90/40 mm — a stub identity conversion would show 15/9/4
    expect(within(pkgRow).getByText("150")).toBeInTheDocument(); // L
    expect(within(pkgRow).getByText("90")).toBeInTheDocument(); // W
    expect(within(pkgRow).getByText("40")).toBeInTheDocument(); // H
    expect(within(pkgRow).getAllByText("MM")).toHaveLength(3);

    // Gross: canonical 2.75 kg -> 2750 g, same math as the cargo-row rollup above
    expect(within(pkgRow).getByText("2750.00")).toBeInTheDocument();
    expect(within(pkgRow).getByText("GM")).toBeInTheDocument();
  });

  it("shows an empty state when there are no cargo rows", async () => {
    await renderStep3({ cargos: [] });
    expect(screen.getByText(/no cargo rows yet/i)).toBeInTheDocument();
  });

  it("removes a cargo row: DELETEs /cargo/:cid after confirmation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );

    const { fetchMock } = await renderStep3({
      cargos: [oneCargoWithTwoPackages()],
      extra: (url, init) =>
        url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}` && init?.method === "DELETE"
          ? jsonResponse({}, 204)
          : undefined,
    });

    await screen.findByText("PO-1");
    await user.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it("opens CargoPopup from + Add Cargo with unit selectors defaulting CM/KG, and Save POSTs dimUnit/weightUnit (Task 13)", async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    const createdCargo: CargoDto = {
      id: "new-cargo-id",
      rowIndex: 0,
      poReference: "PO-9",
      label: null,
      dimUnit: "CM",
      weightUnit: "KG",
      packages: [],
      packageCount: 0,
      grossWeightKg: "0",
      volumeCbm: "0",
      tags: [],
      chargeableWeight: null,
    };

    await renderStep3({
      cargos: [],
      extra: (url, init) => {
        if (url === `/api/queries/${QUERY_ID}/cargo` && init?.method === "POST") {
          posted.push(JSON.parse(init.body as string));
          return jsonResponse(createdCargo, 201);
        }
        return undefined;
      },
    });

    await user.click(screen.getByRole("button", { name: /\+ add cargo/i }));
    const dialog = await screen.findByRole("dialog");

    // Radix Select renders a hidden native <select> for accessibility/form purposes —
    // drive/read those directly (jsdom can't do real pointer-driven popups). DOM order:
    // Dimension Unit, then Weight Unit.
    const hiddenSelects = dialog.querySelectorAll<HTMLSelectElement>('select[aria-hidden="true"]');
    expect(hiddenSelects).toHaveLength(2);
    expect(hiddenSelects[0].value).toBe("CM");
    expect(hiddenSelects[1].value).toBe("KG");

    await user.click(within(dialog).getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ dimUnit: "CM", weightUnit: "KG" });
  });

  it("Edit opens CargoPopup pre-filled with the cargo's own PO/label/units (Task 13)", async () => {
    const user = userEvent.setup();
    await renderStep3({ cargos: [oneCargoWithTwoPackages()] });

    await screen.findByText("PO-1");
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByDisplayValue("PO-1")).toBeInTheDocument();
    const hiddenSelects = dialog.querySelectorAll<HTMLSelectElement>('select[aria-hidden="true"]');
    expect(hiddenSelects[0].value).toBe("CM");
    expect(hiddenSelects[1].value).toBe("KG");
  });

  it("clicking Export triggers the blob download flow (POST + createObjectURL + <a>.click)", async () => {
    const user = userEvent.setup();

    const fakeBlob = new Blob(["xlsx"], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
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

    const { fetchMock } = await renderStep3({
      extra: (url, init) =>
        url === `/api/queries/${QUERY_ID}/cargo/export` && init?.method === "POST"
          ? ({
              ok: true,
              status: 200,
              json: () => Promise.resolve({}),
              text: () => Promise.resolve(""),
              blob: () => Promise.resolve(fakeBlob),
            } as Response)
          : undefined,
    });

    await user.click(screen.getByRole("button", { name: /export to excel/i }));

    await waitFor(() => {
      const exportCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo/export` &&
          (init as RequestInit)?.method === "POST",
      );
      expect(exportCall).toBeTruthy();
    });

    await waitFor(() => {
      expect(createObjectURLMock).toHaveBeenCalledWith(fakeBlob);
      expect(clickMock).toHaveBeenCalled();
      expect(revokeObjectURLMock).toHaveBeenCalledWith(fakeObjectUrl);
    });
  });
});
