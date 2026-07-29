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
  it("goes expired past the deadline", () => {
    const { result } = renderHook(() => useCountdown("2026-08-01T00:00:10.000Z"));
    expect(result.current.expired).toBe(false);
    act(() => { vi.advanceTimersByTime(11_000); });
    expect(result.current.expired).toBe(true);
    expect(result.current.text).toBe("Deadline passed");
  });
});
