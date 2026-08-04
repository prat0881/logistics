import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { QueryLegDto, QueryPointDto } from "@svyft/shared";
import { mockFetch } from "@/test/mock-fetch";
import { WarehouseHandlingToggle, legTouchesWarehouse } from "./WarehouseHandlingToggle";

const QUERY_ID = "q1";
const LEG_ID = "l1";
const PATCH_URL = `/api/queries/${QUERY_ID}/legs/${LEG_ID}`;

function leg(warehouseHandlingIncluded: boolean | null = null): QueryLegDto {
  return { id: LEG_ID, warehouseHandlingIncluded } as unknown as QueryLegDto;
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function stubPatch(status: number, body?: unknown) {
  const fetchMock = mockFetch((url, init) => {
    if (url === PATCH_URL && init?.method === "PATCH") return { status, body };
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("legTouchesWarehouse", () => {
  const points = [
    { id: "p1", type: "AIRPORT" },
    { id: "p2", type: "WAREHOUSE" },
  ] as unknown as QueryPointDto[];

  it("is true when the origin point is a WAREHOUSE", () => {
    const l = { originPointId: "p2", destinationPointId: "p1" } as unknown as QueryLegDto;
    expect(legTouchesWarehouse(l, points)).toBe(true);
  });

  it("is true when the destination point is a WAREHOUSE", () => {
    const l = { originPointId: "p1", destinationPointId: "p2" } as unknown as QueryLegDto;
    expect(legTouchesWarehouse(l, points)).toBe(true);
  });

  it("is false when neither endpoint is a WAREHOUSE", () => {
    const l = { originPointId: "p1", destinationPointId: "p1" } as unknown as QueryLegDto;
    expect(legTouchesWarehouse(l, points)).toBe(false);
  });

  it("is false when a point id is null or unresolvable", () => {
    const l = { originPointId: null, destinationPointId: "missing" } as unknown as QueryLegDto;
    expect(legTouchesWarehouse(l, points)).toBe(false);
  });
});

describe("WarehouseHandlingToggle", () => {
  it("shows the label, Yes/No buttons, and the decision-required hint when unset", () => {
    stubPatch(200, {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(null)} disabled={false} />);
    expect(screen.getByText(/warehouse handling included\?/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No" })).toBeInTheDocument();
    expect(screen.getByText(/decision required to distribute/i)).toBeInTheDocument();
  });

  it("hides the decision-required hint once the value is true", () => {
    stubPatch(200, {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(true)} disabled={false} />);
    expect(screen.queryByText(/decision required to distribute/i)).toBeNull();
  });

  it("hides the decision-required hint once the value is false", () => {
    stubPatch(200, {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(false)} disabled={false} />);
    expect(screen.queryByText(/decision required to distribute/i)).toBeNull();
  });

  it("clicking Yes PATCHes …/legs/:id with warehouseHandlingIncluded: true", async () => {
    const fetchMock = stubPatch(200, {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(null)} disabled={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse((patchCalls(fetchMock)[0][1] as RequestInit).body as string)).toEqual({
      warehouseHandlingIncluded: true,
    });
  });

  it("clicking No PATCHes …/legs/:id with warehouseHandlingIncluded: false", async () => {
    const fetchMock = stubPatch(200, {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(null)} disabled={false} />);

    await userEvent.click(screen.getByRole("button", { name: "No" }));

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse((patchCalls(fetchMock)[0][1] as RequestInit).body as string)).toEqual({
      warehouseHandlingIncluded: false,
    });
  });

  it("disabled renders both buttons non-interactive and blocks the API call on click", async () => {
    const fetchMock = stubPatch(200, {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(null)} disabled />);

    const yes = screen.getByRole("button", { name: "Yes" });
    const no = screen.getByRole("button", { name: "No" });
    expect(yes).toBeDisabled();
    expect(no).toBeDisabled();

    await userEvent.click(yes);
    await userEvent.click(no);

    expect(patchCalls(fetchMock)).toHaveLength(0);
  });

  it("a 409 (post-distribute change-order) surfaces the change-order alert", async () => {
    stubPatch(409, {});
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(null)} disabled={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "This change routes through a change-order (leg already distributed).",
      ),
    );
  });

  it("a non-409 error with findings surfaces the first finding's message", async () => {
    stubPatch(422, {
      findings: [
        { rule: "X", severity: "blocking", scope: { type: "leg", id: LEG_ID }, message: "Cannot change warehouse handling now." },
      ],
    });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(null)} disabled={false} />);

    await userEvent.click(screen.getByRole("button", { name: "No" }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Cannot change warehouse handling now."));
  });

  it("a non-409 error without findings does not alert", async () => {
    const fetchMock = stubPatch(500, {});
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    wrap(<WarehouseHandlingToggle queryId={QUERY_ID} leg={leg(null)} disabled={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
