import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { useQueries } from "./useQueries";

afterEach(() => vi.unstubAllGlobals());

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe("useQueries", () => {
  it("requests /api/queries with encoded params", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", spy);

    const { result } = renderHook(
      () => useQueries({ q: "YAL", status: "DRAFT", page: 1, pageSize: 20 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls[0][0]).toContain("/api/queries?");
    expect(spy.mock.calls[0][0]).toContain("q=YAL");
    expect(spy.mock.calls[0][0]).toContain("status=DRAFT");
  });

  it("returns paginated data", async () => {
    const mockData = {
      items: [
        {
          id: "q1",
          queryCode: "YAL26-0001",
          queryDate: "2026-01-01T00:00:00+00:00",
          customerName: "Acme",
          contactName: "Al",
          shipmentDescription: "steel",
          freightMode: ["SEA"],
          origin: "Mumbai, IN",
          destination: "Rotterdam, NL",
          responseDeadline: null,
          priority: "HIGH",
          status: "DRAFT",
          assignedUserId: null,
          assignedUserName: null,
          updatedAt: "2026-01-02T00:00:00+00:00",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockData,
        text: async () => "",
      }),
    );

    const { result } = renderHook(() => useQueries({ page: 1, pageSize: 20 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(1);
    expect(result.current.data?.items[0].queryCode).toBe("YAL26-0001");
  });
});
