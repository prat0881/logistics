import { describe, it, expect } from "vitest";
import { loginSchema } from "./auth";
import { Role, ROLES } from "./role";

describe("loginSchema", () => {
  it("accepts a valid email + non-empty password", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "secret" }).success).toBe(true);
  });
  it("rejects an invalid email", () => {
    expect(loginSchema.safeParse({ email: "nope", password: "secret" }).success).toBe(false);
  });
  it("rejects an empty password", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
  });
});

describe("Role", () => {
  it("exposes the three fixed roles", () => {
    expect(ROLES).toEqual([Role.EXECUTIVE, Role.MANAGER, Role.ADMINISTRATOR]);
  });
});
