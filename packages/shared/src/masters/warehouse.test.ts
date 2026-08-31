import { describe, expect, it } from "vitest";
import { warehouseCreateSchema, warehouseUpdateSchema } from "./warehouse";

const base = {
  name: "Jebel Ali DC1",
  type: "CLIENT" as const,
  streetAddress: "Plot 12",
  country: "United Arab Emirates",
  city: "Dubai",
  pinCode: "00000",
  capacity: 5000,
  capacityUnit: "CBM" as const,
  contacts: [
    {
      name: "Asha Menon",
      email: "asha@example.com",
      contactNo: "+971501234567",
      pocLevel: "PRIMARY" as const,
    },
  ],
};

describe("warehouseCreateSchema", () => {
  it("accepts a client warehouse with no contract or rate fields", () => {
    expect(warehouseCreateSchema.safeParse(base).success).toBe(true);
  });

  it("requires agreement and insurance dates on an owned warehouse", () => {
    const result = warehouseCreateSchema.safeParse({ ...base, type: "OWNED" });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path[0]);
    expect(paths).toContain("agreementValidUntil");
    expect(paths).toContain("insuranceValidUntil");
  });

  it("requires a currency once a handling rate is given", () => {
    const result = warehouseCreateSchema.safeParse({ ...base, handlingRate: 25, handlingUnit: "PER_PALLET" });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path[0]);
    expect(paths).toContain("rateCurrency");
  });

  it("defaults free storage days to 0", () => {
    expect(warehouseCreateSchema.parse(base).freeStorageDays).toBe(0);
  });

  it("rejects a payload whose contacts have two primaries", () => {
    const result = warehouseCreateSchema.safeParse({
      ...base,
      contacts: [base.contacts[0], { ...base.contacts[0], email: "b@example.com" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("warehouseUpdateSchema", () => {
  it("accepts a patch with no contacts key at all", () => {
    expect(warehouseUpdateSchema.safeParse({ name: "Renamed DC" }).success).toBe(true);
  });

  it("accepts a patch whose contacts have NO primary — the banner case, not a block", () => {
    expect(
      warehouseUpdateSchema.safeParse({
        contacts: [{ ...base.contacts[0], pocLevel: "NONE" }],
      }).success,
    ).toBe(true);
  });

  it("rejects a patch with two primaries", () => {
    expect(
      warehouseUpdateSchema.safeParse({
        contacts: [base.contacts[0], { ...base.contacts[0], email: "b@example.com" }],
      }).success,
    ).toBe(false);
  });
});
