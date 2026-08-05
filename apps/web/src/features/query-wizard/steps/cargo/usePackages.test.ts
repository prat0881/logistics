import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { PackageDto } from "@svyft/shared";
import { usePackages } from "./usePackages";

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CARGO_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PACKAGE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const basePackageDto: PackageDto = {
  id: PACKAGE_ID,
  rowIndex: 0,
  packageNo: "PKG-001",
  packageType: "CARTON",
  dimL: "100",
  dimW: "50",
  dimH: "50",
  grossWt: "60",
  netWt: "50",
  volumeCbm: "0.25",
  tags: [],
  effectiveTags: [],
  msdsFileId: null,
  items: [],
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

const PACKAGES_URL = `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}/packages`;

afterEach(() => vi.unstubAllGlobals());

describe("usePackages", () => {
  describe("add()", () => {
    it("POSTs a PackageCreateInput to .../cargo/:cid/packages, invalidates the query cache, and returns the PackageDto", async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === PACKAGES_URL && init?.method === "POST") {
          return Promise.resolve(jsonResponse(basePackageDto, 201));
        }
        return Promise.resolve(jsonResponse({}));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => usePackages(QUERY_ID, CARGO_ID), { wrapper });

      let returned: PackageDto | undefined;
      await act(async () => {
        returned = await result.current.add({
          packageNo: "PKG-001",
          packageType: "CARTON",
          dimL: 100,
          dimW: 50,
          dimH: 50,
          grossWt: 60,
          netWt: 50,
        });
      });

      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => url === PACKAGES_URL && (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const sentBody = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(sentBody.packageNo).toBe("PKG-001");
      expect(sentBody.grossWt).toBe(60);
      expect(returned?.id).toBe(PACKAGE_ID);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["query", QUERY_ID] });

      invalidateSpy.mockRestore();
    });
  });

  describe("update()", () => {
    it("PATCHes .../packages/:pid with a PackageUpdateInput and invalidates the query cache", async () => {
      const updatedDto: PackageDto = { ...basePackageDto, grossWt: "65" };
      const url = `${PACKAGES_URL}/${PACKAGE_ID}`;
      const fetchMock = vi.fn((u: string, init?: RequestInit) => {
        if (u === url && init?.method === "PATCH") {
          return Promise.resolve(jsonResponse(updatedDto));
        }
        return Promise.resolve(jsonResponse({}));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => usePackages(QUERY_ID, CARGO_ID), { wrapper });

      let returned: PackageDto | undefined;
      await act(async () => {
        returned = await result.current.update(PACKAGE_ID, { grossWt: 65 });
      });

      const patchCall = fetchMock.mock.calls.find(
        ([u, init]) => u === url && (init as RequestInit)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const sentBody = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(sentBody.grossWt).toBe(65);
      expect(returned?.grossWt).toBe("65");
    });
  });

  describe("remove()", () => {
    it("DELETEs .../packages/:pid and invalidates the query cache", async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const url = `${PACKAGES_URL}/${PACKAGE_ID}`;
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
        return Promise.resolve(jsonResponse({}, 204));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => usePackages(QUERY_ID, CARGO_ID), { wrapper });

      await act(async () => {
        await result.current.remove(PACKAGE_ID);
      });

      const deleteCall = fetchMock.mock.calls.find(
        ([u, init]) => u === url && (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["query", QUERY_ID] });

      invalidateSpy.mockRestore();
    });
  });

  describe("uploadMsds()", () => {
    it("POSTs multipart form to .../packages/:pid/msds with a 'file' field and no Content-Type header", async () => {
      const updatedDto: PackageDto = { ...basePackageDto, msdsFileId: "file-123" };
      const url = `${PACKAGES_URL}/${PACKAGE_ID}/msds`;
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
        return Promise.resolve(jsonResponse(updatedDto));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => usePackages(QUERY_ID, CARGO_ID), { wrapper });

      const fakeFile = new File(["fake pdf content"], "msds.pdf", { type: "application/pdf" });
      let returned: PackageDto | undefined;
      await act(async () => {
        returned = await result.current.uploadMsds(PACKAGE_ID, fakeFile);
      });

      const msdsCall = fetchMock.mock.calls.find(([u]) => u === url);
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

  describe("copy()", () => {
    it("POSTs { count } to .../packages/:pid/copies, invalidates the query cache, and returns a PackageDto[]", async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const clones: PackageDto[] = [
        { ...basePackageDto, id: "dddddddd-dddd-dddd-dddd-dddddddddddd", packageNo: "PKG-001-2" },
        { ...basePackageDto, id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", packageNo: "PKG-001-3" },
      ];
      const url = `${PACKAGES_URL}/${PACKAGE_ID}/copies`;
      const fetchMock = vi.fn((u: string, init?: RequestInit) => {
        if (u === url && init?.method === "POST") {
          return Promise.resolve(jsonResponse(clones, 201));
        }
        return Promise.resolve(jsonResponse({}));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => usePackages(QUERY_ID, CARGO_ID), { wrapper });

      let returned: PackageDto[] | undefined;
      await act(async () => {
        returned = await result.current.copy(PACKAGE_ID, 2);
      });

      const copyCall = fetchMock.mock.calls.find(
        ([u, init]) => u === url && (init as RequestInit)?.method === "POST",
      );
      expect(copyCall).toBeTruthy();
      const sentBody = JSON.parse((copyCall![1] as RequestInit).body as string);
      expect(sentBody).toEqual({ count: 2 });
      expect(returned).toHaveLength(2);
      expect(returned?.[0]?.packageNo).toBe("PKG-001-2");
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["query", QUERY_ID] });

      invalidateSpy.mockRestore();
    });
  });
});
