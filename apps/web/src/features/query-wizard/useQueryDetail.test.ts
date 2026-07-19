import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { useQueryDetail, useSaveQuery, useCreateQuery } from "./useQueryDetail";

afterEach(() => vi.unstubAllGlobals());

const baseDetail = {
  id: "q1",
  queryCode: "YAL26-0001",
  queryDate: "2026-01-01T00:00:00+00:00",
  priority: "HIGH",
  status: "DRAFT",
  dgIndicator: false,
  whatsappEnabled: false,
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

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    wrapper: function Wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client: qc }, children);
    },
    qc,
  };
}

describe("useQueryDetail", () => {
  it("fetches a query by id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => baseDetail,
        text: async () => "",
      }),
    );

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useQueryDetail("q1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.queryCode).toBe("YAL26-0001");
  });

  it("is disabled when no id is provided", () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useQueryDetail(undefined), { wrapper });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useSaveQuery", () => {
  it("create() POSTs to /api/queries", async () => {
    const postSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => baseDetail,
      text: async () => JSON.stringify(baseDetail),
    });
    vi.stubGlobal("fetch", postSpy);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useSaveQuery(), { wrapper });

    let data: unknown;
    await act(async () => {
      data = await result.current.create({ priority: "HIGH" });
    });
    expect(postSpy.mock.calls[0][0]).toBe("/api/queries");
    expect(postSpy.mock.calls[0][1]?.method).toBe("POST");
    expect((data as typeof baseDetail).id).toBe("q1");
  });

  it("patch() PATCHes to /api/queries/:id", async () => {
    const patchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...baseDetail, contactName: "Alice" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", patchSpy);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useSaveQuery(), { wrapper });

    let data: unknown;
    await act(async () => {
      data = await result.current.patch("q1", { contactName: "Alice" });
    });
    expect(patchSpy.mock.calls[0][0]).toBe("/api/queries/q1");
    expect(patchSpy.mock.calls[0][1]?.method).toBe("PATCH");
    expect((data as typeof baseDetail).contactName).toBe("Alice");
  });
});

describe("useCreateQuery", () => {
  it("POSTs to /api/queries/:id/create", async () => {
    const postSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "q1", status: "RFQ_READY" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", postSpy);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateQuery(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("q1");
    });
    expect(postSpy.mock.calls[0][0]).toBe("/api/queries/q1/create");
    expect(postSpy.mock.calls[0][1]?.method).toBe("POST");
  });
});
