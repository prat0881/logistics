import { describe, it, expect } from "vitest";
import { validateRoute, type QueryDetail } from "@svyft/shared";
import { toRouteGraph } from "./routeGraph";

const QUERY_ID = "q-1";

/** Minimal valid QueryDetail; override points/legs/cargos/query fields per test. */
function makeDetail(over: {
  id?: string;
  readyDate?: string | null;
  targetDelivery?: string | null;
  points?: Array<Partial<QueryDetail["points"][number]> & { id: string; type: string }>;
  cargos?: Array<
    Partial<Omit<QueryDetail["cargos"][number], "packages">> & {
      id: string;
      packages?: Array<Partial<QueryDetail["cargos"][number]["packages"][number]> & { id: string }>;
    }
  >;
  legs?: Array<
    Partial<QueryDetail["legs"][number]> & {
      id: string;
      legCode: string;
      assignedPackageIds: string[];
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
  const cargos = (over.cargos ?? []).map((c, i) => {
    const { packages: rawPackages, ...cargoOverride } = c;
    const packages = (rawPackages ?? []).map((p, j) => ({
      rowIndex: j,
      packageNo: `PKG-${j + 1}`,
      packageType: "CARTON",
      dimL: "10",
      dimW: "10",
      dimH: "10",
      netWt: null,
      grossWt: "10",
      volumeCbm: "1",
      tags: [],
      effectiveTags: [],
      msdsFileId: null,
      items: [],
      ...p,
    }));
    return {
      rowIndex: i,
      poReference: "PO",
      label: null,
      dimUnit: "CM",
      weightUnit: "KG",
      packageCount: packages.length,
      grossWeightKg: "0",
      volumeCbm: "0",
      tags: [],
      chargeableWeight: null,
      ...cargoOverride,
      packages,
    };
  }) as QueryDetail["cargos"];
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
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00",
    rollup: { totalPackages: 0, totalCbm: 0, totalGrossWt: 0, totalNetWt: 0 },
    warehouseHandlingIncluded: null,
    chargeLineDefinitionIds: [],
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
    readyDateTimezone: null,
    targetDelivery: over.targetDelivery ?? null,
    targetDeliveryTimezone: null,
    internalNotes: null,
    status: "DRAFT",
    rfqReadyAt: null,
    assignedUserId: null,
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00",
    cargos,
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
  it("assembles a RouteGraph with legCargo edges from assignedPackageIds", () => {
    const detail = makeDetail({
      points: [
        { id: "p1", type: "PICKUP" },
        { id: "p2", type: "DELIVERY" },
      ],
      cargos: [
        {
          id: "c1",
          poReference: "PO1",
          packages: [
            {
              id: "pkg1",
              msdsFileId: null,
              grossWt: "10",
              volumeCbm: "1",
            },
          ],
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
          assignedPackageIds: ["pkg1"],
        },
      ],
    });
    const g = toRouteGraph(detail);
    expect(g.legCargo).toEqual([{ legId: "l1", cargoItemId: "pkg1" }]);
    expect(g.legs[0]).toMatchObject({
      legCode: "L1",
      originPointId: "p1",
      destinationPointId: "p2",
    });
  });

  it("maps query, point endpoint fields, and package Decimal strings through as-is", () => {
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
      cargos: [
        {
          id: "c1",
          poReference: "PO9",
          packages: [{ id: "pkgA", grossWt: "180.5", volumeCbm: "12.25" }],
        },
      ],
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
    // Decimal strings pass through untouched (engine coerces). RouteCargo.id is the
    // PACKAGE id (one routable unit per Package); poReference comes from the parent Cargo.
    expect(g.cargo[0]).toMatchObject({
      id: "pkgA",
      poReference: "PO9",
      grossWt: "180.5",
      volumeCbm: "12.25",
      isDangerous: false,
    });
  });

  it("flattens multiple assignedPackageIds on a leg into legCargo edges", () => {
    const detail = makeDetail({
      points: [
        { id: "p1", type: "PICKUP" },
        { id: "p2", type: "DELIVERY" },
      ],
      cargos: [
        { id: "c1", poReference: "PO1", packages: [{ id: "pkg1" }] },
        { id: "c2", poReference: "PO2", packages: [{ id: "pkg2" }] },
      ],
      legs: [
        {
          id: "l1",
          legCode: "L1",
          mode: "ROAD",
          originPointId: "p1",
          destinationPointId: "p2",
          assignedPackageIds: ["pkg1", "pkg2"],
        },
      ],
    });
    const g = toRouteGraph(detail);
    expect(g.legCargo).toEqual([
      { legId: "l1", cargoItemId: "pkg1" },
      { legId: "l1", cargoItemId: "pkg2" },
    ]);
  });

  it("validateRoute flags R2 when a cargo chain STARTS at a Delivery point in create phase", () => {
    // p1 DELIVERY → p2 WAREHOUSE, single leg carrying pkg1. A chain may start at any point
    // type EXCEPT a delivery (a delivery is where cargo arrives) → R2 blocking at create.
    // (Ending at a warehouse is allowed now, so the start-type is what R2 checks here.)
    const brokenDetail = makeDetail({
      readyDate: null,
      targetDelivery: null,
      points: [
        { id: "p1", type: "DELIVERY" },
        { id: "p2", type: "WAREHOUSE" },
      ],
      cargos: [{ id: "c1", poReference: "PO1", packages: [{ id: "pkg1" }] }],
      legs: [
        {
          id: "l1",
          legCode: "L1",
          mode: "ROAD",
          originPointId: "p1",
          destinationPointId: "p2",
          assignedPackageIds: ["pkg1"],
        },
      ],
    });
    const findings = validateRoute(toRouteGraph(brokenDetail), "create");
    expect(findings.some((f) => f.rule === "R2")).toBe(true);
  });
});
