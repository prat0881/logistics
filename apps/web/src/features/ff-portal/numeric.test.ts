// numeric.test.ts
import { describe, it, expect } from "vitest";
import { toNumOrNull } from "./numeric";

describe("toNumOrNull", () => {
  it("maps empty/nullish to null", () => {
    for (const v of ["", null, undefined]) expect(toNumOrNull(v)).toBeNull();
  });
  it("parses numeric strings and passes numbers through", () => {
    expect(toNumOrNull("12.5")).toBe(12.5);
    expect(toNumOrNull(0)).toBe(0);
  });
  it("maps non-finite to null", () => {
    expect(toNumOrNull("abc")).toBeNull();
    expect(toNumOrNull(NaN)).toBeNull();
  });
});
