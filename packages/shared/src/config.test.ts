import { describe, it, expect } from "vitest";
import { ORG_TIMEZONE_KEY, DEFAULT_ORG_TIMEZONE, orgTimezoneUpdateSchema } from "./config";

describe("org timezone config", () => {
  it("pins the setting key + default", () => {
    expect(ORG_TIMEZONE_KEY).toBe("orgDefaultTimezone");
    expect(DEFAULT_ORG_TIMEZONE).toBe("Asia/Kolkata");
  });
  it("accepts a valid IANA zone and rejects junk", () => {
    expect(orgTimezoneUpdateSchema.safeParse({ timezone: "Asia/Singapore" }).success).toBe(true);
    expect(orgTimezoneUpdateSchema.safeParse({ timezone: "Nope/Zone" }).success).toBe(false);
    expect(orgTimezoneUpdateSchema.safeParse({}).success).toBe(false);
  });
});
