// packages/shared/src/legs.test.ts
import { describe, it, expect } from "vitest";
import { LEG_EXECUTION_STATUSES, legSaveSchema, formatLegCode } from "./legs";

describe("leg vocabularies", () => {
  it("pins LEG_EXECUTION_STATUSES", () => {
    expect(LEG_EXECUTION_STATUSES).toEqual(["PENDING", "IN_TRANSIT", "COMPLETED"]);
  });
});

describe("legSaveSchema", () => {
  it("accepts an empty partial leg", () => {
    expect(legSaveSchema.safeParse({}).success).toBe(true);
  });
  it("rejects a non-mode value", () => {
    expect(legSaveSchema.safeParse({ mode: "TRAIN" }).success).toBe(false);
  });
  it("accepts assignedCargoIds as uuids", () => {
    expect(
      legSaveSchema.safeParse({ assignedCargoIds: ["11111111-1111-1111-1111-111111111111"] })
        .success,
    ).toBe(true);
  });
});

describe("formatLegCode", () => {
  it("formats L1, L2, …", () => {
    expect(formatLegCode(1)).toBe("L1");
    expect(formatLegCode(12)).toBe("L12");
  });
});
