import { describe, it, expect } from "vitest";
import { clientCreateSchema, vesselCreateSchema, MASTER_STATUSES, contactCreateSchema, freightForwarderCreateSchema } from "./masters";

describe("masters schemas", () => {
  it("accepts a valid client (no code — server-minted)", () => {
    expect(
      clientCreateSchema.safeParse({
        companyName: "Acme",
        country: "IN",
        streetAddress: "1 Raffles Place",
        city: "Singapore",
        contacts: [
          {
            name: "Asha Menon",
            email: "asha@example.com",
            contactNo: "+971501234567",
            pocLevel: "PRIMARY",
          },
        ],
      }).success,
    ).toBe(true);
  });
  it("rejects a client with no companyName", () => {
    expect(clientCreateSchema.safeParse({ country: "IN" }).success).toBe(false);
  });
  it("accepts a vessel with a 7-digit IMO", () => {
    expect(
      vesselCreateSchema.safeParse({
        name: "MV Test",
        vesselType: "CONTAINER",
        imoNumber: "1234567",
        shippingLine: "Maersk",
      }).success,
    ).toBe(true);
  });
  it("rejects a non-7-digit IMO", () => {
    expect(
      vesselCreateSchema.safeParse({ name: "MV Test", vesselType: "CONTAINER", imoNumber: "12" })
        .success,
    ).toBe(false);
  });
  it("accepts an arbitrary vessel type string (no longer a fixed enum)", () => {
    expect(
      vesselCreateSchema.safeParse({
        name: "X",
        vesselType: "SUBMARINE",
        imoNumber: "1234567",
        shippingLine: "Maersk",
      }).success,
    ).toBe(true);
  });
  it("exposes the status value list", () => {
    expect(MASTER_STATUSES).toEqual(["ACTIVE", "INACTIVE"]);
  });
});

describe("contactCreateSchema.contactNo (strict E.164)", () => {
  it("rejects a non-E.164 contactNo", () => {
    expect(
      contactCreateSchema.safeParse({ name: "A", email: "a@example.com", contactNo: "6591234567" })
        .success,
    ).toBe(false);
  });
  it("accepts a +-prefixed E.164 contactNo", () => {
    expect(
      contactCreateSchema.safeParse({ name: "A", email: "a@example.com", contactNo: "+6591234567" })
        .success,
    ).toBe(true);
  });
  it("no longer allows contactNo (or email) to be omitted", () => {
    expect(contactCreateSchema.safeParse({ name: "A" }).success).toBe(false);
  });
});

const validFf = {
  companyName: "Acme Freight",
  companyAddress: "1 Cargo Way",
  city: "Singapore",
  country: "Singapore",
  pic: "Jane Doe",
  contactNumber: "+15551234567",
  email: "ops@acme.example",
  availableCountries: ["US", "SG"],
  modes: ["AIR", "SEA"],
};

describe("freightForwarderCreateSchema", () => {
  it("accepts a valid FF with the required fields", () => {
    expect(freightForwarderCreateSchema.safeParse(validFf).success).toBe(true);
  });
  it("rejects a missing companyName", () => {
    expect(freightForwarderCreateSchema.safeParse({ ...validFf, companyName: undefined }).success).toBe(
      false,
    );
  });
  it("rejects an empty modes array", () => {
    expect(freightForwarderCreateSchema.safeParse({ ...validFf, modes: [] }).success).toBe(false);
  });
  it("rejects a non-E.164 phone", () => {
    expect(
      freightForwarderCreateSchema.safeParse({ ...validFf, contactNumber: "5551234567" }).success,
    ).toBe(false);
  });
  it("rejects an unknown mode", () => {
    expect(freightForwarderCreateSchema.safeParse({ ...validFf, modes: ["PLANE"] }).success).toBe(
      false,
    );
  });
  it("keeps optional address fields on the parsed output", () => {
    const parsed = freightForwarderCreateSchema.safeParse({
      ...validFf,
      companyAddress: "1 Cargo Way",
      city: "Singapore",
      postalCode: "049145",
      country: "Singapore",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.city).toBe("Singapore");
      expect(parsed.data.postalCode).toBe("049145");
      expect(parsed.data.country).toBe("Singapore");
    }
  });
  it("rejects a country longer than 120 chars", () => {
    expect(
      freightForwarderCreateSchema.safeParse({ ...validFf, country: "x".repeat(121) }).success,
    ).toBe(false);
  });
});
