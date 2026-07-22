import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Finding, QueryDetail } from "@svyft/shared";
import { RouteDiagram } from "./RouteDiagram";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Build a QueryDetail with the given points / legs; cargo defaults to empty. */
function makeDetail(over: {
  points?: Array<{ id: string; type: string; name?: string | null; city?: string | null; country?: string | null; unLocode?: string | null; iataCode?: string | null }>;
  legs?: Array<{ id: string; legCode: string; mode?: string | null; originPointId?: string | null; destinationPointId?: string | null; assignedCargoIds?: string[] }>;
  cargo?: Array<{ id: string; poReference?: string }>;
} = {}): QueryDetail {
  const points = (over.points ?? []).map((p) => ({
    tenantId: null,
    queryId: "q1",
    name: p.name ?? null,
    streetAddress: null,
    city: p.city ?? null,
    postalCode: null,
    country: p.country ?? null,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
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
    freightDensity: null,
    chargeableWeight: null,
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
    totalChargeableWeight: null,
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
    targetDelivery: null,
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

  it("fires onSelect with the leg scope when an edge is clicked", async () => {
    const detail = makeDetail({
      points: [
        { id: "p1", type: "PICKUP", name: "Sender" },
        { id: "p2", type: "DELIVERY", name: "Receiver" },
      ],
      legs: [
        { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "p1", destinationPointId: "p2", assignedCargoIds: [] },
      ],
    });
    const onSelect = vi.fn();
    const { container } = render(<RouteDiagram detail={detail} findings={[]} onSelect={onSelect} />);
    const edge = container.querySelector('[data-leg-id="l1"]');
    expect(edge).not.toBeNull();
    await userEvent.click(edge as Element);
    expect(onSelect).toHaveBeenCalledWith({ type: "leg", id: "l1" });
  });

  it("marks the active leg (selectedLegId) with data-active for the marigold treatment", () => {
    const detail = makeDetail({
      points: [
        { id: "p1", type: "PICKUP", name: "Sender" },
        { id: "p2", type: "DELIVERY", name: "Receiver" },
      ],
      legs: [
        { id: "l1", legCode: "L1", mode: "ROAD", originPointId: "p1", destinationPointId: "p2", assignedCargoIds: [] },
      ],
    });
    const { container } = render(
      <RouteDiagram detail={detail} findings={[]} selectedLegId="l1" />,
    );
    const edge = container.querySelector('[data-leg-id="l1"][data-active="true"]');
    expect(edge).not.toBeNull();
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
});
