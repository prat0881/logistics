import { describe, it, expect, vi, afterEach } from "vitest";
import { copyToClipboard } from "./clipboard";

afterEach(() => vi.restoreAllMocks());

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

describe("copyToClipboard", () => {
  it("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await copyToClipboard("http://x/ff/rfq/T")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("http://x/ff/rfq/T");
  });

  it("falls back to execCommand when clipboard is unavailable (HTTP)", async () => {
    setClipboard(undefined);
    // jsdom 25 does not implement execCommand — define it before spying
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => false,
    });
    const exec = vi.spyOn(document, "execCommand").mockReturnValue(true);
    expect(await copyToClipboard("y")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("returns false when both paths fail", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: () => false,
    });
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    expect(await copyToClipboard("z")).toBe(false);
  });
});
