import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useViewMode } from "./useViewMode";

const KEY = "svyft.compare.viewMode";

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useViewMode", () => {
  it("defaults to columns when nothing is stored", () => {
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("columns");
  });

  it("reads a previously-stored 'rows' preference on mount", () => {
    localStorage.setItem(KEY, "rows");
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("rows");
  });

  it("treats any stored value other than 'rows' as columns", () => {
    localStorage.setItem(KEY, "garbage");
    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("columns");
  });

  it("setting the mode updates the returned state AND persists it", () => {
    const { result } = renderHook(() => useViewMode());

    act(() => result.current[1]("rows"));
    expect(result.current[0]).toBe("rows");
    expect(localStorage.getItem(KEY)).toBe("rows");

    act(() => result.current[1]("columns"));
    expect(result.current[0]).toBe("columns");
    expect(localStorage.getItem(KEY)).toBe("columns");
  });

  it("a fresh mount picks up the persisted preference from a prior mount", () => {
    const first = renderHook(() => useViewMode());
    act(() => first.result.current[1]("rows"));
    first.unmount();

    const second = renderHook(() => useViewMode());
    expect(second.result.current[0]).toBe("rows");
  });

  // ── private-mode / storage-disabled browsers must not crash the screen ────────────────────
  it("falls back to columns, without throwing, when localStorage.getItem throws on mount", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    let result: ReturnType<typeof useViewMode> | undefined;
    expect(() => {
      const hook = renderHook(() => useViewMode());
      result = hook.result.current;
    }).not.toThrow();

    expect(result?.[0]).toBe("columns");
  });

  it("still updates in-memory state, without throwing, when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    const { result } = renderHook(() => useViewMode());
    expect(result.current[0]).toBe("columns");

    expect(() => act(() => result.current[1]("rows"))).not.toThrow();
    // The setter is best-effort about persistence, but the returned state must still flip — a
    // user in a storage-disabled browser can still toggle views for the current page view.
    expect(result.current[0]).toBe("rows");
  });
});
