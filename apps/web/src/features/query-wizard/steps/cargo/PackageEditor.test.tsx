import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PackageDto, ItemDto, DimUnit, WeightUnit } from "@svyft/shared";
import { PackageEditor } from "./PackageEditor";

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CARGO_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PACKAGE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ITEM_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

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

/** A saved package (CM/KG entry, no tags/items) — the default for renderPackageEditor(). */
function existingPackage(overrides: Partial<PackageDto> = {}): PackageDto {
  return {
    id: PACKAGE_ID,
    rowIndex: 0,
    packageNo: "P-1",
    packageType: "CRATE",
    dimL: "120",
    dimW: "100",
    dimH: "140",
    grossWt: "420",
    netWt: null,
    volumeCbm: "1.6800",
    tags: [],
    effectiveTags: [],
    msdsFileId: null,
    items: [],
    ...overrides,
  };
}

/** All hidden native <select>s currently on the page, in DOM order (Radix Select's
 * jsdom-visible form-bubble input — see Step3Cargo.test.tsx / LegEditor.test.tsx for the
 * same pattern used elsewhere in this codebase). */
function hiddenSelects(): HTMLSelectElement[] {
  return Array.from(document.querySelectorAll<HTMLSelectElement>('select[aria-hidden="true"]'));
}

/**
 * Renders PackageEditor directly (no CargoPopup/Dialog wrapper — it's a plain form
 * component) against a stubbed fetch + local QueryClientProvider, mirroring the
 * usePackages.test.ts/useItems.test.ts harness style. Defaults to EDIT mode with an
 * existing saved package (packageNo/type/dims/gross pre-filled, CM/KG) since adding item
 * lines (Task 15) needs a real packageId; pass `pkg: null` for the add-mode-only scenario
 * (Task 14's CBM/MSDS-reveal test fills a brand-new package's own fields, unsaved).
 */
function renderPackageEditor(
  opts: {
    cargoUnits?: { dimUnit: DimUnit; weightUnit: WeightUnit };
    pkg?: PackageDto | null;
    extra?: (url: string, init?: RequestInit) => Response | undefined;
    onRemoved?: (packageId: string) => void;
    onCopies?: (clones: PackageDto[]) => void;
  } = {},
) {
  const cargoUnits = opts.cargoUnits ?? {
    dimUnit: "CM" as DimUnit,
    weightUnit: "KG" as WeightUnit,
  };
  const pkg = opts.pkg === null ? undefined : (opts.pkg ?? existingPackage());
  const saved: PackageDto[] = [];

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const extraRes = opts.extra?.(url, init);
    if (extraRes) return Promise.resolve(extraRes);
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PackageEditor
        queryId={QUERY_ID}
        cargoId={CARGO_ID}
        cargoDimUnit={cargoUnits.dimUnit}
        cargoWeightUnit={cargoUnits.weightUnit}
        pkg={pkg}
        onSaved={(p) => saved.push(p)}
        onRemoved={opts.onRemoved}
        onCopies={opts.onCopies}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, saved };
}

describe("PackageEditor", () => {
  it("shows CBM in the cargo unit and reveals MSDS upload when a package is effectively DG (Task 14)", async () => {
    const user = userEvent.setup();
    renderPackageEditor({ cargoUnits: { dimUnit: "MM", weightUnit: "KG" }, pkg: null });

    await user.type(screen.getByLabelText("Package No"), "P-1");
    fireEvent.change(hiddenSelects()[0], { target: { value: "CRATE" } }); // packageType
    await user.type(screen.getByLabelText("L"), "1200");
    await user.type(screen.getByLabelText("W"), "1000");
    await user.type(screen.getByLabelText("H"), "1400");
    await user.type(screen.getByLabelText("Gross Wt"), "420");

    // mm entry -> 1.68 m3 canonical (120*100*140cm / 1e6)
    expect(screen.getByLabelText("Volume (CBM)")).toHaveValue("1.6800");
    expect(screen.queryByLabelText("Upload MSDS PDF")).toBeNull();

    const dgCheckbox = within(screen.getByTestId("package-tags")).getByRole("checkbox", {
      name: /dangerous goods/i,
    });
    await user.click(dgCheckbox);

    expect(screen.getByLabelText("Upload MSDS PDF")).toBeInTheDocument();
  });

  it("requires UoM when qty is entered and flags the package DG when an item is DG (Task 15)", async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    const createdItem: ItemDto = {
      id: ITEM_ID,
      rowIndex: 0,
      product: "Paint",
      qty: "8",
      uom: "PC",
      hsCode: null,
      tags: ["DG"],
    };
    const itemsUrl = `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}/packages/${PACKAGE_ID}/items`;

    renderPackageEditor({
      extra: (url, init) => {
        if (url === itemsUrl && init?.method === "POST") {
          posted.push(JSON.parse(init.body as string));
          return jsonResponse(createdItem, 201);
        }
        return undefined;
      },
    });

    expect(screen.queryByLabelText("Upload MSDS PDF")).toBeNull();

    await user.type(screen.getByLabelText("Product"), "Paint");
    await user.type(screen.getByLabelText("Qty"), "8");
    await user.click(screen.getByRole("button", { name: /add item/i }));

    expect(await screen.findByText(/Unit of measure is required/i)).toBeInTheDocument();
    expect(posted).toHaveLength(0); // client-side V-4 blocked the POST

    // selects()[0] = package's own packageType (edit mode always renders it); [1] = the
    // item add-form's UoM select — see hiddenSelects() DOM-order note above.
    fireEvent.change(hiddenSelects()[1], { target: { value: "PC" } });
    const dgCheckbox = within(screen.getByTestId("item-add-tags")).getByRole("checkbox", {
      name: /dangerous goods/i,
    });
    await user.click(dgCheckbox);
    await user.click(screen.getByRole("button", { name: /add item/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ product: "Paint", qty: 8, uom: "PC", tags: ["DG"] });

    expect(await screen.findByLabelText("Upload MSDS PDF")).toBeInTheDocument();
  });

  it("uploads a file via usePackages().uploadMsds when a saved package is effectively DG", async () => {
    const user = userEvent.setup();
    const uploadCalls: string[] = [];
    const msdsUrl = `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}/packages/${PACKAGE_ID}/msds`;
    const updatedPkg = existingPackage({
      tags: ["DG"],
      effectiveTags: ["DG"],
      msdsFileId: "file-123",
    });

    renderPackageEditor({
      pkg: existingPackage({ tags: ["DG"], effectiveTags: ["DG"] }),
      extra: (url, init) => {
        if (url === msdsUrl && init?.method === "POST") {
          uploadCalls.push(url);
          return jsonResponse(updatedPkg, 200);
        }
        return undefined;
      },
    });

    const fileInput = screen.getByLabelText("Upload MSDS PDF") as HTMLInputElement;
    const file = new File(["pdf-bytes"], "msds.pdf", { type: "application/pdf" });
    await user.upload(fileInput, file);

    await waitFor(() => expect(uploadCalls).toHaveLength(1));
    expect(screen.getByText(/uploaded/i)).toBeInTheDocument();
  });

  it("'Add N copies' calls usePackages().copy(pid, count) for a saved package", async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    const clones = [
      existingPackage({ id: "clone-1", packageNo: "P-1-2" }),
      existingPackage({ id: "clone-2", packageNo: "P-1-3" }),
    ];
    const copiesUrl = `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}/packages/${PACKAGE_ID}/copies`;
    let receivedClones: PackageDto[] | undefined;

    renderPackageEditor({
      onCopies: (c) => {
        receivedClones = c;
      },
      extra: (url, init) => {
        if (url === copiesUrl && init?.method === "POST") {
          posted.push(JSON.parse(init.body as string));
          return jsonResponse(clones, 201);
        }
        return undefined;
      },
    });

    await user.click(screen.getByRole("button", { name: /add n copies/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ count: 2 }); // the control's default count
    expect(receivedClones).toEqual(clones);
  });

  it("Remove calls usePackages().remove and notifies onRemoved after confirmation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const removeCalls: string[] = [];
    const removeUrl = `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}/packages/${PACKAGE_ID}`;
    let removedId: string | undefined;

    renderPackageEditor({
      onRemoved: (id) => {
        removedId = id;
      },
      extra: (url, init) => {
        if (url === removeUrl && init?.method === "DELETE") {
          removeCalls.push(url);
          return jsonResponse({}, 204);
        }
        return undefined;
      },
    });

    await user.click(screen.getByRole("button", { name: /^remove$/i }));

    await waitFor(() => expect(removeCalls).toHaveLength(1));
    expect(removedId).toBe(PACKAGE_ID);
  });
});
