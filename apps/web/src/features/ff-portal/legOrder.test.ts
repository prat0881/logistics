import { describe, it, expect } from "vitest";
import type { FfPortalEndpoint, FfPortalLegDto } from "@svyft/shared";
import { orderLegsByRoute } from "./legOrder";

/** Builds a minimal, valid FfPortalLegDto; override any field per test (mirrors
 *  ScopedRouteDiagram.test.tsx's fixture builder — same DTO shape, same idea). */
function leg(over: {
  legId: string;
  legCode?: string;
  endpoints?: FfPortalEndpoint[];
}): FfPortalLegDto {
  return {
    legId: over.legId,
    quoteId: `Q-${over.legId}`,
    status: "RFQ_SENT",
    mode: "AIR",
    manifest: {
      legId: over.legId,
      legCode: over.legCode ?? over.legId,
      legName: null,
      mode: "AIR",
      incoterms: null,
      origin: null,
      destination: null,
      readyDate: null,
      targetDelivery: null,
      cargo: [],
      frozenAt: "2026-08-01T00:00:00.000Z",
    },
    endpoints: over.endpoints ?? [],
    seededCharges: [],
    warehouseIncluded: false,
    draft: null,
    version: "v1",
  };
}

const p1: FfPortalEndpoint = {
  pointId: "p1",
  type: "PICKUP",
  name: "Origin",
  country: "IN",
  code: null,
  warehousePosition: null,
};
const p2: FfPortalEndpoint = {
  pointId: "p2",
  type: "AIRPORT",
  name: "Hub",
  country: "AE",
  code: "DXB",
  warehousePosition: null,
};
const p3: FfPortalEndpoint = {
  pointId: "p3",
  type: "DELIVERY",
  name: "Destination",
  country: "US",
  code: null,
  warehousePosition: null,
};
const p4: FfPortalEndpoint = {
  pointId: "p4",
  type: "DELIVERY",
  name: "Branch destination",
  country: "DE",
  code: null,
  warehousePosition: null,
};
const p5: FfPortalEndpoint = {
  pointId: "p5",
  type: "PICKUP",
  name: "Second-chain midpoint",
  country: "DE",
  code: null,
  warehousePosition: null,
};
const p6: FfPortalEndpoint = {
  pointId: "p6",
  type: "DELIVERY",
  name: "Second-chain end",
  country: "FR",
  code: null,
  warehousePosition: null,
};

describe("orderLegsByRoute", () => {
  it("returns [] for [] without crashing", () => {
    expect(orderLegsByRoute([])).toEqual([]);
  });

  it("leaves a single leg unchanged", () => {
    const legs = [leg({ legId: "L1", endpoints: [p1, p2] })];
    expect(orderLegsByRoute(legs)).toEqual(legs);
  });

  it("reorders legs into route-topology order when assignment order disagrees (regression: finding #2)", () => {
    // Assignment order [L2, L1] — but the route topology is L1 (p1->p2) then L2 (p2->p3).
    // rfq.legs' wire order tracks WHEN a leg was distributed, not WHERE it sits on the route.
    const legL2 = leg({ legId: "L2", legCode: "LEG-2", endpoints: [p2, p3] });
    const legL1 = leg({ legId: "L1", legCode: "LEG-1", endpoints: [p1, p2] });

    const ordered = orderLegsByRoute([legL2, legL1]);

    expect(ordered.map((l) => l.legId)).toEqual(["L1", "L2"]);
  });

  it("does not mutate the input array", () => {
    const legL2 = leg({ legId: "L2", endpoints: [p2, p3] });
    const legL1 = leg({ legId: "L1", endpoints: [p1, p2] });
    const input = [legL2, legL1];
    const inputCopy = [...input];

    orderLegsByRoute(input);

    expect(input).toEqual(inputCopy);
  });

  it("tie-breaks legs sharing the same origin depth by destination depth", () => {
    // p1 -> p2 -> p3 establishes depth(p2)=1, depth(p3)=2. A third leg goes p1 -> p3 directly:
    // its origin (p1, depth 0) ties with the p1->p2 leg's origin, but its destination (p3,
    // depth 2) is deeper than p1->p2's destination (p2, depth 1) — origin depth alone can't
    // order these two, so TO_P2 must sort before TO_P3_DIRECT on destination depth.
    const toP2 = leg({ legId: "TO_P2", legCode: "TO_P2", endpoints: [p1, p2] });
    const p2ToP3 = leg({ legId: "P2_TO_P3", legCode: "P2_TO_P3", endpoints: [p2, p3] });
    const toP3Direct = leg({ legId: "TO_P3_DIRECT", legCode: "TO_P3_DIRECT", endpoints: [p1, p3] });

    const ids = orderLegsByRoute([toP3Direct, p2ToP3, toP2]).map((l) => l.legId);

    expect(ids.indexOf("TO_P2")).toBeLessThan(ids.indexOf("TO_P3_DIRECT"));
  });

  it("tie-breaks fully-equal-depth legs by original array position (stable)", () => {
    // Two completely disconnected 1-hop legs: both origins at depth 0, both destinations at
    // depth 1 — origin/destination depth can't distinguish them, so original index decides.
    const legB = leg({ legId: "B", legCode: "B", endpoints: [p4, p3] });
    const legA = leg({ legId: "A", legCode: "A", endpoints: [p1, p2] });

    expect(orderLegsByRoute([legB, legA]).map((l) => l.legId)).toEqual(["B", "A"]);
    expect(orderLegsByRoute([legA, legB]).map((l) => l.legId)).toEqual(["A", "B"]);
  });

  it("keeps each connected component's legs contiguous, matching the diagram's split-component block layout — not interleaved by raw global depth (fix round 1)", () => {
    // Two INDEPENDENT 2-hop chains (e.g. a first-mile + last-mile FF assignment where the middle
    // leg went to a different forwarder): B1->B2 (p1->p2->p3) and A1->A2 (p4->p5->p6). Neither
    // chain shares a point with the other, so they're two separate weakly-connected components.
    //
    // ScopedRouteDiagram doesn't lay out by flat global depth — it calls
    // computeRouteLayout(..., { splitComponents: true }), which renders each component as its own
    // CONTIGUOUS block (separated by a break column). A sort keyed on raw computeLongestPathDepth
    // can't reproduce that: B1/A1 both sit at global depth 0 and B2/A2 both sit at global depth 1,
    // so a naive depth sort interleaves them into [B1, A1, B2, A2] — wrong, because the diagram
    // draws two contiguous blocks, not an interleaved column. (The existing
    // "tie-breaks fully-equal-depth" test above uses single-edge (1-hop) components, where a lone
    // edge's origin is trivially both the min-depth AND first-encountered point, so a depth sort
    // and a column sort coincide — it can't catch this bug; a 2-hop chain per component is
    // required to expose the divergence.)
    const b1 = leg({ legId: "B1", legCode: "B1", endpoints: [p1, p2] });
    const b2 = leg({ legId: "B2", legCode: "B2", endpoints: [p2, p3] });
    const a1 = leg({ legId: "A1", legCode: "A1", endpoints: [p4, p5] });
    const a2 = leg({ legId: "A2", legCode: "A2", endpoints: [p5, p6] });

    // Feed an already-interleaved input order so a correct result can't be a coincidence of the
    // input's own order (assignment order is exactly what #2 says must NOT drive the result).
    const ids = orderLegsByRoute([a1, b1, a2, b2]).map((l) => l.legId);

    const bAt = [ids.indexOf("B1"), ids.indexOf("B2")].sort((x, y) => x - y);
    const aAt = [ids.indexOf("A1"), ids.indexOf("A2")].sort((x, y) => x - y);

    // Each component's own two legs are adjacent (B1 immediately followed by B2; same for A).
    expect(bAt[1]).toBe(bAt[0] + 1);
    expect(aAt[1]).toBe(aAt[0] + 1);
    // The two components' blocks don't interleave with each other — one occupies [0,1], the
    // other [2,3] (in either order), never e.g. B at [0,2] / A at [1,3].
    expect([bAt[0], aAt[0]].sort((x, y) => x - y)).toEqual([0, 2]);
  });

  it("does not throw for a leg with fewer than 2 endpoints (defensive)", () => {
    const orphan = leg({ legId: "ORPHAN", endpoints: [] });
    const normal = leg({ legId: "L1", endpoints: [p1, p2] });

    expect(() => orderLegsByRoute([normal, orphan])).not.toThrow();
    expect(
      orderLegsByRoute([normal, orphan])
        .map((l) => l.legId)
        .sort(),
    ).toEqual(["L1", "ORPHAN"]);
  });
});
