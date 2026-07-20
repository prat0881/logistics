import { describe, it, expect } from "vitest";
import {
  Incoterms,
  INCOTERMS,
  Priority,
  PRIORITIES,
  querySaveSchema,
  collectCreateFindings,
  queryListQuerySchema,
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

  describe("F2: contactPhone (E.164) + imoNumber (7-digit) formats", () => {
    it("rejects a malformed contactPhone", () => {
      expect(querySaveSchema.safeParse({ contactPhone: "abc" }).success).toBe(false);
    });
    it("accepts a valid E.164 contactPhone", () => {
      expect(querySaveSchema.safeParse({ contactPhone: "+911234567890" }).success).toBe(true);
    });
    it("rejects a malformed imoNumber", () => {
      expect(querySaveSchema.safeParse({ imoNumber: "123" }).success).toBe(false);
    });
    it("accepts a valid 7-digit imoNumber", () => {
      expect(querySaveSchema.safeParse({ imoNumber: "1234567" }).success).toBe(true);
    });
  });

  describe("F3: ETA < ETB < ETD, incl. the ETA < ETD guard when ETB is absent", () => {
    it("accepts ETA < ETB < ETD", () => {
      expect(
        querySaveSchema.safeParse({
          eta: "2026-08-01T00:00:00.000Z",
          etb: "2026-08-05T00:00:00.000Z",
          etd: "2026-08-10T00:00:00.000Z",
        }).success,
      ).toBe(true);
    });
    it("rejects ETA >= ETB", () => {
      expect(
        querySaveSchema.safeParse({
          eta: "2026-08-05T00:00:00.000Z",
          etb: "2026-08-05T00:00:00.000Z",
          etd: "2026-08-10T00:00:00.000Z",
        }).success,
      ).toBe(false);
    });
    it("rejects ETB >= ETD", () => {
      expect(
        querySaveSchema.safeParse({
          eta: "2026-08-01T00:00:00.000Z",
          etb: "2026-08-10T00:00:00.000Z",
          etd: "2026-08-10T00:00:00.000Z",
        }).success,
      ).toBe(false);
    });
    it("rejects ETD before ETA when ETB is absent (transitive gap)", () => {
      expect(
        querySaveSchema.safeParse({
          eta: "2026-08-10T00:00:00.000Z",
          etd: "2026-08-01T00:00:00.000Z",
        }).success,
      ).toBe(false);
    });
  });

  describe("F4: responseDeadline not in the past", () => {
    it("rejects a past responseDeadline", () => {
      expect(
        querySaveSchema.safeParse({ responseDeadline: "2020-01-01T00:00:00.000Z" }).success,
      ).toBe(false);
    });
    it("accepts a future responseDeadline", () => {
      expect(
        querySaveSchema.safeParse({ responseDeadline: "2099-01-01T00:00:00.000Z" }).success,
      ).toBe(true);
    });
    it("accepts an absent responseDeadline", () => {
      expect(querySaveSchema.safeParse({}).success).toBe(true);
    });
  });
});

describe("queryListQuerySchema", () => {
  it("coerces page/pageSize and passes through filters", () => {
    const parsed = queryListQuerySchema.parse({
      q: "YAL26", status: "DRAFT", priority: "HIGH",
      freightMode: "SEA,ROAD", page: "2", pageSize: "25", sort: "updatedAt:desc",
    });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(25);
    expect(parsed.status).toBe("DRAFT");
    expect(parsed.freightMode).toBe("SEA,ROAD");
  });

  it("defaults page=1 pageSize=20 when omitted", () => {
    const parsed = queryListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
  });

  describe("freightMode validation", () => {
    it("accepts a single valid FreightMode", () => {
      expect(queryListQuerySchema.safeParse({ freightMode: "SEA" }).success).toBe(true);
      expect(queryListQuerySchema.safeParse({ freightMode: "AIR" }).success).toBe(true);
      expect(queryListQuerySchema.safeParse({ freightMode: "ROAD" }).success).toBe(true);
    });

    it("accepts a CSV of valid FreightModes", () => {
      expect(queryListQuerySchema.safeParse({ freightMode: "SEA,ROAD" }).success).toBe(true);
      expect(queryListQuerySchema.safeParse({ freightMode: "AIR,SEA,ROAD" }).success).toBe(true);
    });

    it("rejects an invalid FreightMode token with a descriptive error", () => {
      const result = queryListQuerySchema.safeParse({ freightMode: "TRUCK" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/freightMode must be/);
      }
    });

    it("rejects a CSV containing an invalid token", () => {
      const result = queryListQuerySchema.safeParse({ freightMode: "SEA,UNKNOWN" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/freightMode must be/);
      }
    });

    it("accepts undefined freightMode (optional)", () => {
      expect(queryListQuerySchema.safeParse({}).success).toBe(true);
    });
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
