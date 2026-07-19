import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { usePoints, type PointDto } from "./usePoints";

const QUERY_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const POINT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const basePoint = {
  id: POINT_ID,
  queryId: QUERY_ID,
  type: "AIRPORT" as const,
  name: "Heathrow Airport",
  iataCode: "LHR",
  city: "London",
  country: "UK",
};

afterEach(() => vi.unstubAllGlobals());

describe("usePoints", () => {
  describe("add()", () => {
    it("POSTs to /api/queries/:id/points with the point input and returns the saved point", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes("/api/auth/me"))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                user: { id: "u1", name: "Test", email: "t@x", role: "EXECUTIVE" },
              }),
            text: () => Promise.resolve(""),
            blob: () => Promise.resolve(new Blob()),
          } as Response);

        if (
          url === `/api/queries/${QUERY_ID}/points` &&
          init?.method === "POST"
        )
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve(basePoint),
            text: () => Promise.resolve(JSON.stringify(basePoint)),
            blob: () => Promise.resolve(new Blob()),
          } as Response);

        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => usePoints(QUERY_ID), { wrapper });

      let returned: PointDto | undefined;
      await act(async () => {
        returned = await result.current.add({
          type: "AIRPORT",
          name: "Heathrow Airport",
          iataCode: "LHR",
          city: "London",
          country: "UK",
        });
      });

      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/points` &&
          (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const sentBody = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(sentBody.type).toBe("AIRPORT");
      expect(sentBody.iataCode).toBe("LHR");
      expect(returned?.id).toBe(POINT_ID);
    });

    it("invalidates ['query', queryId] after a successful add", async () => {
      const invalidateSpy = vi.fn();
      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      qc.invalidateQueries = invalidateSpy;

      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(basePoint),
          text: () => Promise.resolve(JSON.stringify(basePoint)),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      );
      vi.stubGlobal("fetch", fetchMock);

      const customWrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: qc }, children);

      const { result } = renderHook(() => usePoints(QUERY_ID), {
        wrapper: customWrapper,
      });

      await act(async () => {
        await result.current.add({ type: "AIRPORT" });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["query", QUERY_ID],
      });
    });
  });

  describe("update()", () => {
    it("PATCHes /api/queries/:id/points/:pointId with the update input", async () => {
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ...basePoint, name: "Gatwick" }),
          text: () =>
            Promise.resolve(JSON.stringify({ ...basePoint, name: "Gatwick" })),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => usePoints(QUERY_ID), { wrapper });

      await act(async () => {
        await result.current.update(POINT_ID, { name: "Gatwick" });
      });

      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/points/${POINT_ID}` &&
          (init as RequestInit)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const sentBody = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(sentBody.name).toBe("Gatwick");
    });

    it("invalidates ['query', queryId] after a successful update", async () => {
      const invalidateSpy = vi.fn();
      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      qc.invalidateQueries = invalidateSpy;

      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ...basePoint, name: "Gatwick" }),
          text: () => Promise.resolve(JSON.stringify({ ...basePoint, name: "Gatwick" })),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      );
      vi.stubGlobal("fetch", fetchMock);

      const customWrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: qc }, children);

      const { result } = renderHook(() => usePoints(QUERY_ID), {
        wrapper: customWrapper,
      });

      await act(async () => {
        await result.current.update(POINT_ID, { name: "Gatwick" });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["query", QUERY_ID],
      });
    });
  });

  describe("remove()", () => {
    it("DELETEs /api/queries/:id/points/:pointId", async () => {
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => usePoints(QUERY_ID), { wrapper });

      await act(async () => {
        await result.current.remove(POINT_ID);
      });

      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/points/${POINT_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });

    it("invalidates ['query', queryId] after a successful remove", async () => {
      const invalidateSpy = vi.fn();
      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      qc.invalidateQueries = invalidateSpy;

      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      );
      vi.stubGlobal("fetch", fetchMock);

      const customWrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: qc }, children);

      const { result } = renderHook(() => usePoints(QUERY_ID), {
        wrapper: customWrapper,
      });

      await act(async () => {
        await result.current.remove(POINT_ID);
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["query", QUERY_ID],
      });
    });
  });
});
