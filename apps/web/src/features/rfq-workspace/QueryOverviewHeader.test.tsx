import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { QueryDetail, CargoDto } from "@svyft/shared";
import { QueryOverviewHeader } from "./QueryOverviewHeader";

const makeCargo = (over: Partial<CargoDto>): CargoDto => ({
  id: "c1",
  rowIndex: 0,
  poReference: "PO",
  productName: "Product",
  referenceTags: [],
  isDangerous: false,
  hsCode: null,
  msdsFileId: null,
  packageType: "BOX",
  qty: 1,
  dimL: "100",
  dimW: "100",
  dimH: "100",
  netWt: null,
  grossWt: "500",
  volumeCbm: null,
  dimUnit: "CM",
  weightUnit: "KG",
  ...over,
});

const query = {
  queryCode: "YAL26-0001",
  incoterms: "FOB",
  status: "RFQ_SENT",
  freightMode: ["AIR", "ROAD"],
  origin: [{ id: "p1", name: "Shanghai Port", city: "Shanghai", country: "CN" }],
  destination: [{ id: "p2", name: null, city: "Dubai", country: "AE" }],
  legs: [
    { rollup: { totalPackages: 3, totalCbm: 12, totalGrossWt: 500, totalNetWt: 400 } },
    { rollup: { totalPackages: 2, totalCbm: 8, totalGrossWt: 300, totalNetWt: 250 } },
  ],
  cargo: [],
} as unknown as QueryDetail;

describe("QueryOverviewHeader", () => {
  it("shows the query code, totals and status; omits modes/origin/destination", () => {
    render(<QueryOverviewHeader query={query} />);
    expect(screen.getByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
    expect(screen.getByText(/5 pkg/i)).toBeInTheDocument();
    expect(screen.getByText(/20 CBM/i)).toBeInTheDocument();
    expect(screen.getByText(/800 kg/i)).toBeInTheDocument();
    // Modes / Origin / Destination now live in the route diagram, not the header
    expect(screen.queryByText("AIR")).toBeNull();
    expect(screen.queryByText(/Shanghai Port/)).toBeNull();
    expect(screen.queryByText(/Dubai/)).toBeNull();
    expect(screen.queryByText("Origin")).toBeNull();
    expect(screen.queryByText("Destination")).toBeNull();
  });

  it("renders the Dangerous goods icon when a cargo row has isDangerous=true", () => {
    const queryWithDg = {
      ...query,
      cargo: [makeCargo({ isDangerous: true })],
    } as unknown as QueryDetail;
    render(<QueryOverviewHeader query={queryWithDg} />);
    expect(screen.getByLabelText(/dangerous goods/i)).toBeInTheDocument();
  });

  it("renders reference-tag icons under their own 'Reference Tags' field, not under Totals", () => {
    const queryWithTag = { ...query, cargo: [makeCargo({ referenceTags: ["OUT_OF_GAUGE"] })] } as unknown as QueryDetail;
    render(<QueryOverviewHeader query={queryWithTag} />);
    const label = screen.getByText("Reference Tags");
    const field = label.closest("div")!;
    expect(within(field).getByLabelText(/out of gauge/i)).toBeInTheDocument();
    const totals = screen.getByText("Totals").closest("div")!;
    expect(within(totals).queryByLabelText(/out of gauge/i)).toBeNull();
  });
});
