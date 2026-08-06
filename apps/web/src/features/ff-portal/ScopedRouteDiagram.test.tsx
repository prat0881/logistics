import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
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

const p1: FfPortalEndpoint = {
  pointId: "p1",
  type: "WAREHOUSE",
  name: "Origin WH",
  country: "IN",
  warehousePosition: "ORIGIN",
};
const p2: FfPortalEndpoint = {
  pointId: "p2",
  type: "AIRPORT",
  name: "Hub Airport",
  country: "AE",
  warehousePosition: null,
};
const p3: FfPortalEndpoint = {
  pointId: "p3",
  type: "DELIVERY",
  name: "Final Delivery",
  country: "US",
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
      leg({ legId: "L1", legCode: "LEG-1", origin: { country: "IN", name: "Origin WH", city: "Mumbai" }, destination: { country: "AE", name: "Hub Airport", city: "Dubai" }, endpoints: [p1, p2] }),
      leg({ legId: "L2", legCode: "LEG-2", origin: { country: "AE", name: "Hub Airport", city: "Dubai" }, destination: { country: "US", name: "Final Delivery", city: "Newark" }, endpoints: [p2, p3] }),
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

  it("renders a lone node (no edge) for a leg with only one endpoint, without crashing", () => {
    const legs = [leg({ legId: "L1", endpoints: [p1] })];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);
    expect(container.querySelectorAll("[data-point-id]").length).toBe(1);
    expect(container.querySelectorAll("[data-leg-id]").length).toBe(0);
  });

  it("reveals a node's masked detail (type, name, country) on click, and hides it on a second click", () => {
    const legs = [
      leg({ legId: "L1", origin: { country: "IN", name: "Origin WH", city: "Mumbai" }, destination: { country: "AE", name: "Hub Airport", city: "Dubai" }, endpoints: [p1, p2] }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    expect(screen.queryByTestId("scoped-route-node-detail")).toBeNull();

    const node = container.querySelector('[data-point-id="p1"]') as SVGGElement;
    fireEvent.click(node);

    const detail = screen.getByTestId("scoped-route-node-detail");
    expect(within(detail).getByText(/Warehouse/i)).toBeInTheDocument();
    expect(within(detail).getByText("Origin WH")).toBeInTheDocument();
    expect(within(detail).getByText(/Mumbai/)).toBeInTheDocument();
    expect(within(detail).getByText(/IN/)).toBeInTheDocument();

    fireEvent.click(node);
    expect(screen.queryByTestId("scoped-route-node-detail")).toBeNull();
  });

  it("switches the detail to the newly clicked node", () => {
    const legs = [
      leg({ legId: "L1", origin: { country: "IN", name: "Origin WH", city: "Mumbai" }, destination: { country: "AE", name: "Hub Airport", city: "Dubai" }, endpoints: [p1, p2] }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    fireEvent.click(container.querySelector('[data-point-id="p1"]') as SVGGElement);
    expect(within(screen.getByTestId("scoped-route-node-detail")).getByText("Origin WH")).toBeInTheDocument();

    fireEvent.click(container.querySelector('[data-point-id="p2"]') as SVGGElement);
    expect(within(screen.getByTestId("scoped-route-node-detail")).getByText("Hub Airport")).toBeInTheDocument();
  });

  it("never renders a street address or contact detail, even if a future DTO leaked one onto an endpoint", () => {
    // FfPortalEndpoint has no street/contact fields today — that's the masking guarantee.
    // Simulate a hypothetical regression where the DTO grew those fields anyway, and assert
    // the component still only reads its type/name/country/city whitelist off the endpoint.
    const leakyEndpoint = {
      pointId: "p1",
      type: "PICKUP",
      name: "Origin WH",
      country: "IN",
      warehousePosition: null,
      streetAddress: "221B Baker Street",
      contactName: "Jane Contact",
      contactPhone: "+1-555-0100",
      contactEmail: "jane@example.com",
    } as unknown as FfPortalEndpoint;

    const legs = [
      leg({ legId: "L1", origin: { country: "IN", name: "Origin WH", city: "Mumbai" }, destination: { country: "AE", name: "Hub Airport", city: "Dubai" }, endpoints: [leakyEndpoint, p2] }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);

    // Open every node's detail panel so any leaked field would have a chance to render.
    for (const node of Array.from(container.querySelectorAll("[data-point-id]"))) {
      fireEvent.click(node);
    }

    expect(screen.queryByText(/221B Baker Street/)).toBeNull();
    expect(screen.queryByText(/Jane Contact/)).toBeNull();
    expect(screen.queryByText(/555-0100/)).toBeNull();
    expect(screen.queryByText(/jane@example\.com/)).toBeNull();
    expect(container.innerHTML).not.toMatch(/Baker Street|Jane Contact|555-0100|jane@example\.com/);
  });

  it("mode-colors and dashes edges, and labels each with its legCode", () => {
    const legs = [
      leg({ legId: "L1", legCode: "SEA-1", mode: "SEA", endpoints: [p1, p2] }),
    ];
    const { container } = render(<ScopedRouteDiagram legs={legs} />);
    const edge = container.querySelector('[data-leg-id="L1"]') as SVGGElement;
    expect(edge.getAttribute("data-mode")).toBe("SEA");
    expect(screen.getByText("SEA-1")).toBeInTheDocument();
  });
});
