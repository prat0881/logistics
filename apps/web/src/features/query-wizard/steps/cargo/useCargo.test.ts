import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { CargoDto } from "@svyft/shared";
import { useCargo } from "./useCargo";

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CARGO_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

// Re-modelled CargoDto (§7.3): cargo is now just the PO/label/unit grouping header — dims/
// weights/product live on Package/Item. Derived header fields (H4-H8) are always present.
const baseCargoDto: CargoDto = {
  id: CARGO_ID,
  rowIndex: 0,
  poReference: "PO-001",
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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    blob: () => Promise.resolve(new Blob()),
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("useCargo", () => {
  describe("add()", () => {
    it("POSTs the new CargoCreateInput shape to /api/queries/:id/cargo, invalidates the query cache, and returns the CargoDto", async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === `/api/queries/${QUERY_ID}/cargo` && init?.method === "POST") {
          return Promise.resolve(jsonResponse(baseCargoDto, 201));
        }
        return Promise.resolve(jsonResponse({}));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useCargo(QUERY_ID), { wrapper });

      let returned: CargoDto | undefined;
      await act(async () => {
        returned = await result.current.add({
          poReference: "PO-001",
          label: "Machinery batch",
          dimUnit: "CM",
          weightUnit: "KG",
        });
      });

      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo` && (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const sentBody = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(sentBody.poReference).toBe("PO-001");
      expect(sentBody.dimUnit).toBe("CM");
      expect(sentBody.weightUnit).toBe("KG");
      // no legacy fields
      expect(sentBody.productName).toBeUndefined();
      expect(sentBody.qty).toBeUndefined();

      expect(returned?.id).toBe(CARGO_ID);
      expect(returned?.packages).toEqual([]);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["query", QUERY_ID] });

      invalidateSpy.mockRestore();
    });
  });

  describe("update()", () => {
    it("PATCHes /api/queries/:id/cargo/:cid with a CargoUpdateInput and invalidates the query cache", async () => {
      const updatedDto: CargoDto = { ...baseCargoDto, label: "Relabelled" };
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}` && init?.method === "PATCH") {
          return Promise.resolve(jsonResponse(updatedDto));
        }
        return Promise.resolve(jsonResponse({}));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useCargo(QUERY_ID), { wrapper });

      let returned: CargoDto | undefined;
      await act(async () => {
        returned = await result.current.update(CARGO_ID, { label: "Relabelled" });
      });

      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}` &&
          (init as RequestInit)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const sentBody = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(sentBody.label).toBe("Relabelled");
      expect(returned?.label).toBe("Relabelled");
    });
  });

  describe("remove()", () => {
    it("DELETEs /api/queries/:id/cargo/:cid and invalidates the query cache", async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
        return Promise.resolve(jsonResponse({}, 204));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useCargo(QUERY_ID), { wrapper });

      await act(async () => {
        await result.current.remove(CARGO_ID);
      });

      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}` &&
          (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["query", QUERY_ID] });

      invalidateSpy.mockRestore();
    });
  });

  describe("MSDS moved off cargo", () => {
    it("no longer exposes uploadMsds — MSDS is now a package concern (usePackages)", () => {
      const { result } = renderHook(() => useCargo(QUERY_ID), { wrapper });
      expect((result.current as Record<string, unknown>).uploadMsds).toBeUndefined();
    });
  });

  describe("exportXlsx()", () => {
    it("POSTs to /cargo/export, gets blob, creates object URL, triggers download, revokes URL", async () => {
      const fakeBlob = new Blob(["xlsx data"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const fakeObjectUrl = "blob:http://localhost/fake-uuid";

      const createObjectURLMock = vi.fn(() => fakeObjectUrl);
      const revokeObjectURLMock = vi.fn();
      vi.stubGlobal("URL", {
        ...URL,
        createObjectURL: createObjectURLMock,
        revokeObjectURL: revokeObjectURLMock,
      });

      // Mock <a> click
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

      const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(fakeBlob),
        } as Response);
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useCargo(QUERY_ID), { wrapper });

      await act(async () => {
        await result.current.exportXlsx();
      });

      // Assert POST to /cargo/export
      const exportCall = fetchMock.mock.calls.find(([url]) =>
        url === `/api/queries/${QUERY_ID}/cargo/export`,
      );
      expect(exportCall).toBeTruthy();
      expect((exportCall![1] as RequestInit).method).toBe("POST");

      // Assert createObjectURL was called with the blob
      expect(createObjectURLMock).toHaveBeenCalledWith(fakeBlob);
      // Assert click was triggered
      expect(clickMock).toHaveBeenCalled();
      // Assert URL was revoked
      expect(revokeObjectURLMock).toHaveBeenCalledWith(fakeObjectUrl);

      vi.restoreAllMocks();
    });
  });
});
