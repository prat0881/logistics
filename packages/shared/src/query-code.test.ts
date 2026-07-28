import { describe, it, expect } from "vitest";
import { formatQueryCode } from "./query-code";
import { formatRfqNumber } from "./query-code";

describe("formatQueryCode", () => {
  it("formats year + zero-padded 4-digit sequence", () => {
    expect(formatQueryCode(2026, 42)).toBe("YAL26-0042");
  });
  it("uses the last two digits of the year", () => {
    expect(formatQueryCode(2030, 1)).toBe("YAL30-0001");
  });
  it("does not truncate sequences beyond 4 digits", () => {
    expect(formatQueryCode(2026, 12345)).toBe("YAL26-12345");
  });
});

describe("formatRfqNumber", () => {
  it("appends a zero-padded RFQ sequence to the query code", () => {
    expect(formatRfqNumber("YAL26-0001", 1)).toBe("YAL26-0001-RFQ001");
    expect(formatRfqNumber("YAL26-0042", 12)).toBe("YAL26-0042-RFQ012");
  });
});
