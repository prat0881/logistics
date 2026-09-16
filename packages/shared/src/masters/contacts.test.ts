import { describe, expect, it } from "vitest";
import { contactCreateSchema, E164, POC_LEVELS } from "./contacts";
import { contactUpsertSchema, exactlyOnePrimary, atMostOnePrimary } from "./contacts";

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

describe("contactUpsertSchema", () => {
  it("accepts an existing contact carrying an id", () => {
    const parsed = contactUpsertSchema.parse({
      id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      name: "Asha Menon",
      email: "asha@example.com",
      contactNo: "+971501234567",
    });
    expect(parsed.id).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(parsed.pocLevel).toBe("NONE"); // default applied on the output type
  });

  it("accepts a new contact with no id", () => {
    expect(
      contactUpsertSchema.safeParse({
        name: "New Person",
        email: "new@example.com",
        contactNo: "+971501234567",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid id", () => {
    expect(
      contactUpsertSchema.safeParse({
        id: "not-a-uuid",
        name: "X",
        email: "x@example.com",
        contactNo: "+971501234567",
      }).success,
    ).toBe(false);
  });
});

describe("primary-count predicates", () => {
  const at = (level: string) => ({ pocLevel: level as never });

  it("exactlyOnePrimary is true for exactly one", () => {
    expect(exactlyOnePrimary([at("PRIMARY"), at("SECONDARY")])).toBe(true);
  });
  it("exactlyOnePrimary is false for none", () => {
    expect(exactlyOnePrimary([at("SECONDARY"), at("NONE")])).toBe(false);
  });
  it("exactlyOnePrimary is false for two", () => {
    expect(exactlyOnePrimary([at("PRIMARY"), at("PRIMARY")])).toBe(false);
  });
  it("atMostOnePrimary allows zero", () => {
    expect(atMostOnePrimary([at("NONE")])).toBe(true);
  });
  it("atMostOnePrimary rejects two", () => {
    expect(atMostOnePrimary([at("PRIMARY"), at("PRIMARY")])).toBe(false);
  });
});
