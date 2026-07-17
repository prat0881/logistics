import { describe, it, expect } from "vitest";
import { clientCreateSchema, vesselCreateSchema, VESSEL_TYPES, MASTER_STATUSES } from "./masters";

describe("masters schemas", () => {
  it("accepts a valid client (no code — server-minted)", () => {
    expect(clientCreateSchema.safeParse({ companyName: "Acme", country: "IN" }).success).toBe(true);
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
      }).success,
    ).toBe(true);
  });
  it("rejects a non-7-digit IMO", () => {
    expect(
      vesselCreateSchema.safeParse({ name: "MV Test", vesselType: "CONTAINER", imoNumber: "12" })
        .success,
    ).toBe(false);
  });
  it("rejects an unknown vessel type", () => {
    expect(vesselCreateSchema.safeParse({ name: "X", vesselType: "SUBMARINE" }).success).toBe(
      false,
    );
  });
  it("exposes the enum value lists", () => {
    expect(VESSEL_TYPES).toContain("CONTAINER");
    expect(MASTER_STATUSES).toEqual(["ACTIVE", "INACTIVE"]);
  });
});
