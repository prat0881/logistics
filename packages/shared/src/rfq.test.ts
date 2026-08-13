import { describe, it, expect } from "vitest";
import type { RfqDto, QuoteDto, ManifestSnapshotCargo } from "./rfq";

describe("rfq DTOs", () => {
  it("shapes an Rfq and a Quote (compile-time contract)", () => {
    const rfq: RfqDto = {
      id: "r1",
      queryId: "q1",
      freightForwarderId: "f1",
      rfqNumber: "YAL26-0001-RFQ001",
      submissionDeadline: "2026-01-01T00:00:00Z",
      incoterms: "FOB",
      currency: null,
      quoteValidityUntil: null,
    };
    const quote: QuoteDto = {
      id: "u1",
      queryId: "q1",
      legId: "l1",
      freightForwarderId: "f1",
      rfqId: "r1",
      status: "RFQ_SENT",
      submittedAt: null,
    };
    expect(rfq.rfqNumber).toContain("RFQ");
    expect(quote.status).toBe("RFQ_SENT");
  });
});

describe("ManifestSnapshotCargo (per-package)", () => {
  it("has the package-grain fields and no flat cargo-item fields", () => {
    const c: ManifestSnapshotCargo = {
      packageId: "p1",
      packageNo: "V-1",
      packageType: "PALLET",
      packageCount: 1,
      dimL: "120",
      dimW: "80",
      dimH: "100",
      netWt: "90",
      grossWt: "100",
      volumeCbm: "0.96",
      tags: ["DG"],
    };
    expect(c.tags).toContain("DG");
    // @ts-expect-error — flat CargoItem fields are gone
    const _bad: ManifestSnapshotCargo = { ...c, isDangerous: true, qty: 3, productName: "x" };
    void _bad;
  });
});
