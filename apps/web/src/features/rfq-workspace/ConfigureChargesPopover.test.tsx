import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ChargeLineDefinitionDto, QueryLegDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { ConfigureChargesPopover } from "./ConfigureChargesPopover";

const QUERY_ID = "q1";
const LEG_ID = "l1";
const PATCH_URL = `/api/queries/${QUERY_ID}/legs/${LEG_ID}`;

function charge(
  id: string,
  key: string,
  label: string,
  role: ChargeLineDefinitionDto["role"],
  mode: ChargeLineDefinitionDto["mode"] = "AIR",
): ChargeLineDefinitionDto {
  return {
    id,
    key,
    label,
    role,
    mode,
    inputType: "PLAIN",
    zone: null,
    tagKey: null,
    sortOrder: 0,
    isActive: true,
  };
}

// A CORE + two STANDARD + one TAG_DRIVEN line for AIR, plus a STANDARD line for SEA
// (a different mode) to prove the dialog mode-filters the catalogue against leg.mode.
const CATALOGUE: ChargeLineDefinitionDto[] = [
  charge("core-1", "AIR_ZONE1", "Air Zone 1", "CORE"),
  charge("std-1", "FUEL_SURCHARGE", "Fuel Surcharge", "STANDARD"),
  charge("std-2", "SECURITY_FEE", "Security Fee", "STANDARD"),
  charge("tag-1", "HANDLING_FEE", "Handling Fee", "TAG_DRIVEN"),
  charge("sea-1", "SEA_ONLY_LINE", "Sea Only Line", "STANDARD", "SEA"),
];

function leg(chargeLineDefinitionIds: string[] = []): QueryLegDto {
  return { id: LEG_ID, mode: "AIR", chargeLineDefinitionIds } as unknown as QueryLegDto;
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function stubPatch() {
  const fetchMock = mockFetch((url, init) => {
    if (url === PATCH_URL && init?.method === "PATCH") return { status: 200, body: {} };
    return { status: 404 };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function patchCalls(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls.filter(
    (c) => String(c[0]) === PATCH_URL && (c[1] as RequestInit)?.method === "PATCH",
  );
}

// Dialog is modal: Radix marks everything outside DialogContent (including the trigger)
// aria-hidden while it's open, so the trigger's live count isn't queryable via role until
// the dialog closes. Close it through the built-in "X" to check the label afterwards.
async function closeDialog() {
  await userEvent.click(screen.getByRole("button", { name: /close/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConfigureChargesPopover", () => {
  it("is empty by default, and opening the dialog shows Standard/Tag-driven headings, mode-filtered", async () => {
    stubPatch();
    wrap(
      <ConfigureChargesPopover
        queryId={QUERY_ID}
        leg={leg()}
        catalogue={CATALOGUE}
        disabled={false}
      />,
    );

    // Empty by default — trigger shows a zero count before anything is opened/selected.
    const trigger = screen.getByRole("button", { name: /configure charges \(0\)/i });
    await userEvent.click(trigger);

    expect(await screen.findByRole("dialog", { name: /configure charges/i })).toBeInTheDocument();
    expect(screen.getByText("Standard")).toBeInTheDocument();
    expect(screen.getByText("Tag-driven")).toBeInTheDocument();
    expect(screen.getByText("Fuel Surcharge")).toBeInTheDocument();
    expect(screen.getByText("Security Fee")).toBeInTheDocument();
    expect(screen.getByText("Handling Fee")).toBeInTheDocument();

    // Mode filter: the SEA-mode line is excluded for this AIR leg.
    expect(screen.queryByText("Sea Only Line")).toBeNull();

    // 2 STANDARD + 1 TAG_DRIVEN + 1 CORE row are checkboxes.
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  it("renders cores as checked, disabled checkboxes under 'Always included' — non-editable", async () => {
    stubPatch();
    wrap(
      <ConfigureChargesPopover
        queryId={QUERY_ID}
        leg={leg()}
        catalogue={CATALOGUE}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /configure charges \(0\)/i }));
    expect(await screen.findByText("Always included")).toBeInTheDocument();

    const coreCheckbox = screen.getByRole("checkbox", { name: /air zone 1/i });
    expect(coreCheckbox).toBeChecked();
    expect(coreCheckbox).toBeDisabled();

    // A core row can't be unchecked and never triggers a PATCH — it isn't wired to onToggle.
    const fetchMock = stubPatch();
    await userEvent.click(coreCheckbox);
    expect(coreCheckbox).toBeChecked();
    expect(patchCalls(fetchMock)).toHaveLength(0);
  });

  it("omits a section heading entirely when the mode-filtered catalogue has no rows for that role", async () => {
    stubPatch();
    const noTagDriven = CATALOGUE.filter((c) => c.role !== "TAG_DRIVEN");
    wrap(
      <ConfigureChargesPopover
        queryId={QUERY_ID}
        leg={leg()}
        catalogue={noTagDriven}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /configure charges/i }));
    expect(await screen.findByText("Standard")).toBeInTheDocument();
    expect(screen.queryByText("Tag-driven")).toBeNull();
  });

  it("toggling a checkbox on calls PATCH …/legs/:id with the new id set, and updates the trigger count", async () => {
    const fetchMock = stubPatch();
    wrap(
      <ConfigureChargesPopover
        queryId={QUERY_ID}
        leg={leg()}
        catalogue={CATALOGUE}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /configure charges \(0\)/i }));
    const fuelCheckbox = await screen.findByRole("checkbox", { name: /fuel surcharge/i });
    expect(fuelCheckbox).not.toBeChecked();

    await userEvent.click(fuelCheckbox);

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse((patchCalls(fetchMock)[0][1] as RequestInit).body as string)).toEqual({
      chargeLineDefinitionIds: ["std-1"],
    });
    expect(fuelCheckbox).toBeChecked();

    // A second toggle accumulates onto the existing selection (insertion order preserved).
    await userEvent.click(screen.getByRole("checkbox", { name: /handling fee/i }));
    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(2));
    expect(JSON.parse((patchCalls(fetchMock)[1][1] as RequestInit).body as string)).toEqual({
      chargeLineDefinitionIds: ["std-1", "tag-1"],
    });

    await closeDialog();
    expect(
      await screen.findByRole("button", { name: /configure charges \(2\)/i }),
    ).toBeInTheDocument();
  });

  it("unchecking a pre-selected charge removes its id from the PATCH payload", async () => {
    const fetchMock = stubPatch();
    wrap(
      <ConfigureChargesPopover
        queryId={QUERY_ID}
        leg={leg(["std-1", "std-2"])}
        catalogue={CATALOGUE}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /configure charges \(2\)/i }));
    const fuelCheckbox = await screen.findByRole("checkbox", { name: /fuel surcharge/i });
    expect(fuelCheckbox).toBeChecked();

    await userEvent.click(fuelCheckbox);

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse((patchCalls(fetchMock)[0][1] as RequestInit).body as string)).toEqual({
      chargeLineDefinitionIds: ["std-2"],
    });

    await closeDialog();
    expect(
      await screen.findByRole("button", { name: /configure charges \(1\)/i }),
    ).toBeInTheDocument();
  });

  it("Select all / Clear apply a whole section in a single PATCH call each, and self-disable when moot", async () => {
    const fetchMock = stubPatch();
    wrap(
      <ConfigureChargesPopover
        queryId={QUERY_ID}
        leg={leg()}
        catalogue={CATALOGUE}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /configure charges \(0\)/i }));
    const selectAllStandard = await screen.findByRole("button", { name: "Select all Standard" });
    const clearStandard = screen.getByRole("button", { name: "Clear Standard" });
    // Nothing selected yet: Select all is live, Clear is a no-op and starts disabled.
    expect(selectAllStandard).not.toBeDisabled();
    expect(clearStandard).toBeDisabled();

    await userEvent.click(selectAllStandard);

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse((patchCalls(fetchMock)[0][1] as RequestInit).body as string)).toEqual({
      chargeLineDefinitionIds: ["std-1", "std-2"],
    });
    expect(selectAllStandard).toBeDisabled(); // fully selected now
    expect(clearStandard).not.toBeDisabled();

    await userEvent.click(clearStandard);

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(2));
    expect(JSON.parse((patchCalls(fetchMock)[1][1] as RequestInit).body as string)).toEqual({
      chargeLineDefinitionIds: [],
    });

    await closeDialog();
    expect(
      await screen.findByRole("button", { name: /configure charges \(0\)/i }),
    ).toBeInTheDocument();
  });

  it("disabled renders every checkbox and select-all/clear button read-only, and blocks the API call on click", async () => {
    const fetchMock = stubPatch();
    wrap(<ConfigureChargesPopover queryId={QUERY_ID} leg={leg()} catalogue={CATALOGUE} disabled />);

    await userEvent.click(screen.getByRole("button", { name: /configure charges \(0\)/i }));
    const fuelCheckbox = await screen.findByRole("checkbox", { name: /fuel surcharge/i });
    for (const cb of screen.getAllByRole("checkbox")) expect(cb).toBeDisabled();
    for (const btn of screen.getAllByRole("button", { name: /^(select all|clear)/i })) {
      expect(btn).toBeDisabled();
    }

    await userEvent.click(fuelCheckbox);

    expect(fuelCheckbox).not.toBeChecked();
    expect(patchCalls(fetchMock)).toHaveLength(0);

    await closeDialog();
    expect(
      await screen.findByRole("button", { name: /configure charges \(0\)/i }),
    ).toBeInTheDocument();
  });
});
