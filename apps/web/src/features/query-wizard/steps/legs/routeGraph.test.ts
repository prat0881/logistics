import { describe, it, expect } from "vitest";
import { validateRoute, type QueryDetail } from "@svyft/shared";
import { toRouteGraph } from "./routeGraph";

const QUERY_ID = "q-1";

/** Minimal valid QueryDetail; override points/legs/cargo/query fields per test. */
function makeDetail(over: {
  id?: string;
  readyDate?: string | null;
  targetDelivery?: string | null;
  points?: Array<Partial<QueryDetail["points"][number]> & { id: string; type: string }>;
  cargo?: Array<Partial<QueryDetail["cargo"][number]> & { id: string }>;
  legs?: Array<
    Partial<QueryDetail["legs"][number]> & {
      id: string;
      legCode: string;
      assignedCargoIds: string[];
    }
  >;
} = {}): QueryDetail {
  const id = over.id ?? QUERY_ID;
  const points = (over.points ?? []).map((p) => ({
    tenantId: null,
    queryId: id,
    name: null,
    streetAddress: null,
    city: null,
    postalCode: null,
    country: null,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    warehouseType: null,
    iataCode: null,
    icaoCode: null,
    unLocode: null,
    terminal: null,
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00",
    ...p,
  })) as QueryDetail["points"];
  const cargo = (over.cargo ?? []).map((c, i) => ({
    rowIndex: i,
    poReference: "PO",
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
    ...c,
  })) as QueryDetail["cargo"];
  const legs = (over.legs ?? []).map((l) => ({
    tenantId: null,
    queryId: id,
    legName: null,
    originPointId: null,
    destinationPointId: null,
    mode: null,
    readyDate: null,
    targetDelivery: null,
    status: "DRAFT",
    executionStatus: "PENDING",
    totalChargeableWeight: null,
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00",
    rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
    ...l,
  })) as QueryDetail["legs"];
  return {
    id,
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
    readyDate: over.readyDate ?? null,
    targetDelivery: over.targetDelivery ?? null,
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

describe("toRouteGraph", () => {
  it("assembles a RouteGraph with legCargo edges from assignedCargoIds", () => {
    const detail = makeDetail({
      points: [
        { id: "p1", type: "PICKUP" },
        { id: "p2", type: "DELIVERY" },
      ],
      cargo: [
        {
          id: "c1",
          poReference: "PO1",
          isDangerous: false,
          msdsFileId: null,
          grossWt: "10",
          volumeCbm: "1",
        },
      ],
      legs: [
        {
          id: "l1",
          legCode: "L1",
          mode: "ROAD",
          originPointId: "p1",
          destinationPointId: "p2",
          readyDate: null,
          targetDelivery: null,
          assignedCargoIds: ["c1"],
        },
      ],
    });
    const g = toRouteGraph(detail);
    expect(g.legCargo).toEqual([{ legId: "l1", cargoItemId: "c1" }]);
    expect(g.legs[0]).toMatchObject({
      legCode: "L1",
      originPointId: "p1",
      destinationPointId: "p2",
    });
  });

  it("maps query, point endpoint fields, and cargo Decimal strings through as-is", () => {
    const detail = makeDetail({
      readyDate: "2026-02-01T00:00:00+00:00",
      targetDelivery: "2026-03-01T00:00:00+00:00",
      points: [
        {
          id: "p1",
          type: "SEAPORT",
          name: "Nhava Sheva",
          city: "Mumbai",
          country: "IN",
          unLocode: "INNSA",
          terminal: "JNPT",
          iataCode: null,
          icaoCode: null,
        },
      ],
      cargo: [{ id: "c1", poReference: "PO9", grossWt: "180.5", volumeCbm: "12.25" }],
      legs: [],
    });
    const g = toRouteGraph(detail);
    expect(g.query).toEqual({
      id: "q-1",
      readyDate: "2026-02-01T00:00:00+00:00",
      targetDelivery: "2026-03-01T00:00:00+00:00",
    });
    expect(g.points[0]).toMatchObject({
      id: "p1",
      type: "SEAPORT",
      name: "Nhava Sheva",
      city: "Mumbai",
      country: "IN",
      unLocode: "INNSA",
      terminal: "JNPT",
    });
    // Decimal strings pass through untouched (engine coerces).
    expect(g.cargo[0]).toMatchObject({
      id: "c1",
      poReference: "PO9",
      grossWt: "180.5",
      volumeCbm: "12.25",
      isDangerous: false,
    });
  });

  it("flattens multiple assignedCargoIds across legs into legCargo edges", () => {
    const detail = makeDetail({
      points: [
        { id: "p1", type: "PICKUP" },
        { id: "p2", type: "DELIVERY" },
      ],
      cargo: [
        { id: "c1", poReference: "PO1" },
        { id: "c2", poReference: "PO2" },
      ],
      legs: [
        {
          id: "l1",
          legCode: "L1",
          mode: "ROAD",
          originPointId: "p1",
          destinationPointId: "p2",
          assignedCargoIds: ["c1", "c2"],
        },
      ],
    });
    const g = toRouteGraph(detail);
    expect(g.legCargo).toEqual([
      { legId: "l1", cargoItemId: "c1" },
      { legId: "l1", cargoItemId: "c2" },
    ]);
  });

  it("validateRoute flags a broken chain (R2) on a chain that ends at a WAREHOUSE in create phase", () => {
    // p1 PICKUP → p2 WAREHOUSE, single leg carrying c1. The chain ends at a
    // warehouse, not a delivery → R2 blocking at create.
    const brokenDetail = makeDetail({
      readyDate: null,
      targetDelivery: null,
      points: [
        { id: "p1", type: "PICKUP" },
        { id: "p2", type: "WAREHOUSE" },
      ],
      cargo: [{ id: "c1", poReference: "PO1" }],
      legs: [
        {
          id: "l1",
          legCode: "L1",
          mode: "ROAD",
          originPointId: "p1",
          destinationPointId: "p2",
          assignedCargoIds: ["c1"],
        },
      ],
    });
    const findings = validateRoute(toRouteGraph(brokenDetail), "create");
    expect(findings.some((f) => f.rule === "R2")).toBe(true);
  });
});
