import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding, QueryDetail } from "@svyft/shared";
import { RouteDiagram } from "./RouteDiagram";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Build a QueryDetail with the given points / legs; cargo defaults to empty. */
function makeDetail(over: {
  points?: Array<{ id: string; type: string; name?: string | null; city?: string | null; country?: string | null; unLocode?: string | null; iataCode?: string | null; streetAddress?: string | null; postalCode?: string | null; contactName?: string | null; contactPhone?: string | null; contactEmail?: string | null }>;
  legs?: Array<{ id: string; legCode: string; mode?: string | null; originPointId?: string | null; destinationPointId?: string | null; assignedCargoIds?: string[]; rollup?: { totalPackages: number; totalCbm: number; totalGrossWt: number; totalNetWt: number } }>;
  cargo?: Array<{ id: string; poReference?: string }>;
} = {}): QueryDetail {
  const points = (over.points ?? []).map((p) => ({
    tenantId: null,
    queryId: "q1",
    name: p.name ?? null,
    streetAddress: p.streetAddress ?? null,
    city: p.city ?? null,
    postalCode: p.postalCode ?? null,
    country: p.country ?? null,
    contactName: p.contactName ?? null,
    contactPhone: p.contactPhone ?? null,
    contactEmail: p.contactEmail ?? null,
    warehouseType: null,
    iataCode: p.iataCode ?? null,
    icaoCode: null,
    unLocode: p.unLocode ?? null,
    terminal: null,
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00",
    ...p,
  })) as QueryDetail["points"];
  const cargo = (over.cargo ?? []).map((c, i) => ({
    id: c.id,
    rowIndex: i,
    poReference: c.poReference ?? "PO",
    productName: "Widget",
    referenceTags: [],
    hsCode: null,
    packageType: "Carton",
    isDangerous: false,
    msdsFileId: null,
    qty: 1,
    dimL: "10",
    dimW: "10",
    dimH: "10",
    netWt: null,
    grossWt: "10",
    volumeCbm: "1",
    dimUnit: "CM",
    weightUnit: "KG",
  })) as QueryDetail["cargo"];
  const legs = (over.legs ?? []).map((l) => ({
    tenantId: null,
    queryId: "q1",
    legName: null,
    originPointId: l.originPointId ?? null,
    destinationPointId: l.destinationPointId ?? null,
    mode: l.mode ?? null,
    readyDate: null,
    targetDelivery: null,
    status: "DRAFT",
    executionStatus: "PENDING",
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00",
    rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
    assignedCargoIds: l.assignedCargoIds ?? [],
    ...l,
  })) as QueryDetail["legs"];
  return {
    id: "q1",
    tenantId: null,
    queryCode: "YAL26-0001",
    queryDate: "2026-01-01T00:00:00+00:00",
    priority: "MEDIUM",
    responseDeadline: null,
    responseDeadlineRemarks: null,
    clientId: null,
    contactName: null,
    contactDesignation: null,
    contactEmail: null,
    contactPhone: null,
    whatsappEnabled: false,
    faxNumber: null,
    vesselId: null,
    vesselName: null,
    imoNumber: null,
    eta: null,
    etb: null,
    etd: null,
    portOfCall: null,
    incoterms: null,
    shipmentDescription: null,
    dgIndicator: false,
    readyDate: null,
    readyDateTimezone: null,
    targetDelivery: null,
    targetDeliveryTimezone: null,
    internalNotes: null,
    status: "DRAFT",
    rfqReadyAt: null,
    assignedUserId: null,
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00",
    cargo,
    checklist: [],
    files: [],
    points,
    legs,
    freightMode: [],
    origin: [],
    destination: [],
  } as QueryDetail;
}

describe("RouteDiagram", () => {
  it("renders a broken-chain edge with data-finding and an orphan point with data-orphan", () => {
    // p1→p2 (leg l1), p3→p4 (leg l2 — disconnected chain), plus p5 = orphan.
    const detail = makeDetail({
      points: [
        { id: "p1", type: "PICKUP", name: "Sender" },
        { id: "p2", type: "WAREHOUSE", name: "Hub" },
        { id: "p3", type: "WAREHOUSE", name: "Hub2" },
        { id: "p4", type: "DELIVERY", name: "Receiver" },
        { id: "p5", type: "DELIVERY", name: "Orphan Dock" },
      ],
      legs: [
        { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "p1", destinationPointId: "p2", assignedCargoIds: [] },
        { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "p3", destinationPointId: "p4", assignedCargoIds: [] },
      ],
    });
    const findings: Finding[] = [
      { rule: "R1", severity: "blocking", scope: { type: "leg", id: "l2" }, message: "broken chain" },
    ];

    const { container } = render(<RouteDiagram detail={detail} findings={findings} />);

    // The flagged leg edge carries data-finding="blocking".
    const brokenEdge = container.querySelector('[data-leg-id="l2"][data-finding="blocking"]');
    expect(brokenEdge).not.toBeNull();

    // p5 is touched by no leg → orphan.
    const orphan = container.querySelector('[data-point-id="p5"][data-orphan]');
    expect(orphan).not.toBeNull();

    // A non-orphan, non-flagged node has neither marker.
    const p1 = container.querySelector('[data-point-id="p1"]');
    expect(p1).not.toBeNull();
    expect(p1?.getAttribute("data-orphan")).toBeNull();
  });

  it("colors edges by mode (data-mode) and labels them with legCode", () => {
    const detail = makeDetail({
      points: [
        { id: "p1", type: "SEAPORT", name: "Nhava Sheva", unLocode: "INNSA" },
        { id: "p2", type: "SEAPORT", name: "Rotterdam", unLocode: "NLRTM" },
      ],
      legs: [
        { id: "l1", legCode: "SEA-1", mode: "SEA", originPointId: "p1", destinationPointId: "p2", assignedCargoIds: [] },
      ],
    });
    const { container, getByText } = render(<RouteDiagram detail={detail} findings={[]} />);
    const edge = container.querySelector('[data-leg-id="l1"]');
    expect(edge?.getAttribute("data-mode")).toBe("SEA");
    expect(getByText("SEA-1")).toBeInTheDocument();
    // Port code is rendered on the node (mono co-signature).
    expect(getByText("INNSA")).toBeInTheDocument();
  });

  it("highlights cargo-scoped findings on every edge carrying that cargo", () => {
    const detail = makeDetail({
      points: [
        { id: "p1", type: "PICKUP", name: "Sender" },
        { id: "p2", type: "WAREHOUSE", name: "Hub" },
        { id: "p3", type: "DELIVERY", name: "Receiver" },
      ],
      cargo: [{ id: "c1", poReference: "PO1" }],
      legs: [
        { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "p1", destinationPointId: "p2", assignedCargoIds: ["c1"] },
        { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "p2", destinationPointId: "p3", assignedCargoIds: ["c1"] },
      ],
    });
    const findings: Finding[] = [
      { rule: "R1", severity: "warning", scope: { type: "cargo", id: "c1" }, message: "cargo chain issue" },
    ];
    const { container } = render(<RouteDiagram detail={detail} findings={findings} />);
    // Both legs carry c1 → both edges get a warning finding marker.
    expect(container.querySelector('[data-leg-id="l1"][data-finding="warning"]')).not.toBeNull();
    expect(container.querySelector('[data-leg-id="l2"][data-finding="warning"]')).not.toBeNull();
  });

  it("renders the truly-empty guidance when there are no points and no legs", () => {
    const detail = makeDetail({ points: [], legs: [] });
    const { getByText } = render(<RouteDiagram detail={detail} findings={[]} />);
    expect(getByText(/add a point or leg to start the route/i)).toBeInTheDocument();
  });

  it("renders point boxes even when there are no legs yet", () => {
    const detailPointsNoLegs = makeDetail({
      points: [
        { id: "p1", type: "PICKUP", name: "Sender" },
        { id: "p2", type: "DELIVERY", name: "Receiver" },
      ],
      legs: [],
    });
    render(<RouteDiagram detail={detailPointsNoLegs} findings={[]} />);
    // both point boxes are drawn (data-point-id present), and the "add a leg" placeholder is NOT the whole surface
    expect(document.querySelectorAll("[data-point-id]").length).toBe(2);
    expect(screen.queryByText(/add the first leg to build the route/i)).not.toBeInTheDocument();
  });

  it("shows the empty placeholder only when there are no points and no legs", () => {
    const detailEmpty = makeDetail({ points: [], legs: [] });
    render(<RouteDiagram detail={detailEmpty} findings={[]} />);
    expect(screen.getByText(/add a point or leg to start the route/i)).toBeInTheDocument();
  });

  it("keeps every node inside the SVG viewBox when a cycle inflates depths (blank-canvas regression)", () => {
    // Repro: a valid Pickup→Warehouse→Airport→Delivery route where L1's origin is
    // later changed to the Airport, forming a 2-cycle Warehouse↔Airport. The depth
    // relaxation runs to its iteration cap and inflates depths; nodes must still be
    // positioned within the drawn viewBox width — otherwise the canvas renders blank
    // and the user can no longer click a box/edge to fix the bad leg.
    const NODE_W = 168; // mirror the layout constant (module-private)
    const detail = makeDetail({
      points: [
        { id: "pk", type: "PICKUP", name: "Pickup" },
        { id: "wh", type: "WAREHOUSE", name: "Warehouse" },
        { id: "ap", type: "AIRPORT", name: "Airport", iataCode: "JFK" },
        { id: "dl", type: "DELIVERY", name: "Delivery" },
      ],
      legs: [
        { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "ap", destinationPointId: "wh", assignedCargoIds: [] },
        { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "wh", destinationPointId: "ap", assignedCargoIds: [] },
        { id: "l3", legCode: "L3", mode: "ROAD", originPointId: "ap", destinationPointId: "dl", assignedCargoIds: [] },
      ],
    });
    const { container } = render(<RouteDiagram detail={detail} findings={[]} />);

    const svg = container.querySelector('svg[role="img"]') as SVGSVGElement;
    expect(svg).not.toBeNull();
    const vbWidth = Number(svg.getAttribute("viewBox")!.split(/\s+/)[2]);

    const nodes = Array.from(container.querySelectorAll("[data-point-id]")) as SVGGElement[];
    expect(nodes.length).toBe(4);
    for (const n of nodes) {
      const m = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(n.getAttribute("transform") ?? "");
      expect(m).not.toBeNull();
      const x = Number(m![1]);
      // The node's full box (x .. x+NODE_W) must fit within the viewBox width.
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + NODE_W).toBeLessThanOrEqual(vbWidth);
    }
  });

  it("fans out parallel legs between the same two points so each stays visible and clickable", () => {
    // Repro: several legs run directly Pickup→Delivery. Without a per-edge offset
    // they render the identical cubic and stack exactly on top of each other — the
    // legs underneath are invisible and can't be clicked to edit. Each must get a
    // distinct path so all three are individually reachable.
    const detail = makeDetail({
      points: [
        { id: "pk", type: "PICKUP", name: "Pickup" },
        { id: "dl", type: "DELIVERY", name: "Delivery" },
      ],
      legs: [
        { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "pk", destinationPointId: "dl", assignedCargoIds: [] },
        { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "pk", destinationPointId: "dl", assignedCargoIds: [] },
        { id: "l3", legCode: "L3", mode: "ROAD", originPointId: "pk", destinationPointId: "dl", assignedCargoIds: [] },
      ],
    });
    const { container } = render(<RouteDiagram detail={detail} findings={[]} />);
    const dOf = (legId: string) =>
      container.querySelector(`[data-leg-id="${legId}"] path`)?.getAttribute("d") ?? null;
    const d1 = dOf("l1");
    const d2 = dOf("l2");
    const d3 = dOf("l3");
    expect(d1).toBeTruthy();
    expect(d2).toBeTruthy();
    expect(d3).toBeTruthy();
    // All three geometries are distinct → fanned apart, none hidden beneath another.
    expect(new Set([d1, d2, d3]).size).toBe(3);
  });

  it("fans out anti-parallel legs (A→B and B→A) so a 2-cycle's edges don't overlap", () => {
    // A→B and B→A share the same unordered point pair; they must also separate,
    // otherwise a cycle draws one edge on top of the other.
    const detail = makeDetail({
      points: [
        { id: "a", type: "WAREHOUSE", name: "A" },
        { id: "b", type: "AIRPORT", name: "B", iataCode: "BBB" },
      ],
      legs: [
        { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "a", destinationPointId: "b", assignedCargoIds: [] },
        { id: "l2", legCode: "L2", mode: "ROAD", originPointId: "b", destinationPointId: "a", assignedCargoIds: [] },
      ],
    });
    const { container } = render(<RouteDiagram detail={detail} findings={[]} />);
    const d1 = container.querySelector('[data-leg-id="l1"] path')?.getAttribute("d");
    const d2 = container.querySelector('[data-leg-id="l2"] path')?.getAttribute("d");
    expect(d1).toBeTruthy();
    expect(d2).toBeTruthy();
    expect(d1).not.toEqual(d2);
  });

  // ── Task 2: onEditPoint / onEditLeg ─────────────────────────────────────────

  const detailWithRoute = makeDetail({
    points: [
      {
        id: "p1",
        type: "PICKUP",
        name: "Sender Warehouse",
        city: "London",
        country: "GB",
        streetAddress: "123 Main St",
        postalCode: "EC1A 1BB",
      },
      { id: "p2", type: "DELIVERY", name: "Receiver" },
    ],
    legs: [
      {
        id: "l1",
        legCode: "L1",
        mode: "ROAD",
        originPointId: "p1",
        destinationPointId: "p2",
        assignedCargoIds: [],
        rollup: { totalPackages: 2, totalCbm: 1.2345, totalGrossWt: 100.5, totalNetWt: 0 },
      },
    ],
  });

  it("clicking a point box calls onEditPoint with the point id", async () => {
    const onEditPoint = vi.fn();
    render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={onEditPoint} onEditLeg={() => {}} />);
    const node = document.querySelector('[data-point-id]') as SVGGElement;
    await userEvent.click(node);
    expect(onEditPoint).toHaveBeenCalledWith(node.getAttribute("data-point-id"));
  });

  it("clicking a leg line calls onEditLeg with the leg id", async () => {
    const onEditLeg = vi.fn();
    render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={() => {}} onEditLeg={onEditLeg} />);
    const edge = document.querySelector('[data-leg-id]') as SVGGElement;
    await userEvent.click(edge);
    expect(onEditLeg).toHaveBeenCalledWith(edge.getAttribute("data-leg-id"));
  });

  // ── Task 3: hover tooltip ────────────────────────────────────────────────────

  it("hovering a point box shows its full address in a tooltip", async () => {
    render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={() => {}} onEditLeg={() => {}} />);
    const node = document.querySelector('[data-point-id="p1"]') as SVGGElement;
    fireEvent.mouseEnter(node);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(/123 Main St/i);
    expect(tip).toHaveTextContent(/London/i);
    expect(tip).toHaveTextContent(/Pickup/i);
  });

  it("hovering a leg line shows its rollup pkg / CBM / kg", async () => {
    render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={() => {}} onEditLeg={() => {}} />);
    const edge = document.querySelector('[data-leg-id="l1"]') as SVGGElement;
    fireEvent.mouseEnter(edge);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(/pkg/i);
    expect(tip).toHaveTextContent(/CBM/i);
    expect(tip).toHaveTextContent(/kg/i);
    // Value-level: rollup numbers are formatted correctly (catches toFixed regressions).
    expect(tip).toHaveTextContent("2 pkg");
    expect(tip).toHaveTextContent("1.2345 CBM");
  });

  it("tooltip shows red finding messages for a point with blocking findings", async () => {
    const blockingFindings: Finding[] = [
      { rule: "R1", severity: "blocking", scope: { type: "point", id: "p1" }, message: "Missing contact email" },
    ];
    render(<RouteDiagram detail={detailWithRoute} findings={blockingFindings} onEditPoint={() => {}} onEditLeg={() => {}} />);
    const node = document.querySelector('[data-point-id="p1"]') as SVGGElement;
    fireEvent.mouseEnter(node);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(/Missing contact email/i);
  });

  it("tooltip disappears when mouse leaves the node", async () => {
    render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={() => {}} onEditLeg={() => {}} />);
    const node = document.querySelector('[data-point-id="p1"]') as SVGGElement;
    fireEvent.mouseEnter(node);
    await screen.findByRole("tooltip");
    fireEvent.mouseLeave(node);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("tooltip is pointer-events-none so it never blocks underlying click", async () => {
    render(<RouteDiagram detail={detailWithRoute} findings={[]} onEditPoint={() => {}} onEditLeg={() => {}} />);
    const node = document.querySelector('[data-point-id="p1"]') as SVGGElement;
    fireEvent.mouseEnter(node);
    const tip = await screen.findByRole("tooltip");
    expect(tip.className).toMatch(/pointer-events-none/);
  });
});
