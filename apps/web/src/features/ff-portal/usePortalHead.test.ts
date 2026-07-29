import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { usePortalHead } from "./usePortalHead";

afterEach(() => {
  cleanup();
  // Clean up any meta tags injected by the hook
  document.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
  document.title = "";
});

describe("usePortalHead", () => {
  it("sets document.title to the provided title", () => {
    renderHook(() => usePortalHead("X"));
    expect(document.title).toBe("X");
  });

  it("injects a <meta name='robots' content='noindex'> tag", () => {
    renderHook(() => usePortalHead("X"));
    const meta = document.querySelector('meta[name="robots"]');
    expect(meta).not.toBeNull();
    expect(meta?.getAttribute("content")).toBe("noindex");
  });

  it("restores the previous document.title and removes meta on unmount", () => {
    const prevTitle = "Previous Title";
    document.title = prevTitle;

    const { unmount } = renderHook(() => usePortalHead("New Title"));
    expect(document.title).toBe("New Title");

    unmount();
    expect(document.title).toBe(prevTitle);
    const meta = document.querySelector('meta[name="robots"]');
    expect(meta).toBeNull();
  });
});
