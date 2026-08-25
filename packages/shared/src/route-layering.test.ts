import { describe, it, expect } from "vitest";
import { orderLegsByRoute } from "./route-layering";

/** Generic-accessor smoke tests for `orderLegsByRoute`. `computeLongestPathDepth`/
 *  `computeRouteLayout` themselves are exercised in full by `apps/web/src/lib/routeLayering.test.ts`
 *  (which now runs against this same module via the web re-export) — these tests only cover the
 *  NEW generic sorter, and specifically the two properties S5.9.3 Task 2 (P4) depends on: real
 *  callers (the api's award/quotation snapshot builders) pass plain objects with
 *  `originPointId`/`destinationPointId` fields, not the FF-portal's masked DTO, and a caller can
 *  get a fully DETERMINISTIC tiebreak (not just "stable to whatever order I happened to pass in")
 *  by pre-sorting its input before calling this. */

interface TestLeg {
  legId: string;
  legCode: string;
  originPointId: string | null;
  destinationPointId: string | null;
}

function leg(legId: string, legCode: string, originPointId: string | null, destinationPointId: string | null): TestLeg {
  return { legId, legCode, originPointId, destinationPointId };
}

const byOrigin = (l: TestLeg) => l.originPointId;
const byDest = (l: TestLeg) => l.destinationPointId;

describe("orderLegsByRoute (generic)", () => {
  it("returns [] for [] without crashing", () => {
    expect(orderLegsByRoute([], byOrigin, byDest)).toEqual([]);
  });

  it("reorders legs into route-topology order when input order disagrees", () => {
    // Route is p1->p2 (L1) then p2->p3 (L2); fed in reverse.
    const l2 = leg("L2", "L2", "p2", "p3");
    const l1 = leg("L1", "L1", "p1", "p2");

    expect(orderLegsByRoute([l2, l1], byOrigin, byDest).map((l) => l.legId)).toEqual(["L1", "L2"]);
  });

  it("does not mutate the input array", () => {
    const l2 = leg("L2", "L2", "p2", "p3");
    const l1 = leg("L1", "L1", "p1", "p2");
    const input = [l2, l1];
    const copy = [...input];

    orderLegsByRoute(input, byOrigin, byDest);

    expect(input).toEqual(copy);
  });

  it("falls back to INPUT order (stable) for a disconnected/ambiguous route — the caller decides what 'deterministic' means by pre-sorting", () => {
    // Two independent 1-hop legs sharing no point — route topology can't order them.
    const a = leg("A", "A-CODE", "p1", "p2");
    const b = leg("B", "Z-CODE", "p3", "p4");

    // Fed as [b, a]: the function's OWN fallback is "keep input order," not any inherent
    // legCode/id ordering — so the output mirrors whatever order the caller passed in.
    expect(orderLegsByRoute([b, a], byOrigin, byDest).map((l) => l.legId)).toEqual(["B", "A"]);
    expect(orderLegsByRoute([a, b], byOrigin, byDest).map((l) => l.legId)).toEqual(["A", "B"]);
  });

  it("a caller achieves a deterministic leg-code tiebreak by pre-sorting its input before calling this (the pattern award.service.ts / quotation.service.ts use)", () => {
    const a = leg("A", "A-CODE", "p1", "p2");
    const b = leg("B", "Z-CODE", "p3", "p4");

    const byLegCode = (x: TestLeg, y: TestLeg) => x.legCode.localeCompare(y.legCode);

    // Regardless of which order they're handed in, pre-sorting by legCode first makes the
    // topology sort's stable fallback land on legCode order every time.
    expect(orderLegsByRoute([b, a].sort(byLegCode), byOrigin, byDest).map((l) => l.legId)).toEqual([
      "A",
      "B",
    ]);
    expect(orderLegsByRoute([a, b].sort(byLegCode), byOrigin, byDest).map((l) => l.legId)).toEqual([
      "A",
      "B",
    ]);
  });

  it("does not throw for a leg missing one or both endpoints (defensive)", () => {
    const orphan = leg("ORPHAN", "ORPHAN", null, null);
    const normal = leg("L1", "L1", "p1", "p2");

    expect(() => orderLegsByRoute([normal, orphan], byOrigin, byDest)).not.toThrow();
    expect(
      orderLegsByRoute([normal, orphan], byOrigin, byDest)
        .map((l) => l.legId)
        .sort(),
    ).toEqual(["L1", "ORPHAN"]);
  });

  it("works on plain Leg-row-shaped objects (originPointId/destinationPointId), not just a masked portal DTO", () => {
    // Mirrors what `Prisma.leg.findMany({ select: { id, legCode, originPointId, destinationPointId } })`
    // actually returns — the api's real call site shape.
    const rows = [
      { id: "L2", legCode: "L2", originPointId: "p2", destinationPointId: "p3" },
      { id: "L1", legCode: "L1", originPointId: "p1", destinationPointId: "p2" },
    ];

    const ordered = orderLegsByRoute(
      rows,
      (r) => r.originPointId,
      (r) => r.destinationPointId,
    );

    expect(ordered.map((r) => r.id)).toEqual(["L1", "L2"]);
  });
});
