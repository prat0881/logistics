import { describe, it, expect } from "vitest";
import { computeLongestPathDepth, computeRouteLayout } from "./routeLayering";

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

describe("computeRouteLayout", () => {
  it("(a) lays a linear chain across three columns, one row each, single component", () => {
    // a -> b -> c: strictly increasing depth, no stacking, nothing to split.
    const pointIds = ["a", "b", "c"];
    const edges = [
      { originId: "a", destinationId: "b" },
      { originId: "b", destinationId: "c" },
    ];
    const layout = computeRouteLayout(pointIds, edges);
    expect(layout.nodes.get("a")).toEqual({ id: "a", col: 0, row: 0, component: 0 });
    expect(layout.nodes.get("b")).toEqual({ id: "b", col: 1, row: 0, component: 0 });
    expect(layout.nodes.get("c")).toEqual({ id: "c", col: 2, row: 0, component: 0 });
    expect(layout.colCount).toBe(3);
    expect(layout.maxRows).toBe(1);
    expect(layout.componentCount).toBe(1);
    expect(layout.breakCols).toEqual([]);
  });

  it("(b) stacks a fork's siblings as rows within the shared column", () => {
    // a -> b, a -> c: b and c share depth 1, so they stack as two rows in col 1.
    const pointIds = ["a", "b", "c"];
    const edges = [
      { originId: "a", destinationId: "b" },
      { originId: "a", destinationId: "c" },
    ];
    const layout = computeRouteLayout(pointIds, edges);
    expect(layout.nodes.get("a")).toEqual({ id: "a", col: 0, row: 0, component: 0 });
    expect(layout.nodes.get("b")).toEqual({ id: "b", col: 1, row: 0, component: 0 });
    expect(layout.nodes.get("c")).toEqual({ id: "c", col: 1, row: 1, component: 0 });
    expect(layout.colCount).toBe(2);
    expect(layout.maxRows).toBe(2);
    expect(layout.componentCount).toBe(1);
  });

  it("(c) trails an orphan (no edge) to the column after the deepest touched point", () => {
    // a -> b (depths 0,1); o is touched by no edge, so it trails to col 2 and
    // — since union-find never joins it to anything — forms its own component.
    const pointIds = ["a", "b", "o"];
    const edges = [{ originId: "a", destinationId: "b" }];
    const layout = computeRouteLayout(pointIds, edges);
    expect(layout.nodes.get("a")).toEqual({ id: "a", col: 0, row: 0, component: 0 });
    expect(layout.nodes.get("b")).toEqual({ id: "b", col: 1, row: 0, component: 0 });
    expect(layout.nodes.get("o")).toEqual({ id: "o", col: 2, row: 0, component: 1 });
    expect(layout.colCount).toBe(3);
    expect(layout.maxRows).toBe(1);
    expect(layout.componentCount).toBe(2);
    expect(layout.breakCols).toEqual([]);
  });

  it("(d) splitComponents:true separates disjoint chains with a break column between", () => {
    // Two disjoint chains, a->b and c->d, share depths (both sources at depth 0,
    // both sinks at depth 1) but must NOT share columns once split: each chain
    // gets its own column-rank grid, offset by one empty break column.
    const pointIds = ["a", "b", "c", "d"];
    const edges = [
      { originId: "a", destinationId: "b" },
      { originId: "c", destinationId: "d" },
    ];
    const layout = computeRouteLayout(pointIds, edges, { splitComponents: true });
    expect(layout.nodes.get("a")).toEqual({ id: "a", col: 0, row: 0, component: 0 });
    expect(layout.nodes.get("b")).toEqual({ id: "b", col: 1, row: 0, component: 0 });
    expect(layout.nodes.get("c")).toEqual({ id: "c", col: 3, row: 0, component: 1 });
    expect(layout.nodes.get("d")).toEqual({ id: "d", col: 4, row: 0, component: 1 });
    expect(layout.breakCols).toEqual([2]);
    expect(layout.colCount).toBe(5);
    expect(layout.maxRows).toBe(1);
    expect(layout.componentCount).toBe(2);
  });

  it("(e) splitComponents:false packs the same disjoint chains into one global grid", () => {
    // Same input as (d), but unsplit: depth wins over component, so a/c (both
    // depth 0) share col 0 and b/d (both depth 1) share col 1 — executive
    // behavior — while componentCount is still reported as 2.
    const pointIds = ["a", "b", "c", "d"];
    const edges = [
      { originId: "a", destinationId: "b" },
      { originId: "c", destinationId: "d" },
    ];
    const layout = computeRouteLayout(pointIds, edges, { splitComponents: false });
    expect(layout.nodes.get("a")).toEqual({ id: "a", col: 0, row: 0, component: 0 });
    expect(layout.nodes.get("c")).toEqual({ id: "c", col: 0, row: 1, component: 1 });
    expect(layout.nodes.get("b")).toEqual({ id: "b", col: 1, row: 0, component: 0 });
    expect(layout.nodes.get("d")).toEqual({ id: "d", col: 1, row: 1, component: 1 });
    expect(layout.colCount).toBe(2);
    expect(layout.maxRows).toBe(2);
    expect(layout.breakCols).toEqual([]);
    expect(layout.componentCount).toBe(2);
  });
});
