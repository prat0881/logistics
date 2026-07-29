import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCountdown } from "./useCountdown";

beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-08-01T00:00:00.000Z")));
afterEach(() => vi.useRealTimers());

describe("useCountdown", () => {
  it("tiers by remaining time", () => {
    expect(renderHook(() => useCountdown("2026-08-03T00:00:00.000Z")).result.current.tier).toBe("calm");   // 48h
    expect(renderHook(() => useCountdown("2026-08-01T18:00:00.000Z")).result.current.tier).toBe("warning"); // 18h
    expect(renderHook(() => useCountdown("2026-08-01T06:00:00.000Z")).result.current.tier).toBe("urgent");  // 6h
  });
  it("formats days/hours/minutes", () => {
    expect(renderHook(() => useCountdown("2026-08-03T14:03:00.000Z")).result.current.text).toBe("2d 14h 03m");
  });
  it("tier exact boundaries (calm=24h, warning=12h, urgent<12h)", () => {
    expect(renderHook(() => useCountdown("2026-08-02T00:00:00.000Z")).result.current.tier).toBe("calm");    // exactly 24h
    expect(renderHook(() => useCountdown("2026-08-01T12:00:00.000Z")).result.current.tier).toBe("warning"); // exactly 12h
    expect(renderHook(() => useCountdown("2026-08-01T11:59:59.000Z")).result.current.tier).toBe("urgent"); // just under 12h
  });
  it("formats sub-1h as MMm SSs", () => {
    const { result } = renderHook(() => useCountdown("2026-08-01T00:03:12.000Z"));
    expect(result.current.text).toBe("03m 12s");
    expect(result.current.tier).toBe("urgent");
  });
  it("goes expired past the deadline", () => {
    const { result } = renderHook(() => useCountdown("2026-08-01T00:00:10.000Z"));
    expect(result.current.expired).toBe(false);
    act(() => { vi.advanceTimersByTime(11_000); });
    expect(result.current.expired).toBe(true);
    expect(result.current.text).toBe("Deadline passed");
  });
});
