// packages/shared/src/points.test.ts
import { describe, it, expect } from "vitest";
import {
  PointType,
  POINT_TYPES,
  WAREHOUSE_TYPES,
  pointSaveSchema,
  POINT_REQUIRED_FIELDS,
} from "./points";

describe("point vocabularies", () => {
  it("pins POINT_TYPES order (feeds Zod + Prisma enum)", () => {
    expect(POINT_TYPES).toEqual(["PICKUP", "DELIVERY", "WAREHOUSE", "AIRPORT", "SEAPORT"]);
  });
  it("pins WAREHOUSE_TYPES", () => {
    expect(WAREHOUSE_TYPES).toEqual(["CONSOLIDATION", "CROSS_DOCK", "TEMPORARY_STORAGE", "OTHER"]);
  });
});

describe("pointSaveSchema", () => {
  it("requires type", () => {
    expect(pointSaveSchema.safeParse({}).success).toBe(false);
  });
  it("accepts a partial draft point (type only)", () => {
    expect(pointSaveSchema.safeParse({ type: PointType.PICKUP }).success).toBe(true);
  });
  it("validates IATA format when present", () => {
    expect(pointSaveSchema.safeParse({ type: PointType.AIRPORT, iataCode: "bom" }).success).toBe(
      false,
    );
    expect(pointSaveSchema.safeParse({ type: PointType.AIRPORT, iataCode: "BOM" }).success).toBe(
      true,
    );
  });
  it("validates UN/LOCODE format when present", () => {
    expect(pointSaveSchema.safeParse({ type: PointType.SEAPORT, unLocode: "INNSA" }).success).toBe(
      true,
    );
    expect(
      pointSaveSchema.safeParse({ type: PointType.SEAPORT, unLocode: "TOOLONG" }).success,
    ).toBe(false);
  });
  it("rejects whitespace-only text fields (G8)", () => {
    expect(pointSaveSchema.safeParse({ type: PointType.PICKUP, name: "   " }).success).toBe(false);
    expect(pointSaveSchema.safeParse({ type: PointType.PICKUP, city: "  " }).success).toBe(false);
  });
});

describe("POINT_REQUIRED_FIELDS", () => {
  it("makes DELIVERY email optional but PICKUP email required", () => {
    expect(POINT_REQUIRED_FIELDS.PICKUP).toContain("contactEmail");
    expect(POINT_REQUIRED_FIELDS.DELIVERY).not.toContain("contactEmail");
  });
  it("requires the hub code for AIRPORT/SEAPORT", () => {
    expect(POINT_REQUIRED_FIELDS.AIRPORT).toContain("iataCode");
    expect(POINT_REQUIRED_FIELDS.SEAPORT).toContain("unLocode");
  });
});

describe("pointSaveSchema.contactPhone (strict E.164)", () => {
  it("rejects a phone without a leading +", () => {
    expect(pointSaveSchema.safeParse({ type: "PICKUP", contactPhone: "6591234567" }).success).toBe(false);
  });
  it("accepts a +-prefixed E.164 phone", () => {
    expect(pointSaveSchema.safeParse({ type: "PICKUP", contactPhone: "+6591234567" }).success).toBe(true);
  });
  it("allows contactPhone to be absent (draft)", () => {
    expect(pointSaveSchema.safeParse({ type: "PICKUP" }).success).toBe(true);
  });
});

describe("Point.timezone", () => {
  it("accepts a valid IANA timezone and rejects junk when present", () => {
    expect(pointSaveSchema.safeParse({ type: "PICKUP", timezone: "Asia/Kolkata" }).success).toBe(true);
    expect(pointSaveSchema.safeParse({ type: "PICKUP", timezone: "Bad/Zone" }).success).toBe(false);
  });
  it("marks timezone required for every point type", () => {
    for (const t of POINT_TYPES) expect(POINT_REQUIRED_FIELDS[t]).toContain("timezone");
  });
});
