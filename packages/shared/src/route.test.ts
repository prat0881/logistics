// packages/shared/src/route.test.ts
import { describe, it, expect } from "vitest";
import { validateRoute, checkModeEndpoints, type RouteGraph } from "./route";

// ── fixtures ────────────────────────────────────────────────────────────────
const READY = "2026-08-01T00:00:00.000Z";
const MID = "2026-08-05T00:00:00.000Z";
const TARGET = "2026-08-10T00:00:00.000Z";

// A fully-valid 2-leg ROAD route through a warehouse hub for one cargo row:
// Pickup -> Warehouse -> Delivery. All-ROAD so V-M1 passes (SEA/AIR need matching hubs).
function validGraph(): RouteGraph {
  return {
    query: { id: "q1", readyDate: READY, targetDelivery: TARGET },
    points: [
      { id: "pu", type: "PICKUP", name: "Shipper", streetAddress: "1 St", city: "Mumbai", postalCode: "400001", country: "IN", contactName: "A", contactPhone: "+911234567", contactEmail: "a@x.com", warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Asia/Kolkata" },
      { id: "wh", type: "WAREHOUSE", name: "Hub", streetAddress: "5 Rd", city: "Delhi", postalCode: "110001", country: "IN", contactName: null, contactPhone: null, contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Asia/Kolkata" },
      { id: "de", type: "DELIVERY", name: "Consignee", streetAddress: "9 Rd", city: "Hamburg", postalCode: "20095", country: "DE", contactName: "B", contactPhone: "+491234567", contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Europe/Berlin" },
    ],
    legs: [
      { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "pu", destinationPointId: "wh", readyDate: READY, targetDelivery: MID },
      { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "wh", destinationPointId: "de", readyDate: MID, targetDelivery: TARGET },
    ],
    cargo: [{ id: "c1", poReference: "PO-1", productName: "PO-1 goods", rowIndex: 0, isDangerous: false, msdsFileId: null, grossWt: 100, volumeCbm: 1 }],
    legCargo: [
      { legId: "l1", cargoItemId: "c1" },
      { legId: "l2", cargoItemId: "c1" },
    ],
  };
}
const rules = (g: RouteGraph, phase: "draft" | "create") => validateRoute(g, phase).map((f) => f.rule);

describe("validateRoute — valid route", () => {
  it("returns no findings for a complete valid route at create phase", () => {
    expect(validateRoute(validGraph(), "create")).toEqual([]);
  });
});

describe("checkModeEndpoints (V-M1)", () => {
  it("AIR needs both airport endpoints", () => {
    expect(checkModeEndpoints("AIR", "AIRPORT", "AIRPORT")).toBe(true);
    expect(checkModeEndpoints("AIR", "AIRPORT", "DELIVERY")).toBe(false);
  });
  it("SEA needs both seaport endpoints", () => {
    expect(checkModeEndpoints("SEA", "SEAPORT", "SEAPORT")).toBe(true);
    expect(checkModeEndpoints("SEA", "PICKUP", "SEAPORT")).toBe(false);
  });
  it("ROAD accepts any endpoints (incl. port drayage)", () => {
    expect(checkModeEndpoints("ROAD", "PICKUP", "SEAPORT")).toBe(true);
    expect(checkModeEndpoints("ROAD", "PICKUP", "DELIVERY")).toBe(true);
  });
});

describe("V-M1 is always blocking (both phases)", () => {
  it("blocks a SEA leg between non-seaports even in draft", () => {
    const g = validGraph();
    g.legs[1].mode = "SEA"; // wh(WAREHOUSE) -> de(DELIVERY) is invalid for SEA
    const draft = validateRoute(g, "draft").filter((f) => f.rule === "V-M1");
    expect(draft.length).toBe(1);
    expect(draft[0].severity).toBe("blocking");
  });
});

describe("R5 — minimum route (≥1 leg; each leg connects two different points)", () => {
  it("flags a query with no legs", () => {
    const g = validGraph();
    g.legs = [];
    g.legCargo = [];
    expect(rules(g, "create")).toContain("R5");
  });
  it("flags a leg whose origin and destination are the same point (self-loop)", () => {
    const g = validGraph();
    g.legs[0].destinationPointId = g.legs[0].originPointId; // pu -> pu
    expect(rules(g, "create")).toContain("R5");
  });
  it("does NOT require a Pickup or Delivery point anymore — a valid two-point leg suffices", () => {
    const g = validGraph();
    // Retype endpoints away from pickup/delivery; still distinct points wired by legs.
    g.points[0].type = "WAREHOUSE";
    g.points[2].type = "AIRPORT";
    g.points[2].iataCode = "HAM";
    expect(rules(g, "create")).not.toContain("R5");
  });
});

describe("R3 — orphans", () => {
  it("flags a leg with no cargo", () => {
    const g = validGraph();
    g.legCargo = g.legCargo.filter((lc) => lc.legId !== "l2");
    expect(rules(g, "create")).toContain("R3");
  });
  it("flags a cargo row with no legs", () => {
    const g = validGraph();
    g.cargo.push({ id: "c2", poReference: "PO-2", productName: "PO-2 goods", rowIndex: 1, isDangerous: false, msdsFileId: null, grossWt: 5, volumeCbm: 0.1 });
    expect(rules(g, "create")).toContain("R3");
  });
  it("flags an unused point", () => {
    const g = validGraph();
    g.points.push({ id: "wh2", type: "WAREHOUSE", name: "WH2", streetAddress: "x", city: "c", postalCode: "1", country: "IN", contactName: null, contactPhone: null, contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Asia/Kolkata" });
    expect(rules(g, "create")).toContain("R3");
  });
});

describe("R1/R2 — continuity & endpoints", () => {
  it("flags a broken chain (leg dest != next origin)", () => {
    const g = validGraph();
    g.legs[1].originPointId = "pu"; // l2 no longer starts where l1 ends (wh)
    expect(rules(g, "create")).toContain("R1");
  });
  it("flags a chain that STARTS at a Delivery point (R2 — cargo can't begin at a delivery)", () => {
    const g = validGraph();
    g.points[0].type = "DELIVERY"; // the source node is now a delivery
    expect(rules(g, "create")).toContain("R2");
  });
  it("does NOT flag a chain that starts at a Warehouse (any non-delivery start is allowed)", () => {
    const g = validGraph();
    g.points[0].type = "WAREHOUSE"; // start at a warehouse — allowed by the updated R2
    expect(rules(g, "create")).not.toContain("R2");
  });
  it("does NOT flag a chain that ENDS at a non-delivery point (any end is allowed)", () => {
    const g = validGraph();
    g.points[2].type = "AIRPORT"; // ends at an airport instead of a delivery — allowed
    expect(rules(g, "create")).not.toContain("R2");
  });
});

describe("R4 — no cycles", () => {
  it("flags a cycle", () => {
    const g = validGraph();
    // pu->wh, wh->pu forms a cycle with no pickup source / delivery sink
    g.legs = [
      { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "pu", destinationPointId: "wh", readyDate: READY, targetDelivery: MID },
      { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "wh", destinationPointId: "pu", readyDate: MID, targetDelivery: TARGET },
    ];
    g.legCargo = [
      { legId: "l1", cargoItemId: "c1" },
      { legId: "l2", cargoItemId: "c1" },
    ];
    const r = rules(g, "create");
    expect(r.some((x) => x === "R4" || x === "R1" || x === "R6")).toBe(true);
  });
});

describe("R6 — mass balance", () => {
  it("flags cargo mass-balance imbalance at a hub (enters, never leaves)", () => {
    const g = validGraph();
    // Two legs feed the warehouse; nothing leaves it → wh has indeg 2, outdeg 0 (|diff| = 2).
    g.points.push({ id: "pu2", type: "PICKUP", name: "S2", streetAddress: "2", city: "Pune", postalCode: "411001", country: "IN", contactName: "C", contactPhone: "+915555555", contactEmail: "c@x.com", warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Asia/Kolkata" });
    g.legs = [
      { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "pu", destinationPointId: "wh", readyDate: READY, targetDelivery: MID },
      { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "pu2", destinationPointId: "wh", readyDate: READY, targetDelivery: MID },
    ];
    g.legCargo = [
      { legId: "l1", cargoItemId: "c1" },
      { legId: "l2", cargoItemId: "c1" },
    ];
    expect(rules(g, "create")).toContain("R6");
  });
});

describe("R1 — clear message when one cargo row is split across parallel legs", () => {
  it("names the parallel-drop cause (fork) instead of the generic chain message", () => {
    const g = validGraph();
    g.points.push({ id: "de2", type: "DELIVERY", name: "Consignee2", streetAddress: "10 Rd", city: "Bremen", postalCode: "28195", country: "DE", contactName: "C", contactPhone: "+491230000", contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Europe/Berlin" });
    // Same cargo c1 leaves the pickup on two legs (pu->de, pu->de2) → parallel drop.
    g.legs = [
      { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "pu", destinationPointId: "de", readyDate: READY, targetDelivery: TARGET },
      { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "pu", destinationPointId: "de2", readyDate: READY, targetDelivery: TARGET },
    ];
    g.legCargo = [
      { legId: "l1", cargoItemId: "c1" },
      { legId: "l2", cargoItemId: "c1" },
    ];
    const r1 = validateRoute(g, "create").find((f) => f.rule === "R1");
    expect(r1).toBeDefined();
    expect(r1!.message).toMatch(/parallel legs/i);
    expect(r1!.message).toContain("L1");
    expect(r1!.message).toContain("L2");
  });
});

describe("R7/R8 — downstream readiness", () => {
  it("flags a missing country on an endpoint", () => {
    const g = validGraph();
    g.points[1].country = null;
    expect(rules(g, "create")).toContain("R7");
  });
  it("flags a pickup missing mandatory fields", () => {
    const g = validGraph();
    g.points[0].contactEmail = null; // pickup requires email
    expect(rules(g, "create")).toContain("R8");
  });
  it("does NOT flag R8 for a delivery missing email (email optional)", () => {
    const g = validGraph();
    g.points[2].contactEmail = null;
    expect(rules(g, "create")).not.toContain("R8");
  });
});

describe("R8 — timezone is required for every point type at create phase", () => {
  it("flags a create-phase PICKUP missing timezone as an R8 finding", () => {
    const g = validGraph();
    // Remove timezone from the pickup point (it has none — until we add it to the fixture)
    // The point will be missing timezone when it's required in POINT_REQUIRED_FIELDS
    const pickupPoint = g.points.find((p) => p.type === "PICKUP")!;
    (pickupPoint as Record<string, unknown>).timezone = undefined;
    const findings = validateRoute(g, "create").filter((f) => f.rule === "R8");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.scope.id === pickupPoint.id)).toBe(true);
  });
});

describe("R2 — uses product name in finding when PO is blank", () => {
  it("uses Product Name in a finding when PO is blank", () => {
    const g = validGraph();
    g.points[0].type = "DELIVERY";
    g.cargo[0].poReference = "";
    (g.cargo[0] as { productName?: string }).productName = "Steel Coils";
    const r2 = validateRoute(g, "create").find((f) => f.rule === "R2");
    expect(r2?.message).toContain("Steel Coils");
  });
});

describe("R9 — DG needs MSDS on every carrying leg", () => {
  it("flags DG cargo without an MSDS", () => {
    const g = validGraph();
    g.cargo[0].isDangerous = true;
    g.cargo[0].msdsFileId = null;
    expect(rules(g, "create")).toContain("R9");
  });
});

describe("T2 removed — query dates decoupled from legs", () => {
  it("does NOT flag when leg dates differ from the query dates", () => {
    const g = validGraph();
    // Deliberately mismatch: first leg ready ≠ query ready, last leg target ≠ query target.
    g.legs[0].readyDate = "2026-08-02T00:00:00.000Z"; // query readyDate is 2026-08-01
    g.legs[1].targetDelivery = "2026-08-09T00:00:00.000Z"; // query targetDelivery is 2026-08-10
    expect(validateRoute(g, "create").map((f) => f.rule)).not.toContain("T2");
    // still a clean route otherwise (chain intact, T1 order preserved)
    expect(validateRoute(g, "create")).toEqual([]);
  });
});

describe("T1/T3 — temporal", () => {
  it("T1: warns in draft, blocks in create when a leg departs before the prior arrives", () => {
    const g = validGraph();
    g.legs[1].readyDate = "2026-08-03T00:00:00.000Z"; // before l1 target (MID = 08-05)
    const draftT1 = validateRoute(g, "draft").filter((f) => f.rule === "T1");
    expect(draftT1.length).toBeGreaterThan(0);
    expect(draftT1[0].severity).toBe("warning");
    const createT1 = validateRoute(g, "create").filter((f) => f.rule === "T1");
    expect(createT1[0].severity).toBe("blocking");
  });
  it("T3: flags an onward hub leg departing before the max feeding arrival", () => {
    const g = validGraph();
    // add a second feeding leg into sp with a later target than l1
    g.points.push({ id: "pu2", type: "PICKUP", name: "S2", streetAddress: "2", city: "Pune", postalCode: "411001", country: "IN", contactName: "C", contactPhone: "+915555555", contactEmail: "c@x.com", warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Asia/Kolkata" });
    g.cargo.push({ id: "c2", poReference: "PO-2", productName: "PO-2 goods", rowIndex: 1, isDangerous: false, msdsFileId: null, grossWt: 50, volumeCbm: 0.5 });
    g.legs.push({ id: "l3", legCode: "L3", mode: "ROAD", originPointId: "pu2", destinationPointId: "wh", readyDate: READY, targetDelivery: "2026-08-07T00:00:00.000Z" });
    g.legCargo.push({ legId: "l3", cargoItemId: "c2" }, { legId: "l2", cargoItemId: "c2" });
    // l2 departs wh at MID (08-05) < max feeding target (08-07)
    expect(rules(g, "create")).toContain("T3");
  });
});

describe("C1/C3 — completeness", () => {
  it("C1: flags a leg missing its mode", () => {
    const g = validGraph();
    g.legs[0].mode = null;
    expect(rules(g, "create")).toContain("C1");
  });

  it("flags a cargo row whose legs are not all on one continuous chain (C2)", () => {
    const g = validGraph();
    g.points.push(
      { id: "x", type: "WAREHOUSE", name: "X", streetAddress: "1", city: "c", postalCode: "1", country: "IN", contactName: null, contactPhone: null, contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Asia/Kolkata" },
      { id: "y", type: "WAREHOUSE", name: "Y", streetAddress: "2", city: "c", postalCode: "1", country: "IN", contactName: null, contactPhone: null, contactEmail: null, warehouseType: null, iataCode: null, icaoCode: null, unLocode: null, terminal: null, timezone: "Asia/Kolkata" },
    );
    g.legs = [
      { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "pu", destinationPointId: "de", readyDate: READY, targetDelivery: TARGET },
      { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "x", destinationPointId: "y", readyDate: READY, targetDelivery: MID },
      { id: "l3", legCode: "L3", mode: "ROAD", originPointId: "y", destinationPointId: "x", readyDate: MID, targetDelivery: TARGET },
    ];
    g.legCargo = [
      { legId: "l1", cargoItemId: "c1" },
      { legId: "l2", cargoItemId: "c1" },
      { legId: "l3", cargoItemId: "c1" },
    ];
    expect(rules(g, "create")).toContain("C2");
  });

  it("flags a leg whose cargo cannot compute its roll-up (C3)", () => {
    const g = validGraph();
    g.cargo[0].grossWt = null;
    expect(rules(g, "create")).toContain("C3");
  });
});
