import { describe, it, expect } from "vitest";
import {
  Incoterms,
  INCOTERMS,
  Priority,
  PRIORITIES,
  querySaveSchema,
  collectCreateFindings,
  queryListQuerySchema,
  defaultResponseDeadline,
  RESPONSE_DEADLINE_HOURS,
} from "./query";

describe("Query vocabularies", () => {
  it("pins the 12 Incoterms", () => {
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
      "N/A",
    ]);
  });
  it("accepts N/A as a valid incoterms value", () => {
    expect(querySaveSchema.safeParse({ incoterms: "N/A" }).success).toBe(true);
  });
  it("pins priorities", () => {
    expect(PRIORITIES).toEqual(["LOW", "MEDIUM", "HIGH", "URGENT"]);
  });
  it("pins the response-deadline hour map", () => {
    expect(RESPONSE_DEADLINE_HOURS).toEqual({ LOW: 48, MEDIUM: 24, HIGH: 18, URGENT: 12 });
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
    it("rejects a contactPhone without a leading +", () => {
      expect(querySaveSchema.safeParse({ contactPhone: "911234567890" }).success).toBe(false);
    });
    it("accepts a valid E.164 contactPhone with +", () => {
      expect(querySaveSchema.safeParse({ contactPhone: "+911234567890" }).success).toBe(true);
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

  describe("readyDate ≤ targetDelivery (G10)", () => {
    it("rejects a readyDate after targetDelivery", () => {
      expect(
        querySaveSchema.safeParse({
          readyDate: "2026-08-10T00:00:00.000Z",
          targetDelivery: "2026-08-01T00:00:00.000Z",
        }).success,
      ).toBe(false);
    });
    it("accepts readyDate before or equal to targetDelivery", () => {
      expect(
        querySaveSchema.safeParse({
          readyDate: "2026-08-01T00:00:00.000Z",
          targetDelivery: "2026-08-10T00:00:00.000Z",
        }).success,
      ).toBe(true);
      expect(
        querySaveSchema.safeParse({
          readyDate: "2026-08-01T00:00:00.000Z",
          targetDelivery: "2026-08-01T00:00:00.000Z",
        }).success,
      ).toBe(true);
    });
    it("accepts when only one of the two dates is present", () => {
      expect(querySaveSchema.safeParse({ readyDate: "2026-08-01T00:00:00.000Z" }).success).toBe(
        true,
      );
      expect(
        querySaveSchema.safeParse({ targetDelivery: "2026-08-01T00:00:00.000Z" }).success,
      ).toBe(true);
    });
  });

  describe("trims required text + rejects whitespace-only (G8)", () => {
    it("rejects a whitespace-only contactName", () => {
      expect(querySaveSchema.safeParse({ contactName: "   " }).success).toBe(false);
    });
    it("trims surrounding whitespace on contactName", () => {
      const r = querySaveSchema.safeParse({ contactName: "  Jo  " });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.contactName).toBe("Jo");
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

  it("defaults page=1 pageSize=10 when omitted", () => {
    const parsed = queryListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(10);
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

  describe("dateFrom ≤ dateTo (G11)", () => {
    it("rejects an inverted date range", () => {
      expect(
        queryListQuerySchema.safeParse({
          dateFrom: "2026-08-10T00:00:00.000Z",
          dateTo: "2026-08-01T00:00:00.000Z",
        }).success,
      ).toBe(false);
    });
    it("accepts a valid range and single-sided ranges", () => {
      expect(
        queryListQuerySchema.safeParse({
          dateFrom: "2026-08-01T00:00:00.000Z",
          dateTo: "2026-08-10T00:00:00.000Z",
        }).success,
      ).toBe(true);
      expect(queryListQuerySchema.safeParse({ dateFrom: "2026-08-01T00:00:00.000Z" }).success).toBe(
        true,
      );
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
  it("treats a whitespace-only contactName as missing (F1) (G8)", () => {
    const f = collectCreateFindings({ ...ready, contactName: "   " }, []);
    expect(f.map((x) => x.rule)).toEqual(["F1"]);
  });
  it("emits the incoterms finding with a field/incoterms scope (buckets to Shipment)", () => {
    const findings = collectCreateFindings(
      { id: "q1", clientId: "c", contactName: "n", contactEmail: "e@x.com", contactPhone: "+6591234567", readyDate: "2026-08-01T00:00:00Z", targetDelivery: "2026-08-02T00:00:00Z", incoterms: null },
      [],
    );
    const inco = findings.find((f) => f.message === "Incoterms is required");
    expect(inco?.scope).toEqual({ type: "field", id: "incoterms" });
  });
});

describe("defaultResponseDeadline (priority → deadline offset)", () => {
  it("adds 24h for MEDIUM", () => {
    const out = defaultResponseDeadline("2026-07-22T09:00:00.000Z", "MEDIUM");
    expect(new Date(out).getTime()).toBe(new Date("2026-07-23T09:00:00.000Z").getTime());
  });
  it("adds 48/18/12h for LOW/HIGH/URGENT", () => {
    const base = "2026-07-22T00:00:00.000Z";
    const t = (p: "LOW" | "HIGH" | "URGENT") => new Date(defaultResponseDeadline(base, p)).getTime();
    expect(t("LOW")).toBe(new Date("2026-07-24T00:00:00.000Z").getTime());
    expect(t("HIGH")).toBe(new Date("2026-07-22T18:00:00.000Z").getTime());
    expect(t("URGENT")).toBe(new Date("2026-07-22T12:00:00.000Z").getTime());
  });
});
