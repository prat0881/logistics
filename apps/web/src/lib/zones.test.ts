// apps/web/src/lib/zones.test.ts
import { describe, it, expect } from "vitest";
import { resolveQueryFieldZone, resolveLegFieldZone } from "./zones";

const ORG = "Asia/Kolkata";
const sea = { id: "s1", type: "SEAPORT", timezone: "Asia/Singapore" };
const air = { id: "a1", type: "AIRPORT", timezone: "Europe/London" };

describe("resolveQueryFieldZone", () => {
  it("responseDeadline → org zone", () => {
    expect(resolveQueryFieldZone("responseDeadline", { points: [], legs: [] }, ORG)).toBe(ORG);
  });
  it("queryDate → viewer zone (Intl local)", () => {
    const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveQueryFieldZone("queryDate", { points: [], legs: [] }, ORG)).toBe(viewer);
  });
  it("readyDate → the query's explicit readyDateTimezone, else org", () => {
    expect(resolveQueryFieldZone("readyDate", { points: [], legs: [] }, "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(resolveQueryFieldZone("readyDate", { points: [], legs: [], readyDateTimezone: "Asia/Singapore" }, "Asia/Kolkata")).toBe("Asia/Singapore");
  });
  it("targetDelivery → the query's explicit targetDeliveryTimezone, else org", () => {
    expect(resolveQueryFieldZone("targetDelivery", { points: [], legs: [], targetDeliveryTimezone: "Europe/London" }, "Asia/Kolkata")).toBe("Europe/London");
  });
  it("eta/etb/etd → first SEAPORT zone, else org", () => {
    expect(resolveQueryFieldZone("eta", { points: [air], legs: [] }, ORG)).toBe(ORG);
    expect(resolveQueryFieldZone("etb", { points: [air, sea], legs: [] }, ORG)).toBe(
      "Asia/Singapore",
    );
  });
});

describe("resolveLegFieldZone", () => {
  const points = [
    { id: "p1", timezone: "Asia/Kolkata" },
    { id: "p2", timezone: "Asia/Singapore" },
  ];
  const leg = { originPointId: "p1", destinationPointId: "p2" };
  it("readyDate → origin point zone; targetDelivery → destination point zone", () => {
    expect(resolveLegFieldZone("readyDate", leg, points, ORG)).toBe("Asia/Kolkata");
    expect(resolveLegFieldZone("targetDelivery", leg, points, ORG)).toBe("Asia/Singapore");
  });
  it("falls back to org zone when the endpoint (or its zone) is missing", () => {
    expect(resolveLegFieldZone("readyDate", {}, points, ORG)).toBe(ORG);
  });
  it("falls back to org zone when the matched point has a null timezone", () => {
    const nullTzPoints = [{ id: "p1", timezone: null }, { id: "p2", timezone: "Asia/Singapore" }];
    expect(resolveLegFieldZone("readyDate", { originPointId: "p1" }, nullTzPoints, ORG)).toBe(ORG);
  });
});
