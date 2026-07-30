import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("shows the query code, modes, rolled-up totals and status", () => {
    render(<QueryOverviewHeader query={query} />);
    expect(screen.getByText("YAL26-0001")).toBeInTheDocument();
    expect(screen.getByText("AIR")).toBeInTheDocument();
    expect(screen.getByText("RFQ Sent")).toBeInTheDocument();
    expect(screen.getByText(/5 pkg/i)).toBeInTheDocument();   // 3 + 2 packages
    expect(screen.getByText(/20 CBM/i)).toBeInTheDocument();  // 12 + 8 CBM
    expect(screen.getByText(/800 kg/i)).toBeInTheDocument();  // 500 + 300 kg
    expect(screen.getByText(/Shanghai Port/)).toBeInTheDocument();
    expect(screen.getByText(/Dubai/)).toBeInTheDocument();
  });

  it("renders the Dangerous goods icon when a cargo row has isDangerous=true", () => {
    const queryWithDg = {
      ...query,
      cargo: [makeCargo({ isDangerous: true })],
    } as unknown as QueryDetail;
    render(<QueryOverviewHeader query={queryWithDg} />);
    expect(screen.getByLabelText(/dangerous goods/i)).toBeInTheDocument();
  });
});
