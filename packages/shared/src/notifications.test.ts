import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_TYPES, ESCALATION_TIERS, EMAIL_TEMPLATES, EMAIL_STATUSES,
  TIER_ROLE, TIER_OFFSET_MS,
} from "./notifications";
import { Role } from "./role";

describe("notifications enums", () => {
  it("pins the enum arrays", () => {
    expect(NOTIFICATION_TYPES).toEqual(["ESCALATION"]);
    expect(ESCALATION_TIERS).toEqual(["T30M", "T2H", "T6H"]);
    expect(EMAIL_TEMPLATES).toEqual(["FOLLOW_UP", "ACKNOWLEDGEMENT", "ESCALATION"]);
    expect(EMAIL_STATUSES).toEqual(["LOGGED"]);
  });
  it("maps tier → role and offset", () => {
    expect(TIER_ROLE).toEqual({ T30M: Role.EXECUTIVE, T2H: Role.MANAGER, T6H: Role.ADMINISTRATOR });
    expect(TIER_OFFSET_MS).toEqual({ T30M: 30 * 60_000, T2H: 120 * 60_000, T6H: 360 * 60_000 });
  });
});
