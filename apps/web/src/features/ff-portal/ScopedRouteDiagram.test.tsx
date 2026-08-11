import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FfPortalLegDto, FfPortalEndpoint } from "@svyft/shared";
import { ScopedRouteDiagram } from "./ScopedRouteDiagram";

/** Builds a minimal, valid FfPortalLegDto; override any field per test. */
function leg(over: {
  legId: string;
  legCode?: string;
  mode?: FfPortalLegDto["mode"];
  origin?: { country: string | null; name: string | null; city: string | null } | null;
  destination?: { country: string | null; name: string | null; city: string | null } | null;
  endpoints?: FfPortalEndpoint[];
}): FfPortalLegDto {
  return {
    legId: over.legId,
    quoteId: `Q-${over.legId}`,
    status: "RFQ_SENT",
    mode: over.mode ?? "AIR",
    manifest: {
      legId: over.legId,
      legCode: over.legCode ?? over.legId,
      legName: null,
      mode: over.mode ?? "AIR",
      incoterms: null,
      origin: over.origin ?? null,
      destination: over.destination ?? null,
      readyDate: null,
      targetDelivery: null,
      cargo: [],
      frozenAt: "2026-08-01T00:00:00.000Z",
    },
    endpoints: over.endpoints ?? [],
    seededCharges: [],
    warehouseIncluded: true,
    draft: null,
  };
}

// Realistic endpoints: airports/seaports carry a code, warehouses/pickups/
// deliveries usually don't (mirrors what resolveScope actually produces —
// see FfPortalEndpoint.code's precedence, packages/shared/src/ff-portal.ts).
const p1: FfPortalEndpoint = {
  pointId: "p1",
  type: "WAREHOUSE",
  name: "Origin WH",
  country: "IN",
  code: null,
  warehousePosition: "ORIGIN",
};
const p2: FfPortalEndpoint = {
  pointId: "p2",
  type: "AIRPORT",
  name: "Hub Airport",
  country: "AE",
  code: "DXB",
  warehousePosition: null,
};
const p3: FfPortalEndpoint = {
  pointId: "p3",
  type: "DELIVERY",
  name: "Final Delivery",
  country: "US",
  code: null,
  warehousePosition: null,
};

describe("ScopedRouteDiagram", () => {
  it("shows the empty state when there are no legs", () => {
    render(<ScopedRouteDiagram legs={[]} />);
    expect(screen.getByText(/No route to display/i)).toBeInTheDocument();
  });

  it("shows the empty state when every leg has zero endpoints (doesn't crash)", () => {
    const legs = [leg({ legId: "L1", endpoints: [] })];
    render(<ScopedRouteDiagram legs={legs} />);
    expect(screen.getByText(/No route to display/i)).toBeInTheDocument();
  });

  it("renders one node box per distinct endpoint, deduped, and one edge per fully-formed leg", () => {
    // L1: p1 -> p2, L2: p2 -> p3. p2 is shared, so 3 distinct nodes, 2 edges.
    const legs = [
      leg({
        legId: "L1",
        legCode: "LEG-1",
        origin: { country: "IN", name: "Origin WH", city: "Mumbai" },
        destination: { country: "AE", name: "Hub Airport", city: "Dubai" },
        endpoints: [p1, p2],
      }),
      leg({
        legId: "L2",
        legCode: "LEG-2",
        origin: { country: "AE", name: "Hub Airport", city: "Dubai" },
        destination: { country: "US", name: "Final Delivery", city: "Newark" },
        endpoints: [p2, p3],
      }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    expect(container.querySelectorAll("[data-point-id]").length).toBe(3);
    expect(container.querySelectorAll("[data-leg-id]").length).toBe(2);
    expect(container.querySelector('[data-point-id="p1"]')).not.toBeNull();
    expect(container.querySelector('[data-point-id="p2"]')).not.toBeNull();
    expect(container.querySelector('[data-point-id="p3"]')).not.toBeNull();
    expect(container.querySelector('[data-leg-id="L1"]')).not.toBeNull();
    expect(container.querySelector('[data-leg-id="L2"]')).not.toBeNull();
  });

  it("orders nodes by route topology (x position), not by the order legs were assigned (regression: finding #1)", () => {
    // Legs are supplied in ASSIGNMENT order [L2, L1], but the route topology is
    // L1 (p1->p2) then L2 (p2->p3). The FF must see p1 before p2 before p3 —
    // matching the executive route view's left-to-right ordering — regardless
    // of the order the legs happen to appear in the `legs` prop.
    const legs = [
      leg({
        legId: "L2",
        legCode: "LEG-2",
        origin: { country: "AE", name: "Hub Airport", city: "Dubai" },
        destination: { country: "US", name: "Final Delivery", city: "Newark" },
        endpoints: [p2, p3],
      }),
      leg({
        legId: "L1",
        legCode: "LEG-1",
        origin: { country: "IN", name: "Origin WH", city: "Mumbai" },
        destination: { country: "AE", name: "Hub Airport", city: "Dubai" },
        endpoints: [p1, p2],
      }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    const xOf = (pointId: string) => {
      const node = container.querySelector(`[data-point-id="${pointId}"]`) as SVGGElement;
      const m = /translate\(\s*([-\d.]+)/.exec(node.getAttribute("transform") ?? "");
      return Number(m![1]);
    };

    expect(xOf("p1")).toBeLessThan(xOf("p2"));
    expect(xOf("p2")).toBeLessThan(xOf("p3"));
  });

  it("renders a lone node (no edge) for a leg with only one endpoint, without crashing", () => {
    const legs = [leg({ legId: "L1", endpoints: [p1] })];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);
    expect(container.querySelectorAll("[data-point-id]").length).toBe(1);
    expect(container.querySelectorAll("[data-leg-id]").length).toBe(0);
  });

  it("never renders a street address or contact detail, even if a future DTO leaked one onto an endpoint", () => {
    // FfPortalEndpoint has no street/contact fields today — that's the masking guarantee.
    // Simulate a hypothetical regression where the DTO grew those fields anyway, and assert
    // the component still only reads its type/code/name/country/city whitelist off the endpoint.
    const leakyEndpoint = {
      pointId: "p1",
      type: "PICKUP",
      name: "Origin WH",
      country: "IN",
      code: null,
      warehousePosition: null,
      streetAddress: "221B Baker Street",
      contactName: "Jane Contact",
      contactPhone: "+1-555-0100",
      contactEmail: "jane@example.com",
    } as unknown as FfPortalEndpoint;

    const legs = [
      leg({
        legId: "L1",
        origin: { country: "IN", name: "Origin WH", city: "Mumbai" },
        destination: { country: "AE", name: "Hub Airport", city: "Dubai" },
        endpoints: [leakyEndpoint, p2],
      }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    expect(screen.queryByText(/221B Baker Street/)).toBeNull();
    expect(screen.queryByText(/Jane Contact/)).toBeNull();
    expect(screen.queryByText(/555-0100/)).toBeNull();
    expect(screen.queryByText(/jane@example\.com/)).toBeNull();
    expect(container.innerHTML).not.toMatch(/Baker Street|Jane Contact|555-0100|jane@example\.com/);
  });

  it("mode-colors and dashes edges, and labels each with its legCode", () => {
    const legs = [leg({ legId: "L1", legCode: "SEA-1", mode: "SEA", endpoints: [p1, p2] })];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);
    const edge = container.querySelector('[data-leg-id="L1"]') as SVGGElement;
    expect(edge.getAttribute("data-mode")).toBe("SEA");
    expect(screen.getByText("SEA-1")).toBeInTheDocument();
  });

  it("renders the mode legend", () => {
    const legs = [leg({ legId: "L1", endpoints: [p1, p2] })];
    render(<ScopedRouteDiagram legs={legs} />);
    expect(screen.getByText("ROAD")).toBeInTheDocument();
    expect(screen.getByText("SEA")).toBeInTheDocument();
    expect(screen.getByText("AIR")).toBeInTheDocument();
  });

  // ── Task 4 brief, Step 1 (a)–(d) ──────────────────────────────────────────

  it("(a) positions nodes on two rows for a branched graph (two legs sharing an origin) — multi-row, not the old single row", () => {
    // p1 -> p2 and p1 -> p3: a fork. p2 and p3 land at the same depth (one hop
    // past p1), so the shared layout engine stacks them as two ROWS in the
    // same column — the old ScopedRouteDiagram forced every node onto one row
    // regardless of branching, which this proves is no longer the case.
    const legs = [
      leg({
        legId: "L1",
        legCode: "LEG-1",
        origin: { country: "IN", name: "Origin WH", city: "Mumbai" },
        destination: { country: "AE", name: "Hub Airport", city: "Dubai" },
        endpoints: [p1, p2],
      }),
      leg({
        legId: "L2",
        legCode: "LEG-2",
        origin: { country: "IN", name: "Origin WH", city: "Mumbai" },
        destination: { country: "US", name: "Final Delivery", city: "Newark" },
        endpoints: [p1, p3],
      }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    const xyOf = (pointId: string) => {
      const node = container.querySelector(`[data-point-id="${pointId}"]`) as SVGGElement;
      const m = /translate\(\s*([-\d.]+)[,\s]+([-\d.]+)/.exec(node.getAttribute("transform") ?? "");
      return { x: Number(m![1]), y: Number(m![2]) };
    };

    const p1pos = xyOf("p1");
    const p2pos = xyOf("p2");
    const p3pos = xyOf("p3");

    // p2 and p3 share a column (both one hop past p1)...
    expect(p2pos.x).toBe(p3pos.x);
    // ...but sit on two DIFFERENT rows — the multi-row assertion.
    expect(p2pos.y).not.toBe(p3pos.y);
    // p1 sits one column to the left of the fork.
    expect(p1pos.x).toBeLessThan(p2pos.x);
  });

  it("(b) renders a break marker between two disconnected legs (no shared point)", () => {
    const p4: FfPortalEndpoint = {
      pointId: "p4",
      type: "PICKUP",
      name: "Second Pickup",
      country: "DE",
      code: null,
      warehousePosition: null,
    };
    const p5: FfPortalEndpoint = {
      pointId: "p5",
      type: "DELIVERY",
      name: "Second Delivery",
      country: "FR",
      code: null,
      warehousePosition: null,
    };
    const legs = [
      leg({
        legId: "L1",
        origin: { country: "IN", name: "Origin WH", city: "Mumbai" },
        destination: { country: "AE", name: "Hub Airport", city: "Dubai" },
        endpoints: [p1, p2],
      }),
      leg({
        legId: "L2",
        origin: { country: "DE", name: "Second Pickup", city: "Berlin" },
        destination: { country: "FR", name: "Second Delivery", city: "Paris" },
        endpoints: [p4, p5],
      }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    // One diagram (the legend's small mode-color swatches are also <svg>
    // elements, so scope to the main diagram canvas via role="img"), one
    // break marker between the two disconnected components — NOT two
    // separate stacked diagrams.
    expect(container.querySelectorAll('svg[role="img"]').length).toBe(1);
    expect(container.querySelectorAll('[data-testid="route-break"]').length).toBe(1);
  });

  it("(c) shows a node's endpoint code alongside its name", () => {
    const pvg: FfPortalEndpoint = {
      pointId: "pPVG",
      type: "AIRPORT",
      name: "Shanghai Pudong",
      country: "CN",
      code: "PVG",
      warehousePosition: null,
    };
    const legs = [
      leg({
        legId: "L1",
        origin: { country: "CN", name: "Shanghai Pudong", city: "Shanghai" },
        destination: { country: "AE", name: "Hub Airport", city: "Dubai" },
        endpoints: [pvg, p2],
      }),
    ];
    render(<ScopedRouteDiagram legs={legs} />);

    expect(screen.getByText("PVG")).toBeInTheDocument();
    expect(screen.getByText("Shanghai Pudong")).toBeInTheDocument();
  });

  it("(d) is read-only: a node has no button role, and clicking one renders no detail panel", () => {
    const legs = [
      leg({
        legId: "L1",
        origin: { country: "IN", name: "Origin WH", city: "Mumbai" },
        destination: { country: "AE", name: "Hub Airport", city: "Dubai" },
        endpoints: [p1, p2],
      }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    const node = container.querySelector('[data-point-id="p1"]') as SVGGElement;
    expect(node.getAttribute("role")).toBeNull();
    expect(node.getAttribute("tabindex")).toBeNull();
    expect(node.getAttribute("aria-pressed")).toBeNull();
    expect(node.getAttribute("class") ?? "").not.toMatch(/cursor-pointer/);

    fireEvent.click(node);
    expect(screen.queryByTestId("scoped-route-node-detail")).toBeNull();
  });
});
