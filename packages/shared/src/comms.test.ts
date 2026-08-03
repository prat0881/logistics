// packages/shared/src/comms.test.ts
import { describe, it, expect } from "vitest";
import {
  Channel, CHANNELS, MessageStatus, MESSAGE_STATUSES,
  COMMS_EVENTS, COMMS_EVENT_KEYS, renderTemplate,
  DEFAULT_RFQ_DEADLINE_HOURS, DEFAULT_RFQ_REMINDER_OFFSETS,
} from "./comms";

describe("comms vocabulary", () => {
  it("pins the channel + status arrays", () => {
    expect(CHANNELS).toEqual(["IN_APP", "EMAIL"]);
    expect(MESSAGE_STATUSES).toEqual(["LOGGED", "SENT", "FAILED"]);
    expect(Channel.EMAIL).toBe("EMAIL");
    expect(MessageStatus.LOGGED).toBe("LOGGED");
  });

  it("pins the known event keys", () => {
    expect(COMMS_EVENT_KEYS).toEqual([
      "query.follow_up", "query.acknowledgement", "query.escalation",
      "rfq.invitation", "rfq.updated", "rfq.reminder", "rfq.expiry",
      "rfq.submission_ack", "quote.received",
    ]);
    expect(COMMS_EVENTS["rfq.reminder"]).toContain("Deadline");
  });

  it("renders {{tokens}} and blanks unknowns", () => {
    expect(renderTemplate("RFQ {{RFQ_Number}} due {{Deadline}}", { RFQ_Number: "Q-1", Deadline: "Fri" }))
      .toBe("RFQ Q-1 due Fri");
    expect(renderTemplate("Hi {{Missing}}", {})).toBe("Hi ");
  });

  it("exposes scheduler defaults", () => {
    expect(DEFAULT_RFQ_DEADLINE_HOURS).toBe(48);
    expect(DEFAULT_RFQ_REMINDER_OFFSETS).toEqual([36, 24, 12, 6, 2]);
  });
});
