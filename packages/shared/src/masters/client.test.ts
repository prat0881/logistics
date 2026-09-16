import { describe, it, expect } from "vitest";
import { clientCreateSchema, clientUpdateSchema } from "./client";

const base = {
  companyName: "Acme",
  country: "AE",
  streetAddress: "1 Road",
  city: "Dubai",
};
const contact = {
  name: "Asha",
  email: "asha@example.com",
  contactNo: "+971501234567",
  pocLevel: "PRIMARY" as const,
};

describe("clientCreateSchema", () => {
  it("accepts a payload with exactly one primary contact", () => {
    expect(clientCreateSchema.safeParse({ ...base, contacts: [contact] }).success).toBe(true);
  });

  it("rejects a payload with no contacts at all", () => {
    expect(clientCreateSchema.safeParse({ ...base, contacts: [] }).success).toBe(false);
  });

  it("rejects a payload whose contacts have no primary", () => {
    expect(
      clientCreateSchema.safeParse({ ...base, contacts: [{ ...contact, pocLevel: "NONE" }] })
        .success,
    ).toBe(false);
  });

  it("rejects two primaries", () => {
    expect(
      clientCreateSchema.safeParse({ ...base, contacts: [contact, { ...contact, email: "b@x.com" }] })
        .success,
    ).toBe(false);
  });

  it("accepts optional warehouseIds", () => {
    const r = clientCreateSchema.safeParse({
      ...base,
      contacts: [contact],
      warehouseIds: ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    });
    expect(r.success).toBe(true);
  });
});

describe("clientUpdateSchema", () => {
  it("accepts a patch with no contacts key at all", () => {
    expect(clientUpdateSchema.safeParse({ companyName: "Renamed" }).success).toBe(true);
  });

  it("accepts a patch whose contacts have NO primary — the banner case, not a block", () => {
    expect(
      clientUpdateSchema.safeParse({ contacts: [{ ...contact, pocLevel: "NONE" }] }).success,
    ).toBe(true);
  });

  it("rejects a patch with two primaries", () => {
    expect(
      clientUpdateSchema.safeParse({ contacts: [contact, { ...contact, email: "b@x.com" }] })
        .success,
    ).toBe(false);
  });
});
