import { describe, it, expect } from "vitest";
import { computeLongestPathDepth } from "./routeLayering";

describe("computeLongestPathDepth", () => {
  it("assigns depth 0 to a source point that is never a destination", () => {
    const depth = computeLongestPathDepth(["a", "b"], [{ originId: "a", destinationId: "b" }]);
    expect(depth.get("a")).toBe(0);
    expect(depth.get("b")).toBe(1);
  });

  it("layers a linear chain by depth regardless of edge input order", () => {
    // Topology a -> b -> c, but edges supplied out of order ([b->c] before [a->b]) —
    // this is the exact shape of the FF-portal bug: a leg subgraph handed to the
    // layout in assignment order rather than topological order.
    const pointIds = ["a", "b", "c"];
    const edges = [
      { originId: "b", destinationId: "c" },
      { originId: "a", destinationId: "b" },
    ];
    const depth = computeLongestPathDepth(pointIds, edges);
    expect(depth.get("a")).toBe(0);
    expect(depth.get("b")).toBe(1);
    expect(depth.get("c")).toBe(2);
  });

  it("takes the longest path when a point is reachable via multiple edges", () => {
    // a -> c (direct, depth 1) and a -> b -> c (via b, depth 2). c must land at 2.
    const pointIds = ["a", "b", "c"];
    const edges = [
      { originId: "a", destinationId: "c" },
      { originId: "a", destinationId: "b" },
      { originId: "b", destinationId: "c" },
    ];
    const depth = computeLongestPathDepth(pointIds, edges);
    expect(depth.get("a")).toBe(0);
    expect(depth.get("b")).toBe(1);
    expect(depth.get("c")).toBe(2);
  });

  it("defaults an isolated point (touched by no edge) to depth 0", () => {
    const depth = computeLongestPathDepth(
      ["a", "b", "orphan"],
      [{ originId: "a", destinationId: "b" }],
    );
    expect(depth.get("orphan")).toBe(0);
  });

  it("ignores edges with a null origin or destination rather than throwing", () => {
    const pointIds = ["a", "b"];
    const edges = [
      { originId: null, destinationId: "b" },
      { originId: "a", destinationId: null },
    ];
    expect(() => computeLongestPathDepth(pointIds, edges)).not.toThrow();
    const depth = computeLongestPathDepth(pointIds, edges);
    expect(depth.get("a")).toBe(0);
    expect(depth.get("b")).toBe(0);
  });

  it("terminates on a cycle instead of looping forever", () => {
    // a -> b -> a: no fixpoint exists, but the iteration cap must still return.
    const pointIds = ["a", "b"];
    const edges = [
      { originId: "a", destinationId: "b" },
      { originId: "b", destinationId: "a" },
    ];
    const depth = computeLongestPathDepth(pointIds, edges);
    expect(depth.size).toBe(2);
    expect(Number.isFinite(depth.get("a"))).toBe(true);
    expect(Number.isFinite(depth.get("b"))).toBe(true);
  });
});
