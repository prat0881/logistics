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

describe("the moved contact schema", () => {
  // Task 1 moves this schema; it does not change it. Task 4 makes email and phone
  // mandatory, alongside the migration that makes that true in the database. These two
  // assertions exist to catch an accidental tightening here.
  it("still treats email and phone as optional", () => {
    expect(contactCreateSchema.safeParse({ name: "Asha Menon" }).success).toBe(true);
  });

  it("still validates a supplied phone number as E.164", () => {
    expect(contactCreateSchema.safeParse({ name: "Asha", contactNo: "0501234567" }).success).toBe(false);
  });
});
