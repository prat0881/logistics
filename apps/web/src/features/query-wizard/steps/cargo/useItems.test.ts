import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { ItemDto } from "@svyft/shared";
import { useItems } from "./useItems";

const QUERY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CARGO_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PACKAGE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ITEM_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const baseItemDto: ItemDto = {
  id: ITEM_ID,
  rowIndex: 0,
  product: "Widget A",
  qty: "10",
  uom: "PC",
  hsCode: null,
  tags: [],
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

const ITEMS_URL = `/api/queries/${QUERY_ID}/cargo/${CARGO_ID}/packages/${PACKAGE_ID}/items`;

afterEach(() => vi.unstubAllGlobals());

describe("useItems", () => {
  describe("add()", () => {
    it("POSTs an ItemCreateInput to .../packages/:pid/items, invalidates the query cache, and returns the ItemDto", async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === ITEMS_URL && init?.method === "POST") {
          return Promise.resolve(jsonResponse(baseItemDto, 201));
        }
        return Promise.resolve(jsonResponse({}));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useItems(QUERY_ID, CARGO_ID, PACKAGE_ID), { wrapper });

      let returned: ItemDto | undefined;
      await act(async () => {
        returned = await result.current.add({ product: "Widget A", qty: 10, uom: "PC" });
      });

      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => url === ITEMS_URL && (init as RequestInit)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const sentBody = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(sentBody.product).toBe("Widget A");
      expect(sentBody.qty).toBe(10);
      expect(sentBody.uom).toBe("PC");
      expect(returned?.id).toBe(ITEM_ID);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["query", QUERY_ID] });

      invalidateSpy.mockRestore();
    });
  });

  describe("update()", () => {
    it("PATCHes .../items/:iid with an ItemUpdateInput and invalidates the query cache", async () => {
      const updatedDto: ItemDto = { ...baseItemDto, qty: "12" };
      const url = `${ITEMS_URL}/${ITEM_ID}`;
      const fetchMock = vi.fn((u: string, init?: RequestInit) => {
        if (u === url && init?.method === "PATCH") {
          return Promise.resolve(jsonResponse(updatedDto));
        }
        return Promise.resolve(jsonResponse({}));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useItems(QUERY_ID, CARGO_ID, PACKAGE_ID), { wrapper });

      let returned: ItemDto | undefined;
      await act(async () => {
        returned = await result.current.update(ITEM_ID, { qty: 12 });
      });

      const patchCall = fetchMock.mock.calls.find(
        ([u, init]) => u === url && (init as RequestInit)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const sentBody = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(sentBody.qty).toBe(12);
      expect(returned?.qty).toBe("12");
    });
  });

  describe("remove()", () => {
    it("DELETEs .../items/:iid and invalidates the query cache", async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const url = `${ITEMS_URL}/${ITEM_ID}`;
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
        return Promise.resolve(jsonResponse({}, 204));
      });

      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useItems(QUERY_ID, CARGO_ID, PACKAGE_ID), { wrapper });

      await act(async () => {
        await result.current.remove(ITEM_ID);
      });

      const deleteCall = fetchMock.mock.calls.find(
        ([u, init]) => u === url && (init as RequestInit)?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["query", QUERY_ID] });

      invalidateSpy.mockRestore();
    });
  });
});
