import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useLegs } from "./useLegs";
import type { LegDto } from "./useLegs";
import { ApiError } from "@/lib/api";
import type { Finding } from "@svyft/shared";

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LEG_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORIGIN_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DEST_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const CARGO_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const baseLeg: LegDto = {
  id: LEG_ID,
  queryId: QUERY_ID,
  legCode: "L1",
  mode: "ROAD",
  originPointId: ORIGIN_ID,
  destinationPointId: DEST_ID,
};

afterEach(() => vi.unstubAllGlobals());

describe("useLegs", () => {
  describe("add()", () => {
    it("POSTs to /api/queries/:id/legs with assignedCargoIds and returns the saved leg", async () => {
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
          url === `/api/queries/${QUERY_ID}/legs` &&
          init?.method === "POST"
        )
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve(baseLeg),
            text: () => Promise.resolve(JSON.stringify(baseLeg)),
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

      const { result } = renderHook(() => useLegs(QUERY_ID), { wrapper });

      let returned: LegDto | undefined;
      await act(async () => {
        returned = await result.current.add({
          originPointId: ORIGIN_ID,
          destinationPointId: DEST_ID,
          mode: "ROAD",
          assignedCargoIds: [CARGO_ID],
        });
      });

      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/legs` &&
          (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const sentBody = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(sentBody.assignedCargoIds).toEqual([CARGO_ID]);
      expect(sentBody.originPointId).toBe(ORIGIN_ID);
      expect(returned?.id).toBe(LEG_ID);
    });

    it("a 422 response surfaces as ApiError with findings[0].rule === 'V-M1'", async () => {
      const vmFinding: Finding = {
        rule: "V-M1",
        severity: "blocking",
        scope: { type: "leg" },
        message: "A Sea leg needs seaport endpoints",
      };

      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (
          url === `/api/queries/${QUERY_ID}/legs` &&
          init?.method === "POST"
        )
          return Promise.resolve({
            ok: false,
            status: 422,
            json: () =>
              Promise.resolve({
                message: "Validation failed",
                findings: [vmFinding],
              }),
            text: () =>
              Promise.resolve(
                JSON.stringify({ message: "Validation failed", findings: [vmFinding] }),
              ),
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

      const { result } = renderHook(() => useLegs(QUERY_ID), { wrapper });

      let caught: ApiError | undefined;
      await act(async () => {
        try {
          await result.current.add({
            originPointId: ORIGIN_ID,
            destinationPointId: DEST_ID,
            mode: "SEA",
            assignedCargoIds: [CARGO_ID],
          });
        } catch (err) {
          caught = err as ApiError;
        }
      });

      expect(caught).toBeInstanceOf(ApiError);
      expect(caught!.status).toBe(422);
      expect(caught!.findings).toHaveLength(1);
      expect(caught!.findings![0].rule).toBe("V-M1");
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
          json: () => Promise.resolve(baseLeg),
          text: () => Promise.resolve(JSON.stringify(baseLeg)),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      );
      vi.stubGlobal("fetch", fetchMock);

      const customWrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: qc }, children);

      const { result } = renderHook(() => useLegs(QUERY_ID), {
        wrapper: customWrapper,
      });

      await act(async () => {
        await result.current.add({ mode: "ROAD" });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["query", QUERY_ID],
      });
    });
  });

  describe("update()", () => {
    it("PATCHes /api/queries/:id/legs/:legId with the update input", async () => {
      const updatedLeg = { ...baseLeg, mode: "AIR" };
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(updatedLeg),
          text: () => Promise.resolve(JSON.stringify(updatedLeg)),
          blob: () => Promise.resolve(new Blob()),
        } as Response),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useLegs(QUERY_ID), { wrapper });

      await act(async () => {
        await result.current.update(LEG_ID, { mode: "AIR" });
      });

      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/legs/${LEG_ID}` &&
          (init as RequestInit)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const sentBody = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(sentBody.mode).toBe("AIR");
    });
  });

  describe("remove()", () => {
    it("DELETEs /api/queries/:id/legs/:legId", async () => {
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

      const { result } = renderHook(() => useLegs(QUERY_ID), { wrapper });

      await act(async () => {
        await result.current.remove(LEG_ID);
      });

      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/legs/${LEG_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });
});
