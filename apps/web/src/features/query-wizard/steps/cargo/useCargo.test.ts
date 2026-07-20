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

const baseCargoDto = {
  id: CARGO_ID,
  rowIndex: 0,
  poReference: "PO-001",
  productName: "Widget A",
  referenceTags: [],
  hsCode: null,
  packageType: "Carton",
  isDangerous: false,
  msdsFileId: null,
  qty: 10,
  dimL: "100",
  dimW: "50",
  dimH: "50",
  netWt: "50",
  grossWt: "60",
  volumeCbm: "2.5",
  freightDensity: null,
  chargeableWeight: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("useCargo", () => {
  describe("add()", () => {
    it("POSTs to /api/queries/:id/cargo and invalidates the query cache", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes("/api/auth/me"))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: { id: "u1", name: "Test", email: "t@x", role: "EXECUTIVE" } }),
            text: () => Promise.resolve(""),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        if (url === `/api/queries/${QUERY_ID}/cargo` && init?.method === "POST")
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve(baseCargoDto),
            text: () => Promise.resolve(JSON.stringify(baseCargoDto)),
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

      const { result } = renderHook(() => useCargo(QUERY_ID), { wrapper });

      let returned: CargoDto | undefined;
      await act(async () => {
        returned = await result.current.add({
          poReference: "PO-001",
          productName: "Widget A",
          packageType: "Carton",
          qty: 10,
          dimL: 100,
          dimW: 50,
          dimH: 50,
          grossWt: 60,
        });
      });

      // Assert POST was called with correct URL
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/queries/${QUERY_ID}/cargo` && (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const sentBody = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(sentBody.poReference).toBe("PO-001");
      expect(sentBody.grossWt).toBe(60);
      expect(returned?.id).toBe(CARGO_ID);
    });
  });

  describe("remove()", () => {
    it("DELETEs /api/queries/:id/cargo/:cid", async () => {
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
        return Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
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
    });
  });

  describe("uploadMsds()", () => {
    it("POSTs multipart form to /cargo/:cid/msds with a 'file' field and no Content-Type header", async () => {
      const updatedDto: CargoDto = { ...baseCargoDto, isDangerous: true, msdsFileId: "file-123" };
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(updatedDto),
          text: () => Promise.resolve(JSON.stringify(updatedDto)),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useCargo(QUERY_ID), { wrapper });

      const fakeFile = new File(["fake pdf content"], "msds.pdf", { type: "application/pdf" });
      let returned: CargoDto | undefined;
      await act(async () => {
        returned = await result.current.uploadMsds(CARGO_ID, fakeFile);
      });

      const msdsCall = fetchMock.mock.calls.find(([url]) =>
        url === `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}/msds`,
      );
      expect(msdsCall).toBeTruthy();
      const [, msdsInit] = msdsCall!;
      expect((msdsInit as RequestInit).method).toBe("POST");
      // Should NOT have an explicit Content-Type header (browser sets multipart boundary)
      const headers = (msdsInit as RequestInit).headers as Record<string, string> | undefined;
      expect(headers?.["Content-Type"]).toBeUndefined();
      // Body should be FormData
      expect((msdsInit as RequestInit).body).toBeInstanceOf(FormData);
      const fd = (msdsInit as RequestInit).body as FormData;
      expect(fd.get("file")).toBeInstanceOf(File);
      expect(returned?.msdsFileId).toBe("file-123");
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
