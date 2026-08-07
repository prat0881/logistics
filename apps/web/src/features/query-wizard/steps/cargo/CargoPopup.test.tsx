import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CargoDto, PackageDto } from "@svyft/shared";
import { CargoPopup } from "./CargoPopup";

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CARGO_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PACKAGE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function hiddenSelects(): HTMLSelectElement[] {
  return Array.from(document.querySelectorAll<HTMLSelectElement>('select[aria-hidden="true"]'));
}

function renderPopup(
  opts: { extra?: (url: string, init?: RequestInit) => Response | undefined } = {},
) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const res = opts.extra?.(url, init);
    if (res) return Promise.resolve(res);
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CargoPopup open onOpenChange={() => {}} queryId={QUERY_ID} />
    </QueryClientProvider>,
  );
  return { fetchMock };
}

describe("CargoPopup (Task 13 save-flow)", () => {
  it("Add mode: saving the cargo reveals the Packages section, and Add Package -> Save shows the new row", async () => {
    const user = userEvent.setup();
    const newCargo: CargoDto = {
      id: CARGO_ID,
      rowIndex: 0,
      poReference: "PO-1",
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
    const newPackage: PackageDto = {
      id: PACKAGE_ID,
      rowIndex: 0,
      packageNo: "P-1",
      packageType: "BOX",
      dimL: "10",
      dimW: "10",
      dimH: "10",
      grossWt: "5",
      netWt: null,
      volumeCbm: "0.0010",
      tags: [],
      effectiveTags: [],
      msdsFileId: null,
      items: [],
    };

    renderPopup({
      extra: (url, init) => {
        if (url === `/api/queries/${QUERY_ID}/cargo` && init?.method === "POST") {
          return jsonResponse(newCargo, 201);
        }
        if (
          url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}/packages` &&
          init?.method === "POST"
        ) {
          return jsonResponse(newPackage, 201);
        }
        return undefined;
      },
    });

    // Add mode: no cargoId yet -> packages section not shown.
    expect(screen.getByText(/save the cargo above/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Cargo now exists -> Packages section appears, empty.
    expect(await screen.findByText(/no packages yet/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /\+ add package/i }));
    // The add form pre-fills the next query-wide packageNo (P-1 here); replace it explicitly.
    await user.clear(screen.getByLabelText("Package No"));
    await user.type(screen.getByLabelText("Package No"), "P-1");
    // hiddenSelects(): [0]=cargo Dimension Unit, [1]=cargo Weight Unit (CargoEditFields,
    // now mounted since the cargo is saved), [2]=this draft package's Package Type.
    fireEvent.change(hiddenSelects()[2], { target: { value: "BOX" } }); // packageType
    await user.type(screen.getByLabelText("L"), "10");
    await user.type(screen.getByLabelText("W"), "10");
    await user.type(screen.getByLabelText("H"), "10");
    await user.type(screen.getByLabelText("Gross Wt"), "5");
    await user.click(screen.getByRole("button", { name: /^save package$/i }));

    // The saved package now shows as a read-only summary row (packageNo as text, not an input).
    expect(await screen.findByText("P-1")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/no packages yet/i)).not.toBeInTheDocument());
  });

  it("Edit mode: package shows as a compact row that expands to edit; Add suggests the next query-wide packageNo", async () => {
    const user = userEvent.setup();
    const existingPkg: PackageDto = {
      id: PACKAGE_ID,
      rowIndex: 0,
      packageNo: "P-1",
      packageType: "BOX",
      dimL: "10",
      dimW: "10",
      dimH: "10",
      grossWt: "5",
      netWt: null,
      volumeCbm: "0.0010",
      tags: [],
      effectiveTags: [],
      msdsFileId: null,
      items: [],
    };
    const cargo: CargoDto = {
      id: CARGO_ID,
      rowIndex: 0,
      poReference: "PO-1",
      label: null,
      dimUnit: "CM",
      weightUnit: "KG",
      packages: [existingPkg],
      packageCount: 1,
      grossWeightKg: "5",
      volumeCbm: "0.0010",
      tags: [],
      chargeableWeight: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({}))),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CargoPopup
          open
          onOpenChange={() => {}}
          queryId={QUERY_ID}
          cargo={cargo}
          // P-1 is this cargo's package; P-2 is used by ANOTHER cargo in the query.
          existingPackageNos={["P-1", "P-2"]}
        />
      </QueryClientProvider>,
    );

    // The package renders as a compact summary row (packageNo as text).
    expect(screen.getByText("P-1")).toBeInTheDocument();

    // Adding suggests the next FREE number across the WHOLE query (P-1 & P-2 taken -> P-3),
    // so a second cargo never collides with the first (V-4 fix).
    await user.click(screen.getByRole("button", { name: /\+ add package/i }));
    expect(screen.getByLabelText("Package No")).toHaveValue("P-3");

    // Editing the row expands it into the full package editor in place.
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(screen.getByDisplayValue("P-1")).toBeInTheDocument();
  });
});
