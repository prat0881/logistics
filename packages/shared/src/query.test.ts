import { describe, it, expect } from "vitest";
import {
  Incoterms,
  INCOTERMS,
  Priority,
  PRIORITIES,
  querySaveSchema,
  collectCreateFindings,
} from "./query";

describe("Query vocabularies", () => {
  it("pins the 11 Incoterms", () => {
    expect(INCOTERMS).toEqual([
      "EXW",
      "FCA",
      "FAS",
      "FOB",
      "CFR",
      "CIF",
      "CPT",
      "CIP",
      "DAP",
      "DPU",
      "DDP",
    ]);
  });
  it("pins priorities", () => {
    expect(PRIORITIES).toEqual(["LOW", "MEDIUM", "HIGH", "URGENT"]);
  });
});

describe("querySaveSchema (draft — lenient, format-validated)", () => {
  it("accepts an empty draft patch", () => {
    expect(querySaveSchema.safeParse({}).success).toBe(true);
  });
  it("validates email + incoterms when present", () => {
    expect(querySaveSchema.safeParse({ contactEmail: "not-email" }).success).toBe(false);
    expect(querySaveSchema.safeParse({ incoterms: "ZZZ" }).success).toBe(false);
    expect(
      querySaveSchema.safeParse({ incoterms: Incoterms.FOB, priority: Priority.HIGH }).success,
    ).toBe(true);
  });
  it("rejects a shipmentDescription over 200 chars", () => {
    expect(querySaveSchema.safeParse({ shipmentDescription: "x".repeat(201) }).success).toBe(false);
  });
});

describe("collectCreateFindings (F1 mandatory + F6 DG→MSDS; route rules are Plan 5)", () => {
  const ready = {
    id: "q1",
    clientId: "c1",
    contactName: "Jo",
    contactEmail: "jo@acme.test",
    contactPhone: "+911234567890",
    readyDate: new Date(),
    targetDelivery: new Date(),
    incoterms: "FOB" as const,
  };
  it("returns no findings when all mandatory fields present + no DG cargo", () => {
    expect(collectCreateFindings(ready, [])).toEqual([]);
  });
  it("flags each missing mandatory field with rule F1", () => {
    const f = collectCreateFindings({ ...ready, clientId: null, incoterms: null }, []);
    expect(f.map((x) => x.rule)).toEqual(["F1", "F1"]);
    expect(f.every((x) => x.severity === "blocking")).toBe(true);
  });
  it("flags a DG cargo row missing its MSDS with rule F6", () => {
    const f = collectCreateFindings(ready, [
      { id: "cg1", isDangerous: true, msdsFileId: null, poReference: "PO-9" },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      rule: "F6",
      severity: "blocking",
      scope: { type: "cargo", id: "cg1" },
    });
  });
});
