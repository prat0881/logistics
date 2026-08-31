import { describe, expect, it } from "vitest";
import { contactCreateSchema, E164, POC_LEVELS } from "./contacts";

describe("POC levels", () => {
  it("exposes exactly three, primary first", () => {
    expect(POC_LEVELS).toEqual(["PRIMARY", "SECONDARY", "NONE"]);
  });
});

describe("E164", () => {
  it("accepts an international number", () => {
    expect(E164.test("+971501234567")).toBe(true);
  });

  it("rejects a number with no country code", () => {
    expect(E164.test("0501234567")).toBe(false);
  });

  it("rejects a country code starting with zero", () => {
    expect(E164.test("+0501234567")).toBe(false);
  });
});

describe("the nine-field contact schema", () => {
  // Task 4 makes email and phone mandatory, alongside the migration that makes that
  // true in the database, and adds the channel-availability + POC-level + status fields.
  it("defaults the channel-availability flags to false", () => {
    const parsed = contactCreateSchema.parse({
      name: "Asha Menon",
      email: "asha@example.com",
      contactNo: "+971501234567",
    });
    expect(parsed.whatsappAvailable).toBe(false);
    expect(parsed.wechatAvailable).toBe(false);
    expect(parsed.botimAvailable).toBe(false);
  });

  it("defaults pocLevel to NONE and status to ACTIVE", () => {
    const parsed = contactCreateSchema.parse({
      name: "Asha Menon",
      email: "asha@example.com",
      contactNo: "+971501234567",
    });
    expect(parsed.pocLevel).toBe("NONE");
    expect(parsed.status).toBe("ACTIVE");
  });

  it("rejects a contact with no email or phone", () => {
    expect(contactCreateSchema.safeParse({ name: "Asha Menon" }).success).toBe(false);
  });
});
