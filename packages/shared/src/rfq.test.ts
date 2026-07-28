import { describe, it, expect } from "vitest";
import type { RfqDto, QuoteDto } from "./rfq";

describe("rfq DTOs", () => {
  it("shapes an Rfq and a Quote (compile-time contract)", () => {
    const rfq: RfqDto = {
      id: "r1", queryId: "q1", freightForwarderId: "f1", rfqNumber: "YAL26-0001-RFQ001",
      submissionDeadline: "2026-01-01T00:00:00Z", incoterms: "FOB", currency: null, quoteValidityUntil: null,
    };
    const quote: QuoteDto = {
      id: "u1", queryId: "q1", legId: "l1", freightForwarderId: "f1", rfqId: "r1",
      status: "RFQ_SENT", submittedAt: null,
    };
    expect(rfq.rfqNumber).toContain("RFQ");
    expect(quote.status).toBe("RFQ_SENT");
  });
});
