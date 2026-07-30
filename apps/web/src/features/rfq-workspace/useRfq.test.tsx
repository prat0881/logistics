import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockFetch } from "@/test/mock-fetch";
import { useRfqState, useSetFfSelection, useReissueToken } from "./useRfq";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => vi.unstubAllGlobals());

describe("useRfq hooks", () => {
  it("useRfqState GETs the rfq-state endpoint", async () => {
    vi.stubGlobal("fetch", mockFetch((url) => {
      if (url.includes("/api/queries/q1/rfq-state"))
        return { status: 200, body: { quotes: [], rfqs: [], freightForwarders: [] } };
      return { status: 404 };
    }));
    const { result } = renderHook(() => useRfqState("q1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ quotes: [], rfqs: [], freightForwarders: [] });
  });

  it("useSetFfSelection PUTs { ffIds } to ff-selection", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url.includes("/legs/l1/ff-selection") && init?.method === "PUT")
        return { status: 200, body: { selected: ["ff1"] } };
      return { status: 404 };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSetFfSelection("q1", "l1"), { wrapper });
    const res = await result.current.mutateAsync(["ff1"]);
    expect(res).toEqual({ selected: ["ff1"] });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("ff-selection"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ ffIds: ["ff1"] });
  });
});

describe("useReissueToken", () => {
  it("posts freightForwarderId and returns the new token", async () => {
    const fx = mockFetch(() => ({ status: 200, body: { rfqId: "r1", rfqNumber: "Q-1-RFQ001", freightForwarderId: "ff1", accessToken: "TOK" } }));
    vi.stubGlobal("fetch", fx);
    const { result } = renderHook(() => useReissueToken("q1"), { wrapper });
    const res = await result.current.mutateAsync("ff1");
    expect(res.accessToken).toBe("TOK");
    expect(fx).toHaveBeenCalledWith(
      "/api/queries/q1/rfqs/reissue-token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ freightForwarderId: "ff1" }) }),
    );
  });
});
